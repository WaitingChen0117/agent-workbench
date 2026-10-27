import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  newSession,
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionPendingAction,
  type CreatePendingActionInput,
  type CreateSessionInput,
  type PendingActionStatus,
  type SessionPatch,
  type SessionStatus,
} from "@/lib/agent/session/types";
import type { SessionStore } from "@/lib/agent/session/session-store";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";

/**
 * SQLiteSessionStore —— 复用 Task 的同一个 SQLite 库（AGENT_TASK_DB_PATH），不新建第二个库。
 * 三张表：agent_sessions / agent_session_messages / agent_session_pending_actions。
 * 消息 sequence 在事务内取 MAX+1，保证严格递增（不依赖 JS 内存 counter）。
 */
interface SessionRow {
  session_id: string;
  task_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}
interface MessageRow {
  message_id: string;
  role: string;
  payload: string;
  created_at: string;
}
interface ActionRow {
  id: string;
  session_id: string;
  task_id: string;
  tool_call_id: string;
  tool_name: string;
  input: string;
  approval_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    taskId: row.task_id,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function toAction(row: ActionRow): AgentSessionPendingAction {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input),
    approvalId: row.approval_id,
    status: row.status as PendingActionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// PLACEHOLDER_CLASS

export class SQLiteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_session_messages (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        role TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_task ON agent_session_messages(session_id);
      CREATE TABLE IF NOT EXISTS agent_session_pending_actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        approval_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_actions_task ON agent_session_pending_actions(task_id);
    `);
  }

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const session = newSession(input);
    this.db
      .prepare(
        `INSERT INTO agent_sessions (session_id, task_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        session.taskId,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
    return session;
  }

  async get(sessionId: string): Promise<AgentSession | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async getByTaskId(taskId: string): Promise<AgentSession | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_sessions WHERE task_id = ?")
      .get(taskId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async update(sessionId: string, patch: SessionPatch): Promise<AgentSession | null> {
    const cur = await this.get(sessionId);
    if (!cur) return null;
    const updatedAt = new Date().toISOString();
    const status = patch.status ?? cur.status;
    this.db
      .prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE session_id = ?")
      .run(status, updatedAt, sessionId);
    return { ...cur, status, updatedAt };
  }

  // PLACEHOLDER_METHODS

  async appendMessage(
    sessionId: string,
    message: { role: AgentSessionMessage["role"]; content: string },
  ): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_session_messages WHERE session_id = ?",
        )
        .get(sessionId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO agent_session_messages (session_id, sequence, message_id, role, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          next,
          randomUUID(),
          message.role,
          JSON.stringify({ content: message.content }),
          new Date().toISOString(),
        );
      this.db
        .prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
        .run(new Date().toISOString(), sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getMessages(sessionId: string): Promise<AgentSessionMessage[]> {
    const rows = this.db
      .prepare(
        "SELECT message_id, role, payload, created_at FROM agent_session_messages WHERE session_id = ? ORDER BY sequence ASC",
      )
      .all(sessionId) as MessageRow[];
    return rows.map((r) => ({
      messageId: r.message_id,
      role: r.role as AgentSessionMessage["role"],
      content: (JSON.parse(r.payload) as { content: string }).content,
      createdAt: r.created_at,
    }));
  }

  async getMessagesPage(
    sessionId: string,
    options: ListOptions,
  ): Promise<PageResult<AgentSessionMessage>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ seq: number }>("session-msg", options.cursor);
    const rows = this.db
      .prepare(
        `SELECT sequence, message_id, role, payload, created_at FROM agent_session_messages
         WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      )
      .all(sessionId, cursor?.seq ?? 0, limit + 1) as Array<
      MessageRow & { sequence: number }
    >;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((r) => ({
      messageId: r.message_id,
      role: r.role as AgentSessionMessage["role"],
      content: (JSON.parse(r.payload) as { content: string }).content,
      createdAt: r.created_at,
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor("session-msg", { seq: last.sequence }) : undefined,
    };
  }

  async createPendingAction(
    input: CreatePendingActionInput,
  ): Promise<AgentSessionPendingAction> {
    const now = new Date().toISOString();
    const action: AgentSessionPendingAction = {
      id: randomUUID(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      approvalId: input.approvalId,
      status: "waiting",
      createdAt: now,
      updatedAt: now,
    };
    // 同一 approval 只能有一个 pending action：approval_id UNIQUE + INSERT OR IGNORE
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_session_pending_actions
         (id, session_id, task_id, tool_call_id, tool_name, input, approval_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.sessionId,
        action.taskId,
        action.toolCallId,
        action.toolName,
        JSON.stringify(action.input),
        action.approvalId,
        action.status,
        action.createdAt,
        action.updatedAt,
      );
    return (await this.getPendingAction(input.approvalId)) ?? action;
  }

  async getPendingAction(
    approvalId: string,
  ): Promise<AgentSessionPendingAction | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_session_pending_actions WHERE approval_id = ?")
      .get(approvalId) as ActionRow | undefined;
    return row ? toAction(row) : null;
  }

  async getWaitingActions(
    sessionId: string,
  ): Promise<AgentSessionPendingAction[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_session_pending_actions WHERE session_id = ? AND status = 'waiting' ORDER BY created_at ASC",
      )
      .all(sessionId) as ActionRow[];
    return rows.map(toAction);
  }

  async updatePendingAction(
    approvalId: string,
    status: PendingActionStatus,
  ): Promise<AgentSessionPendingAction | null> {
    const cur = await this.getPendingAction(approvalId);
    if (!cur) return null;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE agent_session_pending_actions SET status = ?, updated_at = ? WHERE approval_id = ?")
      .run(status, updatedAt, approvalId);
    return { ...cur, status, updatedAt };
  }

  async list(): Promise<AgentSession[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_sessions ORDER BY created_at ASC")
      .all() as SessionRow[];
    return rows.map(toSession);
  }

  async delete(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_sessions WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM agent_session_messages WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM agent_session_pending_actions WHERE session_id = ?").run(sessionId);
  }
}
