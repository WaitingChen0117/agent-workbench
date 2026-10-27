import { randomUUID } from "node:crypto";

import type { ToolSet } from "ai";

import {
  AgentLoopLimitError,
  streamAgent,
  MAX_AGENT_STEPS,
  type AgentMessage,
  type AgentLoopEvent,
  type AgentResult,
} from "@/lib/agent/loop";
import * as eventBus from "@/lib/agent/task/event-bus";
import { getTaskStore } from "@/lib/agent/task/task-store";
import { resolveTools } from "@/lib/agent/tool-resolver";
import { loadSkillInstructions } from "@/lib/agent/skills";
import { getToolPermission } from "@/lib/agent/permission";
import { preApprovalGuard } from "@/lib/agent/guard";
import { createApproval, resolveApprovalState } from "@/lib/agent/approvals";
import {
  getApprovalStore,
  type AgentApproval,
} from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import {
  sanitizeMessageContent,
  sanitizePendingInput,
  type SessionStatus,
} from "@/lib/agent/session/types";
import { startTrace, resumeTrace } from "@/lib/agent/trace/collector";
import {
  sanitizeToolInput,
  sanitizeToolOutput,
} from "@/lib/agent/trace/sanitize";
import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskEventType,
} from "@/lib/agent/task/types";

/**
 * Task Runtime（第四阶段：Streaming）
 *
 * 分层：Task Runtime → Agent Loop(streamAgent) → LLM → Tool Registry → Tools
 *
 * Runtime 负责：创建 Task、驱动状态转换、记录 Task Event、把事件发布到
 * Event Bus、调用流式 Agent Loop、捕获异常落到 completed / failed。
 *
 * - createAndStartTask：异步模式，立即返回 Task，后台执行（SSE 场景）。
 * - createAndRunTask：同步模式，await 到结束（兼容旧 /api/agent 与测试）。
 */

export interface RunTaskInput {
  messages: AgentMessage[];
  maxSteps?: number;
}

export interface RunTaskResult {
  task: AgentTask;
  events: AgentTaskEvent[];
}

// Runtime 只依赖 TaskStore 抽象，不直接操作 globalThis / Map
const taskStore = getTaskStore();
const sessionStore = getSessionStore();

// ---------------------------------------------------------------------------
// Agent Loop Runner seam（Phase 10.4）
//
// 生产默认 = streamAgent（真实 LLM）。通过依赖注入可替换为 deterministic stub
// （仅用于 Evaluation，不改变生产语义）。executeTask 与 resume 共用同一个 runner，
// 保证「恢复」走的就是「重新进入同一个 Agent Loop」，而不是另写一套。
// ---------------------------------------------------------------------------
export interface AgentLoopRunnerArgs {
  taskId: string;
  sessionId: string | null;
  messages: AgentMessage[];
  maxSteps: number;
  tools: ToolSet;
  instructions?: string;
  onEvent: (event: AgentLoopEvent) => void;
  abortSignal: AbortSignal;
}

export type AgentLoopRunner = (args: AgentLoopRunnerArgs) => Promise<AgentResult>;

const defaultAgentLoopRunner: AgentLoopRunner = (args) =>
  streamAgent({
    messages: args.messages,
    maxSteps: args.maxSteps,
    tools: args.tools,
    instructions: args.instructions,
    abortSignal: args.abortSignal,
    onEvent: args.onEvent,
  });

const runnerRef = globalThis as typeof globalThis & {
  __agentLoopRunner?: AgentLoopRunner;
};

export function setAgentLoopRunner(runner: AgentLoopRunner | null): void {
  if (runner) runnerRef.__agentLoopRunner = runner;
  else delete runnerRef.__agentLoopRunner;
}

export function getAgentLoopRunner(): AgentLoopRunner {
  return runnerRef.__agentLoopRunner ?? defaultAgentLoopRunner;
}

