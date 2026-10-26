import { randomUUID } from "node:crypto";

import type { AgentMessage } from "@/lib/agent/loop";

/**
 * Phase 10.4：Agent Session 数据模型
 *
 * Session 的唯一职责：保存「恢复一个被中断的 Agent Loop」所必须的对话历史，
 * 以及「正在等待审批的那个 tool call」(pending action)。
 *
 * 复用 loop.ts 的 AgentMessage（{role, content}），不另造一套消息类型。
 * Session 是敏感数据边界：持久化前统一脱敏，绝不保存 token/secret/文件全文等。
 */
export type SessionStatus =
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentSession {
  sessionId: string;
  taskId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

// 持久化的单条消息（role + 文本内容）；payload 以 JSON 保存，sequence 由 Store 保证严格递增
export interface AgentSessionMessage {
  messageId: string;
  role: AgentMessage["role"];
  content: string;
  createdAt: string;
}

export type PendingActionStatus = "waiting" | "executing" | "completed";

/**
 * 正在等待审批的 tool call。input 这里只存「可安全持久化」的脱敏结果，
 * 真正 resume 执行所需的原始 input 从 ApprovalStore 读取（审批记录里已持久化）。
 */
export interface AgentSessionPendingAction {
  id: string;
  sessionId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  input: unknown; // 脱敏后的入参（见 sanitizePendingInput）
  approvalId: string;
  status: PendingActionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionInput {
  taskId: string;
  status?: SessionStatus;
}

export type SessionPatch = Partial<Pick<AgentSession, "status">>;

export interface CreatePendingActionInput {
  sessionId: string;
  taskId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  approvalId: string;
}

export function newSession(input: CreateSessionInput): AgentSession {
  const now = new Date().toISOString();
  return {
    sessionId: randomUUID(),
    taskId: input.taskId,
    status: input.status ?? "active",
    createdAt: now,
    updatedAt: now,
  };
}

// PLACEHOLDER_SANITIZE

/**
 * pending action input 的脱敏：只保留「可安全持久化」的最小字段。
 * 关键：writeFile 的 content 绝不落 Session（只存 path + contentLength），
 * 真正 resume 时从 ApprovalStore 读原始 input。其余工具保留执行所需的安全字段。
 */
export function sanitizePendingInput(toolName: string, input: unknown): unknown {
  const obj = (input ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case "writeFile":
      return {
        path: obj.path,
        contentLength:
          typeof obj.content === "string" ? obj.content.length : undefined,
      };
    case "runCommand":
      return { program: obj.program, args: obj.args, cwd: obj.cwd };
    case "gitAdd":
      return { paths: obj.paths };
    case "gitCommit":
      return { message: obj.message };
    case "gitPush":
      return { remote: obj.remote ?? "origin", branch: obj.branch };
    default:
      return {};
  }
}

const SECRET_KEY_RE =
  /(token|api[_-]?key|authorization|cookie|password|secret)/i;

/**
 * 消息内容的脱敏：Session 会把原本只在内存里的消息写进 SQLite，
 * 因此持久化前统一屏蔽明显的凭证键值，宁可丢字段也不存凭证。
 */
export function sanitizeMessageContent(content: string): string {
  return content
    .split("\n")
    .map((line) =>
      SECRET_KEY_RE.test(line) && /[:=]/.test(line)
        ? line.replace(/([:=]).*/, "$1 [REDACTED]")
        : line,
    )
    .join("\n");
}
