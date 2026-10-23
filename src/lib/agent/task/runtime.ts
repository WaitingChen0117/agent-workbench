import { randomUUID } from "node:crypto";

import type { ToolSet } from "ai";

import {
  AgentLoopLimitError,
  streamAgent,
  MAX_AGENT_STEPS,
  type AgentMessage,
  type AgentLoopEvent,
} from "@/lib/agent/loop";
import * as store from "@/lib/agent/task/store";
import * as eventBus from "@/lib/agent/task/event-bus";
import { resolveTools } from "@/lib/agent/tool-resolver";
import { loadSkillInstructions } from "@/lib/agent/skills";
import { getToolPermission } from "@/lib/agent/permission";
import { preApprovalGuard } from "@/lib/agent/guard";
import { createApproval } from "@/lib/agent/approvals";
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

  // message.delta 量大，只做实时推送、不落 Store，避免内存膨胀与无意义重放
  if (options?.persist !== false) {
    store.appendEvent(taskId, event);
  }

  eventBus.publish(event);
}

// 把 Agent Loop 的细粒度事件映射成 Task Event，并同步 currentStep
export function makeLoopEventHandler(taskId: string) {
  return (event: AgentLoopEvent): void => {
    switch (event.type) {
      case "agent.step.started":
        store.updateTask(taskId, { currentStep: event.step });
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

      const { approval, decision } = createApproval(ctx.taskId, name, input);

      if (store.getTask(ctx.taskId)?.status === "running") {
        store.transitionTask(ctx.taskId, "waiting");
      }
      emit(ctx.taskId, "approval.required", {
        approvalId: approval.id,
        toolName: name,
        reason: `Tool "${name}" requires approval before execution`,
        input: summarizeInput(name, input),
      });

      const status = await decision;

      if (status === "approved") {
        if (store.getTask(ctx.taskId)?.status === "waiting") {
          store.transitionTask(ctx.taskId, "running");
        }
        emit(ctx.taskId, "approval.approved", {
          approvalId: approval.id,
          toolName: name,
        });
        return originalExecute(input, options);
      }

      // rejected：取消任务并中止 Agent Loop
      emit(ctx.taskId, "approval.rejected", {
        approvalId: approval.id,
        toolName: name,
      });
      if (store.getTask(ctx.taskId)?.status === "waiting") {
        store.transitionTask(ctx.taskId, "cancelled");
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
  const task = store.getTask(taskId);

  if (!task) {
    return;
  }

  store.transitionTask(taskId, "running");
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
    if (store.getTask(taskId)?.status === "running") {
      store.updateTask(taskId, {
        answer: result.answer,
        currentStep: result.steps,
      });
      store.transitionTask(taskId, "completed");
      emit(taskId, "task.completed", { steps: result.steps });
    }
  } catch (error) {
    // 已被 reject 等终态化则不再处理（幂等）
    if (store.getTask(taskId)?.status !== "running") {
      return;
    }

    const code =
      error instanceof AgentLoopLimitError ? "AGENT_LOOP_LIMIT" : "AGENT_ERROR";
    const message =
      error instanceof Error ? error.message : "Agent execution failed";

    store.updateTask(taskId, { error: { code, message } });
    store.transitionTask(taskId, "failed");
    emit(taskId, "task.failed", { code, message });
  }
}

/**
 * 异步模式：创建并立即返回 Task，Agent 在后台执行。
 * 调用方拿到 taskId 后即可连接 SSE 订阅事件。
 */
export function createAndStartTask({
  messages,
  maxSteps = MAX_AGENT_STEPS,
}: RunTaskInput): AgentTask {
  const task = store.createTask({ messages, maxSteps });
  startTrace(task.id); // 先订阅，保证捕获 task.created 之后的完整生命周期
  emit(task.id, "task.created");

  // 后台执行，不阻塞 HTTP 响应。
  // 注意：依赖进程在响应返回后继续存活（本地 Node 可行）；
  // Serverless / Edge 可能在响应后冻结或回收实例，需要外部 Worker 支撑。
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
  const task = store.createTask({ messages, maxSteps });
  startTrace(task.id);
  emit(task.id, "task.created");

  await executeTask(task.id);

  return {
    task: store.getTask(task.id) as AgentTask,
    events: store.getEvents(task.id),
  };
}
