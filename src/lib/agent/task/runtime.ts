import { randomUUID } from "node:crypto";

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
function emit(
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
function makeLoopEventHandler(taskId: string) {
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
          input: event.input,
        });
        break;
      case "tool.completed":
        emit(taskId, "tool.completed", {
          step: event.step,
          tool: event.tool,
          success: event.success,
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

// 执行一个已创建的 Task：pending → running → completed / failed
async function executeTask(taskId: string): Promise<void> {
  const task = store.getTask(taskId);

  if (!task) {
    return;
  }

  store.transitionTask(taskId, "running");
  emit(taskId, "task.started");

  try {
    // 解析统一工具集（Local + MCP）并加载 Skill 指令；二者都优雅降级
    const [tools, instructions] = await Promise.all([
      resolveTools(),
      loadSkillInstructions(),
    ]);

    const result = await streamAgent({
      messages: task.messages,
      maxSteps: task.maxSteps,
      tools,
      instructions,
      onEvent: makeLoopEventHandler(taskId),
    });

    store.updateTask(taskId, {
      answer: result.answer,
      currentStep: result.steps,
    });
    store.transitionTask(taskId, "completed");
    emit(taskId, "task.completed", { steps: result.steps });
  } catch (error) {
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
  emit(task.id, "task.created");

  await executeTask(task.id);

  return {
    task: store.getTask(task.id) as AgentTask,
    events: store.getEvents(task.id),
  };
}