// task 状态 → session 状态；session 不存在则 no-op（如 Workflow 任务）
function toSessionStatus(status: string): SessionStatus | null {
  switch (status) {
    case "running":
      return "active";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

async function syncSessionStatus(taskId: string, taskStatus: string): Promise<void> {
  const next = toSessionStatus(taskStatus);
  if (!next) return;
  const session = await sessionStore.getByTaskId(taskId);
  if (session && session.status !== next) {
    await sessionStore.update(session.sessionId, { status: next });
  }
}

// 统一事件出口：落 Store（可选）并发布到 Event Bus
export function emit(
  taskId: string,
  type: AgentTaskEventType,
  data?: unknown,
  options?: { persist?: boolean },
): void {
  const event: AgentTaskEvent = {
    id: randomUUID(),
    taskId,
    type,
    timestamp: new Date().toISOString(),
    data,
  };

  // message.delta 量大，只做实时推送、不落 Store，避免内存膨胀与无意义重放。
  // 内存 Store 的 append 同步完成，这里 fire-and-forget 不影响顺序。
  if (options?.persist !== false) {
    void taskStore.appendEvent(taskId, event);
  }

  eventBus.publish(event);
}

// 把 Agent Loop 的细粒度事件映射成 Task Event，并同步 currentStep
export function makeLoopEventHandler(taskId: string) {
  return (event: AgentLoopEvent): void => {
    switch (event.type) {
      case "agent.step.started":
        void taskStore.update(taskId, { currentStep: event.step });
        emit(taskId, "agent.step.started", { step: event.step });
        break;
      case "llm.requested":
        emit(taskId, "llm.requested", { step: event.step });
        break;
      case "tool.started":
        emit(taskId, "tool.started", {
          step: event.step,
          tool: event.tool,
          input: sanitizeToolInput(event.tool, event.input),
        });
        break;
      case "tool.completed":
        emit(taskId, "tool.completed", {
          step: event.step,
          tool: event.tool,
          success: event.success,
          result: sanitizeToolOutput(event.tool, event.output),
        });
        break;
      case "agent.step.completed":
        emit(taskId, "agent.step.completed", {
          step: event.step,
          toolCalls: event.toolCalls,
        });
        break;
      case "message.started":
        emit(taskId, "message.started", { step: event.step });
        break;
      case "message.delta":
        // token 级增量：只实时推送，不落 Store
        emit(
          taskId,
          "message.delta",
          { step: event.step, content: event.content },
          { persist: false },
        );
        break;
      case "message.completed":
        emit(taskId, "message.completed", { step: event.step });
        break;
    }
  };
}

// 审批事件对外只暴露必要信息，不泄露完整敏感内容（如文件全文）
function summarizeInput(toolName: string, input: unknown): unknown {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (toolName === "writeFile") {
    return {
      path: obj.path,
      contentLength:
        typeof obj.content === "string" ? obj.content.length : undefined,
    };
  }

  if (toolName === "runCommand") {
    return { program: obj.program, args: obj.args, cwd: obj.cwd };
  }

  if (toolName === "gitAdd") {
    return { paths: obj.paths };
  }

  if (toolName === "gitCommit") {
    return { message: obj.message };
  }

  if (toolName === "gitPush") {
    return { remote: obj.remote ?? "origin", branch: obj.branch };
  }

  return input;
}

const WORKSPACE_ROOT = process.cwd();

export interface PermissionContext {
  taskId: string;
  abortController: AbortController;
}

/**
 * 给需要审批的工具包一层 Permission Gate：
 * 执行前进入 waiting + approval.required，等待 approve/reject。
 */
export function wrapToolsWithPermissions(
  baseTools: ToolSet,
  ctx: PermissionContext,
): ToolSet {
  const wrapped: ToolSet = {};

  for (const [name, toolDef] of Object.entries(baseTools)) {
    const originalExecute = toolDef.execute;

    if (getToolPermission(name) !== "approval_required" || !originalExecute) {
      wrapped[name] = toolDef;
      continue;
    }

    const gatedExecute = async (
      input: unknown,
      options: Parameters<NonNullable<typeof originalExecute>>[1],
    ): Promise<unknown> => {
      // 安全前置校验：敏感文件 / 路径穿越 / 非法 message 必须在审批之前就被拒
      // （Permission Approval ≠ Security Bypass）
      const guard = await preApprovalGuard(name, input, WORKSPACE_ROOT);
      if (!guard.ok) {
        return { success: false, error: `DENIED: ${guard.error}` };
      }

      const { approval, decision } = await createApproval(ctx.taskId, name, input);

      if ((await taskStore.get(ctx.taskId))?.status === "running") {
        await taskStore.transition(ctx.taskId, "waiting");
      }
      // 记录「正在等待审批的 tool call」到 Session（脱敏入参），供跨进程 resume 使用。
      // 真正 resume 执行所需的原始 input 从 ApprovalStore 读取，不在 Session 存文件全文。
      const session = await sessionStore.getByTaskId(ctx.taskId);
      if (session) {
        const toolCallId =
          (options as { toolCallId?: string } | undefined)?.toolCallId ??
          `call-${approval.id}`;
        await sessionStore.createPendingAction({
          sessionId: session.sessionId,
          taskId: ctx.taskId,
          toolCallId,
          toolName: name,
          input: sanitizePendingInput(name, input),
          approvalId: approval.id,
        });
        await sessionStore.update(session.sessionId, { status: "waiting" });
      }
      emit(ctx.taskId, "approval.required", {
        approvalId: approval.id,
        toolName: name,
        reason: `Tool "${name}" requires approval before execution`,
        input: summarizeInput(name, input),
      });

      // approval.approved / approval.rejected 由 applyApprovalDecision 统一发布
      const status = await decision;

      if (status === "approved") {
        if ((await taskStore.get(ctx.taskId))?.status === "waiting") {
          await taskStore.transition(ctx.taskId, "running");
          await syncSessionStatus(ctx.taskId, "running");
        }
        await sessionStore.updatePendingAction(approval.id, "completed");
        return originalExecute(input, options);
      }

      // rejected：取消任务并中止 Agent Loop
      if ((await taskStore.get(ctx.taskId))?.status === "waiting") {
        await taskStore.transition(ctx.taskId, "cancelled");
        await syncSessionStatus(ctx.taskId, "cancelled");
        emit(ctx.taskId, "task.cancelled", { reason: "approval rejected" });
      }
      ctx.abortController.abort();
      return { success: false, error: "Operation rejected by user" };
    };

    wrapped[name] = {
      ...toolDef,
      execute: gatedExecute,
    } as typeof toolDef;
  }

  return wrapped;
}

// 构建已 gate 的工具集 + Skill 指令，调用可注入的 Agent Loop runner，并统一收尾。
// 首次执行与 resume 后的「重新进入 Agent Loop」都走这里，不复制第二套 Loop。
async function runAgentLoopForTask(
  taskId: string,
  sessionId: string | null,
  messages: AgentMessage[],
  maxSteps: number,
): Promise<void> {
  const abortController = new AbortController();
  try {
    const [baseTools, instructions] = await Promise.all([
      resolveTools(),
      loadSkillInstructions(),
    ]);

    const tools = wrapToolsWithPermissions(baseTools, {
      taskId,
      abortController,
    });

    const result = await getAgentLoopRunner()({
      taskId,
      sessionId,
      messages,
      maxSteps,
      tools,
      instructions,
      abortSignal: abortController.signal,
      onEvent: makeLoopEventHandler(taskId),
    });

    // 仅当仍在 running 时收尾为 completed（可能已被 reject 置为 cancelled，
    // 或因下一个 approval 进入 waiting —— 那种情况 runner 不会正常返回）。
    if ((await taskStore.get(taskId))?.status === "running") {
      await taskStore.update(taskId, {
        answer: result.answer,
        currentStep: result.steps,
      });
      if (sessionId && result.answer) {
        await sessionStore.appendMessage(sessionId, {
          role: "assistant",
          content: sanitizeMessageContent(result.answer),
        });
      }
      await taskStore.transition(taskId, "completed");
      await syncSessionStatus(taskId, "completed");
      emit(taskId, "task.completed", { steps: result.steps });
    }
  } catch (error) {
    if ((await taskStore.get(taskId))?.status !== "running") {
      return;
    }
    const code =
      error instanceof AgentLoopLimitError ? "AGENT_LOOP_LIMIT" : "AGENT_ERROR";
    const message =
      error instanceof Error ? error.message : "Agent execution failed";
    await taskStore.update(taskId, { error: { code, message } });
    await taskStore.transition(taskId, "failed");
    await syncSessionStatus(taskId, "failed");
    emit(taskId, "task.failed", { code, message });
  }
}

// 执行一个已创建的 Task：pending → running →（可选 waiting）→ completed / failed / cancelled
async function executeTask(taskId: string): Promise<void> {
  const task = await taskStore.get(taskId);

  if (!task) {
    return;
  }

  await taskStore.transition(taskId, "running");
  await syncSessionStatus(taskId, "running");
  emit(taskId, "task.started");

  const session = await sessionStore.getByTaskId(taskId);
  await runAgentLoopForTask(
    taskId,
    session?.sessionId ?? null,
    task.messages,
    task.maxSteps,
  );
}

// Task 1:1 Session —— 创建 Task 的同时创建 Session 并落初始 user 消息（脱敏）。
async function createTaskWithSession(
  messages: AgentMessage[],
  maxSteps: number,
): Promise<AgentTask> {
  const task = await taskStore.create({ messages, maxSteps });
  const session = await sessionStore.create({ taskId: task.id });
  for (const message of messages) {
    await sessionStore.appendMessage(session.sessionId, {
      role: message.role,
      content: sanitizeMessageContent(message.content),
    });
  }
  return task;
}

/**
 * 异步模式：创建并立即返回 Task，Agent 在后台执行。
 * 调用方拿到 taskId 后即可连接 SSE 订阅事件。
 */
export async function createAndStartTask({
  messages,
  maxSteps = MAX_AGENT_STEPS,
}: RunTaskInput): Promise<AgentTask> {
  const task = await createTaskWithSession(messages, maxSteps);
  startTrace(task.id); // 先订阅，保证捕获 task.created 之后的完整生命周期
  emit(task.id, "task.created");

  // 后台执行，不阻塞 HTTP 响应。
  void executeTask(task.id);

  return task;
}

/**
 * 同步模式：await 到任务结束，返回最终 Task 与已记录事件。
 * 兼容第三阶段的 /api/agent 与脚本测试。
 */
export async function createAndRunTask({
  messages,
  maxSteps = MAX_AGENT_STEPS,
}: RunTaskInput): Promise<RunTaskResult> {
  const task = await createTaskWithSession(messages, maxSteps);
  startTrace(task.id);
  emit(task.id, "task.created");

  await executeTask(task.id);

  return {
    task: (await taskStore.get(task.id)) as AgentTask,
    events: await taskStore.getEvents(task.id),
  };
}

// ===========================================================================
// Approval 决策 + 真正的 Task Resume（Phase 10.3）
// ===========================================================================

export interface ApprovalDecisionResult {
  ok: boolean;
  status?: string;
  reason?: string;
}

/**
 * 统一的审批决策入口（API / 脚本都走这里）：
 * 原子持久化 pending→approved/rejected → 发布事件 → 同进程唤醒 waiter；
 * 若无 waiter（进程已重启）→ 走持久化 resume / cancel。幂等、不重复副作用。
 */
export async function applyApprovalDecision(
  taskId: string,
  approvalId: string,
  action: "approve" | "reject",
): Promise<ApprovalDecisionResult> {
  const approvalStore = getApprovalStore();
  const existing = await approvalStore.get(approvalId);
  if (!existing || existing.taskId !== taskId) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "pending") {
    return { ok: true, status: existing.status }; // 幂等：已解析，不重复执行
  }

  const resolved = await resolveApprovalState(approvalId, action);
  if (!resolved) {
    const latest = await approvalStore.get(approvalId);
    return { ok: true, status: latest?.status };
  }

  const { approval, hadWaiter } = resolved;
  emit(
    taskId,
    action === "approve" ? "approval.approved" : "approval.rejected",
    { approvalId: approval.id, toolName: approval.toolName },
  );

  if (!hadWaiter) {
    // 跨进程恢复：在新进程重新挂上 Trace 收集，使 resume 产生的事件也进入同一条 Trace
    resumeTrace(taskId);
    // Workflow 任务走 Workflow Resume；普通 Agent 任务走 Agent Session Resume。
    const wfExec = await getWorkflowExecutionStore().getByTaskId(taskId);
    if (wfExec) {
      const { resumeWorkflowExecution, rejectWorkflowExecution } = await import(
        "@/lib/agent/workflow/run"
      );
      if (action === "approve") {
        await resumeWorkflowExecution(wfExec.executionId);
      } else {
        await rejectWorkflowExecution(wfExec.executionId);
      }
    } else if (action === "approve") {
      await resumeAgentSession(taskId, approval);
    } else {
      await cancelWaitingTask(taskId, approval.id);
    }
  }
  return { ok: true, status: approval.status };
}

async function cancelWaitingTask(
  taskId: string,
  approvalId: string,
): Promise<void> {
  if ((await taskStore.get(taskId))?.status === "waiting") {
    await taskStore.transition(taskId, "cancelled");
    await syncSessionStatus(taskId, "cancelled");
    await sessionStore.updatePendingAction(approvalId, "completed");
    emit(taskId, "task.cancelled", { reason: "approval rejected" });
  }
}

/**
 * Phase 10.4 —— 真正的 Full Resume（跨进程）。
 *
 * 原进程的 LLM / waiter Promise 已随重启消失。这里：
 *  1. 重新执行 preApprovalGuard（Resume ≠ 绕过安全）；
 *  2. 重新 resolveTools 确认工具仍存在、仍可执行；
 *  3. 把「被批准的那个工具」安全地执行恰好一次（execute-once 由 ApprovalStore 原子 resolve 保证）；
 *  4. 把工具结果作为消息追加回 Session；
 *  5. 重新进入同一个 Agent Loop（而不是执行完工具就结束）——
 *     LLM 再次推理，可能继续下一个工具（→ 新的 approval → 再次 waiting），直至 final answer。
 */
async function resumeAgentSession(
  taskId: string,
  approval: AgentApproval,
): Promise<void> {
  const task = await taskStore.get(taskId);
  if (!task || task.status !== "waiting") {
    return;
  }

  const r = await executeApprovedToolToSession(taskId, approval);
  if (!r.ok) {
    await taskStore.update(taskId, { error: { code: r.code, message: r.message } });
    await taskStore.transition(taskId, "failed");
    await syncSessionStatus(taskId, "failed");
    emit(taskId, "task.failed", { code: r.code, message: r.message });
    return;
  }

  // 重新进入同一个 Agent Loop（后台执行，不阻塞决策返回）。
  void reenterAgentLoop(taskId);
}

export type ApprovedToolResult =
  | { ok: true; output: unknown; step: number }
  | {
      ok: false;
      code: "RESUME_GUARD_DENIED" | "RESUME_UNSUPPORTED" | "RESUME_TOOL_ERROR";
      message: string;
    };

/**
 * 跨进程 Resume 的共享原语（Phase 10.4/10.6）：
 * 重跑 Guard → resolveTools → 执行被批准工具恰好一次 → 工具结果脱敏后追加回 Session。
 * 不负责收尾任务/工作流（由调用方根据 Agent Task / Workflow Agent Node 场景决定）。
 */
export async function executeApprovedToolToSession(
  taskId: string,
  approval: AgentApproval,
): Promise<ApprovedToolResult> {
  // 1. 安全校验必须重跑
  const guard = await preApprovalGuard(
    approval.toolName,
    approval.input,
    WORKSPACE_ROOT,
  );
  if (!guard.ok) {
    return { ok: false, code: "RESUME_GUARD_DENIED", message: guard.error ?? "denied" };
  }

  // 2. 工具仍需存在且可执行
  const tools = await resolveTools();
  const tool = tools[approval.toolName];
  if (!tool || typeof tool.execute !== "function") {
    return {
      ok: false,
      code: "RESUME_UNSUPPORTED",
      message: `resume unsupported: tool not found "${approval.toolName}"`,
    };
  }

  const session = await sessionStore.getByTaskId(taskId);
  const task = await taskStore.get(taskId);

  await taskStore.transition(taskId, "running").catch(() => undefined);
  await syncSessionStatus(taskId, "running");
  await sessionStore.updatePendingAction(approval.id, "executing");

  // 3. 执行被批准的工具恰好一次
  const step = (task?.currentStep ?? 0) + 1;
  emit(taskId, "tool.started", {
    step,
    tool: approval.toolName,
    input: sanitizeToolInput(approval.toolName, approval.input),
  });

  try {
    const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;
    const output = await execute(approval.input, {
      toolCallId: `resume-${approval.id}`,
      messages: [],
    });
    const success = (output as { success?: boolean })?.success !== false;
    emit(taskId, "tool.completed", {
      step,
      tool: approval.toolName,
      success,
      result: sanitizeToolOutput(approval.toolName, output),
    });
    await sessionStore.updatePendingAction(approval.id, "completed");
    await taskStore.update(taskId, { currentStep: step });

    // 4. 工具结果回写 Session（脱敏），作为 Agent Loop 继续推理的上下文
    if (session) {
      await sessionStore.appendMessage(session.sessionId, {
        role: "assistant",
        content: `[tool-call] ${approval.toolName}`,
      });
      await sessionStore.appendMessage(session.sessionId, {
        role: "user",
        content: sanitizeMessageContent(
          `[tool-result:${approval.toolName}] ${JSON.stringify(
            sanitizeToolOutput(approval.toolName, output),
          )}`,
        ),
      });
    }
    return { ok: true, output, step };
  } catch (error) {
    const message = error instanceof Error ? error.message : "resume tool failed";
    return { ok: false, code: "RESUME_TOOL_ERROR", message };
  }
}

// 用「当前 Session 的完整消息历史」重新进入 Agent Loop。无 Session 时回退到 task.messages。
async function reenterAgentLoop(taskId: string): Promise<void> {
  const task = await taskStore.get(taskId);
  if (!task || task.status !== "running") return;

  const session = await sessionStore.getByTaskId(taskId);
  const messages: AgentMessage[] = session
    ? (await sessionStore.getMessages(session.sessionId)).map((m) => ({
        role: m.role,
        content: m.content,
      }))
    : task.messages;

  await runAgentLoopForTask(
    taskId,
    session?.sessionId ?? null,
    messages,
    task.maxSteps,
  );
}
