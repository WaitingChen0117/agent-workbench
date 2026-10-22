import type { AgentMessage } from "@/lib/agent/loop";

/**
 * 第三阶段：Agent State + Task Runtime 的类型定义
 *
 * 复用 loop.ts 的 AgentMessage，不重复定义消息类型。
 */

export type TaskStatus =
  | "pending" // 任务已创建，还未开始执行
  | "running" // Agent 正在执行
  | "waiting" // Agent 暂停，等待外部输入 / 人工确认
  | "completed" // 任务成功完成
  | "failed" // 任务执行失败
  | "cancelled"; // 任务被用户主动取消

export interface TaskError {
  code: string;
  message: string;
}

export interface AgentTask {
  id: string;
  status: TaskStatus;

  messages: AgentMessage[];

  currentStep: number;
  maxSteps: number;

  createdAt: string;
  updatedAt: string;

  // 最终答案（completed 时写入）—— 为了让任务结果可被 GET 回读，仅此一个额外字段
  answer?: string;

  error?: TaskError;
}

export type AgentTaskEventType =
  | "task.created"
  | "task.started"
  | "agent.step.started"
  | "llm.requested"
  | "message.started"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.completed"
  | "agent.step.completed"
  | "task.completed"
  | "task.failed"
  | "task.cancelled";

export interface AgentTaskEvent {
  id: string;
  taskId: string;
  type: AgentTaskEventType;
  timestamp: string;
  data?: unknown;
}
