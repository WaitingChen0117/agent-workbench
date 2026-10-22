import { randomUUID } from "node:crypto";

import {
  AgentLoopLimitError,
  runAgent,
  type AgentMessage,
  type AgentLoopEvent,
} from "@/lib/agent/loop";
import { MAX_AGENT_STEPS } from "@/lib/agent/loop";
import * as store from "@/lib/agent/task/store";
import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskEventType,
} from "@/lib/agent/task/types";

/**
 * Task Runtime
 *
 * 分层：Task Runtime → Agent Loop → LLM → Tool Registry → Tools
 *
 * Runtime 负责：创建 Task、驱动状态转换、记录 Task Event、调用 Agent Loop、
 * 捕获异常并落到 completed / failed。
 * Agent Loop 只负责 LLM / Tool / messages / maxSteps，不关心 Task。
 */

export interface RunTaskInput {
  messages: AgentMessage[];
  maxSteps?: number;
}

export interface RunTaskResult {
  task: AgentTask;
  events: AgentTaskEvent[];
}

export async function createAndRunTask({
  messages,
  maxSteps = MAX_AGENT_STEPS,
}: RunTaskInput): Promise<RunTaskResult> {
  const task = store.createTask({ messages, maxSteps });

  // 统一的事件记录：写入 Store 并打印，方便后续做 Trace
  const record = (type: AgentTaskEventType, data?: unknown): void => {
    const event: AgentTaskEvent = {
      id: randomUUID(),
      taskId: task.id,
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    store.appendEvent(task.id, event);

    console.log(
      `[Task Event] ${type}`,
      data === undefined ? "" : JSON.stringify(data),
    );
  };

  record("task.created");

  // pending → running
  store.transitionTask(task.id, "running");
  record("task.started");

  // 把 Agent Loop 的细粒度事件映射成 Task Event，并同步 currentStep
  const handleLoopEvent = (event: AgentLoopEvent): void => {
    switch (event.type) {
      case "agent.step.started":
        store.updateTask(task.id, { currentStep: event.step });
        record("agent.step.started", { step: event.step });
        break;
      case "llm.requested":
        record("llm.requested", { step: event.step });
        break;
      case "tool.started":
        record("tool.started", {
          step: event.step,
          tool: event.tool,
          input: event.input,
        });
        break;
      case "tool.completed":
        record("tool.completed", {
          step: event.step,
          tool: event.tool,
          success: event.success,
        });
        break;
      case "agent.step.completed":
        record("agent.step.completed", {
          step: event.step,
          toolCalls: event.toolCalls,
        });
        break;
    }
  };

  try {
    const result = await runAgent({
      messages: task.messages,
      maxSteps: task.maxSteps,
      onEvent: handleLoopEvent,
    });

    store.updateTask(task.id, {
      answer: result.answer,
      currentStep: result.steps,
    });

    // running → completed
    store.transitionTask(task.id, "completed");
    record("task.completed", { steps: result.steps });
  } catch (error) {
    const code =
      error instanceof AgentLoopLimitError ? "AGENT_LOOP_LIMIT" : "AGENT_ERROR";
    const message =
      error instanceof Error ? error.message : "Agent execution failed";

    store.updateTask(task.id, { error: { code, message } });

    // running → failed（保证 HTTP 出错时 Task 不会停留在 running）
    store.transitionTask(task.id, "failed");
    record("task.failed", { code, message });
  }

  return {
    task: store.getTask(task.id) as AgentTask,
    events: store.getEvents(task.id),
  };
}
