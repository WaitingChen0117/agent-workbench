import {
  newSession,
  type AgentSession,
  type AgentSessionMessage,
  type AgentSessionPendingAction,
  type CreatePendingActionInput,
  type CreateSessionInput,
  type PendingActionStatus,
  type SessionPatch,
} from "@/lib/agent/session/types";
import { SQLiteSessionStore } from "@/lib/agent/session/sqlite-session-store";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";
import { randomUUID } from "node:crypto";

/**
 * SessionStore 抽象（与 TaskStore / ApprovalStore 保持一致的风格）。
 * backend 选择只发生在 getSessionStore()，Runtime 不感知 memory / sqlite。
 */
export interface SessionStore {
  create(input: CreateSessionInput): Promise<AgentSession>;
  get(sessionId: string): Promise<AgentSession | null>;
  getByTaskId(taskId: string): Promise<AgentSession | null>;
  update(sessionId: string, patch: SessionPatch): Promise<AgentSession | null>;
  appendMessage(
    sessionId: string,
    message: { role: AgentSessionMessage["role"]; content: string },
  ): Promise<void>;
  getMessages(sessionId: string): Promise<AgentSessionMessage[]>;
  // 分页读取消息（Phase 10.7-C）；Resume 仍用上面的 full-read 保证上下文完整
  getMessagesPage(
    sessionId: string,
    options: ListOptions,
  ): Promise<PageResult<AgentSessionMessage>>;
  // pending action：同一个 approval 只能对应一个 pending action
  createPendingAction(
    input: CreatePendingActionInput,
  ): Promise<AgentSessionPendingAction>;
  getPendingAction(
    approvalId: string,
  ): Promise<AgentSessionPendingAction | null>;
  getWaitingActions(sessionId: string): Promise<AgentSessionPendingAction[]>;
  updatePendingAction(
    approvalId: string,
    status: PendingActionStatus,
  ): Promise<AgentSessionPendingAction | null>;
  list(): Promise<AgentSession[]>;
  delete(sessionId: string): Promise<void>;
}

// PLACEHOLDER_MEMORY

interface MemoryState {
  sessions: Map<string, AgentSession>;
  messages: Map<string, AgentSessionMessage[]>; // sessionId -> ordered
  actions: Map<string, AgentSessionPendingAction>; // approvalId -> action
}

class MemorySessionStore implements SessionStore {
  private readonly s: MemoryState;

  constructor() {
    const g = globalThis as typeof globalThis & {
      __agentSessionState?: MemoryState;
    };
    this.s =
      g.__agentSessionState ??
      (g.__agentSessionState = {
        sessions: new Map(),
        messages: new Map(),
        actions: new Map(),
      });
  }

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const session = newSession(input);
    this.s.sessions.set(session.sessionId, session);
    this.s.messages.set(session.sessionId, []);
    return session;
  }
  async get(sessionId: string): Promise<AgentSession | null> {
    return this.s.sessions.get(sessionId) ?? null;
  }
  async getByTaskId(taskId: string): Promise<AgentSession | null> {
    return (
      [...this.s.sessions.values()].find((x) => x.taskId === taskId) ?? null
    );
  }
  async update(sessionId: string, patch: SessionPatch): Promise<AgentSession | null> {
    const cur = this.s.sessions.get(sessionId);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.s.sessions.set(sessionId, next);
    return next;
  }
  async appendMessage(
    sessionId: string,
    message: { role: AgentSessionMessage["role"]; content: string },
  ): Promise<void> {
    const list = this.s.messages.get(sessionId);
    if (!list) return;
    list.push({
      messageId: randomUUID(),
      role: message.role,
      content: message.content,
      createdAt: new Date().toISOString(),
    });
  }
  async getMessages(sessionId: string): Promise<AgentSessionMessage[]> {
    return [...(this.s.messages.get(sessionId) ?? [])];
  }
  async getMessagesPage(
    sessionId: string,
    options: ListOptions,
  ): Promise<PageResult<AgentSessionMessage>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ offset: number }>(options.cursor);
    const all = this.s.messages.get(sessionId) ?? [];
    const offset = cursor?.offset ?? 0;
    const items = all.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      items,
      nextCursor: nextOffset < all.length ? encodeCursor({ offset: nextOffset }) : undefined,
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
    this.s.actions.set(input.approvalId, action);
    return action;
  }
  async getPendingAction(
    approvalId: string,
  ): Promise<AgentSessionPendingAction | null> {
    return this.s.actions.get(approvalId) ?? null;
  }
  async getWaitingActions(
    sessionId: string,
  ): Promise<AgentSessionPendingAction[]> {
    return [...this.s.actions.values()].filter(
      (a) => a.sessionId === sessionId && a.status === "waiting",
    );
  }
  async updatePendingAction(
    approvalId: string,
    status: PendingActionStatus,
  ): Promise<AgentSessionPendingAction | null> {
    const cur = this.s.actions.get(approvalId);
    if (!cur) return null;
    const next = { ...cur, status, updatedAt: new Date().toISOString() };
    this.s.actions.set(approvalId, next);
    return next;
  }
  async list(): Promise<AgentSession[]> {
    return [...this.s.sessions.values()];
  }
  async delete(sessionId: string): Promise<void> {
    this.s.sessions.delete(sessionId);
    this.s.messages.delete(sessionId);
    for (const [k, v] of this.s.actions) {
      if (v.sessionId === sessionId) this.s.actions.delete(k);
    }
  }
}

const globalRef = globalThis as typeof globalThis & {
  __agentSessionStore?: SessionStore;
};

// backend 选择只发生在这里
export function getSessionStore(): SessionStore {
  if (globalRef.__agentSessionStore) return globalRef.__agentSessionStore;
  let store: SessionStore;
  if (process.env.AGENT_SESSION_STORE === "sqlite") {
    const dbPath =
      process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteSessionStore(dbPath);
  } else {
    store = new MemorySessionStore();
  }
  globalRef.__agentSessionStore = store;
  return store;
}
