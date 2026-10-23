import { randomUUID } from "node:crypto";

import type { ToolSet } from "ai";

import {
  AgentLoopLimitError,
  streamAgent,
  MAX_AGENT_STEPS,
  type AgentMessage,
  type AgentLoopEvent,
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
import { startTrace } from "@/lib/agent/trace/collector";
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
        }
        return originalExecute(input, options);
      }

      // rejected：取消任务并中止 Agent Loop
      if ((await taskStore.get(ctx.taskId))?.status === "waiting") {
        await taskStore.transition(ctx.taskId, "cancelled");
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

// 执行一个已创建的 Task：pending → running →（可选 waiting）→ completed / failed / cancelled
async function executeTask(taskId: string): Promise<void> {
  const task = await taskStore.get(taskId);

  if (!task) {
    return;
  }

  await taskStore.transition(taskId, "running");
  emit(taskId, "task.started");

  const abortController = new AbortController();

  try {
    // 解析统一工具集（Local + MCP），再包一层 Permission Gate；加载 Skill 指令
    const [baseTools, instructions] = await Promise.all([
      resolveTools(),
      loadSkillInstructions(),
    ]);

    const tools = wrapToolsWithPermissions(baseTools, {
      taskId,
      abortController,
    });

    const result = await streamAgent({
      messages: task.messages,
      maxSteps: task.maxSteps,
      tools,
      instructions,
      abortSignal: abortController.signal,
      onEvent: makeLoopEventHandler(taskId),
    });

    // 仅当仍在 running 时收尾为 completed（可能已被 reject 置为 cancelled）
    if ((await taskStore.get(taskId))?.status === "running") {
      await taskStore.update(taskId, {
        answer: result.answer,
        currentStep: result.steps,
      });
      await taskStore.transition(taskId, "completed");
      emit(taskId, "task.completed", { steps: result.steps });
    }
  } catch (error) {
    // 已被 reject 等终态化则不再处理（幂等）
    if ((await taskStore.get(taskId))?.status !== "running") {
      return;
    }

    const code =
      error instanceof AgentLoopLimitError ? "AGENT_LOOP_LIMIT" : "AGENT_ERROR";
    const message =
      error instanceof Error ? error.message : "Agent execution failed";

    await taskStore.update(taskId, { error: { code, message } });
    await taskStore.transition(taskId, "failed");
    emit(taskId, "task.failed", { code, message });
  }
}

/**
 * 异步模式：创建并立即返回 Task，Agent 在后台执行。
 * 调用方拿到 taskId 后即可连接 SSE 订阅事件。
 */
export async function createAndStartTask({
  messages,
  maxSteps = MAX_AGENT_STEPS,
}: RunTaskInput): Promise<AgentTask> {
  const task = await taskStore.create({ messages, maxSteps });
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
  const task = await taskStore.create({ messages, maxSteps });
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
    if (action === "approve") {
      await resumeApprovedTool(taskId, approval);
    } else {
      await cancelWaitingTask(taskId);
    }
  }
  return { ok: true, status: approval.status };
}

async function cancelWaitingTask(taskId: string): Promise<void> {
  if ((await taskStore.get(taskId))?.status === "waiting") {
    await taskStore.transition(taskId, "cancelled");
    emit(taskId, "task.cancelled", { reason: "approval rejected" });
  }
}

/**
 * 进程重启后恢复：原进程的 LLM / Promise 已消失，这里不重跑已完成步骤、不重调 LLM，
 * 只把「被批准的那一个工具」安全地执行恰好一次（Resume 仍重新校验 guard，不绕过安全），
 * 然后收尾任务。Agent 的后续 LLM 对话无法跨进程续跑（未持久化会话，见技术债务）。
 */
async function resumeApprovedTool(
  taskId: string,
  approval: AgentApproval,
): Promise<void> {
  const task = await taskStore.get(taskId);
  if (!task || task.status !== "waiting") {
    return;
  }

  const guard = await preApprovalGuard(
    approval.toolName,
    approval.input,
    WORKSPACE_ROOT,
  );
  if (!guard.ok) {
    await taskStore.update(taskId, {
      error: { code: "RESUME_DENIED", message: guard.error ?? "denied" },
    });
    await taskStore.transition(taskId, "failed");
    emit(taskId, "task.failed", { code: "RESUME_DENIED", message: guard.error });
    return;
  }

  const tools = await resolveTools();
  const tool = tools[approval.toolName];
  // Workflow 审批节点等「非本地工具」的 approval 无法跨进程 resume（会话/执行态未持久化，
  // 见技术债务）。在产生任何副作用或状态流转前先失败收尾，不发 tool.started、不重复执行。
  if (!tool || typeof tool.execute !== "function") {
    const message = `resume unsupported: tool not found "${approval.toolName}"`;
    await taskStore.update(taskId, {
      error: { code: "RESUME_UNSUPPORTED", message },
    });
    await taskStore.transition(taskId, "failed");
    emit(taskId, "task.failed", { code: "RESUME_UNSUPPORTED", message });
    return;
  }

  await taskStore.transition(taskId, "running");

  const step = (task.currentStep ?? 0) + 1;
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
    emit(taskId, "tool.completed", {
      step,
      tool: approval.toolName,
      success: (output as { success?: boolean })?.success !== false,
      result: sanitizeToolOutput(approval.toolName, output),
    });
    await taskStore.update(taskId, {
      answer: `[resumed] ${approval.toolName} executed once after restart`,
      currentStep: step,
    });
    await taskStore.transition(taskId, "completed");
    emit(taskId, "task.completed", { resumed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "resume tool failed";
    await taskStore.update(taskId, {
      error: { code: "RESUME_TOOL_ERROR", message },
    });
    await taskStore.transition(taskId, "failed");
    emit(taskId, "task.failed", { code: "RESUME_TOOL_ERROR", message });
  }
}
