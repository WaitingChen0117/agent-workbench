import { randomUUID } from "node:crypto";

import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";

/**
 * ApprovalStore 抽象（Phase 10.3）
 *
 * 把 Approval 的「状态」从进程内 Promise 里剥离出来，使其可持久化（SQLite）。
 * Promise（等待者）本身不可持久化，由 waiter.ts 单独在进程内维护。
 *
 * 语义：
 *  - create → pending
 *  - resolve：pending → approved / rejected（原子、幂等；非 pending 返回 null）
 *  - 不存在：get/getByTaskId/update/resolve 返回 null/[]，delete no-op
 */
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalAction = "approve" | "reject";

export interface AgentApproval {
  id: string;
  taskId: string;
  toolName: string;
  input: unknown; // 结构化 tool input（resume 时需要），已由 pre-approval guard 校验过安全性
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface CreateApprovalInput {
  taskId: string;
  toolName: string;
  input: unknown;
}

export type ApprovalPatch = Partial<Pick<AgentApproval, "input">>;

export interface ApprovalStore {
  create(input: CreateApprovalInput): Promise<AgentApproval>;
  get(id: string): Promise<AgentApproval | null>;
  getByTaskId(taskId: string): Promise<AgentApproval[]>;
  update(id: string, patch: ApprovalPatch): Promise<AgentApproval | null>;
  /** 原子 pending → approved/rejected；非 pending 或不存在返回 null */
  resolve(id: string, action: ApprovalAction): Promise<AgentApproval | null>;
  delete(id: string): Promise<void>;
  list(): Promise<AgentApproval[]>;
}

export function newApproval(input: CreateApprovalInput): AgentApproval {
  return {
    id: randomUUID(),
    taskId: input.taskId,
    toolName: input.toolName,
    input: input.input,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

class MemoryApprovalStore implements ApprovalStore {
  private readonly map: Map<string, AgentApproval>;

  constructor() {
    const g = globalThis as typeof globalThis & {
      __agentApprovalState?: Map<string, AgentApproval>;
    };
    this.map = g.__agentApprovalState ?? (g.__agentApprovalState = new Map());
  }

  async create(input: CreateApprovalInput): Promise<AgentApproval> {
    const approval = newApproval(input);
    this.map.set(approval.id, approval);
    return approval;
  }
  async get(id: string): Promise<AgentApproval | null> {
    return this.map.get(id) ?? null;
  }
  async getByTaskId(taskId: string): Promise<AgentApproval[]> {
    return [...this.map.values()].filter((a) => a.taskId === taskId);
  }
  async update(id: string, patch: ApprovalPatch): Promise<AgentApproval | null> {
    const a = this.map.get(id);
    if (!a) return null;
    const updated = { ...a, ...patch };
    this.map.set(id, updated);
    return updated;
  }
  async resolve(id: string, action: ApprovalAction): Promise<AgentApproval | null> {
    const a = this.map.get(id);
    if (!a || a.status !== "pending") return null;
    const updated: AgentApproval = {
      ...a,
      status: action === "approve" ? "approved" : "rejected",
      resolvedAt: new Date().toISOString(),
    };
    this.map.set(id, updated);
    return updated;
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
  async list(): Promise<AgentApproval[]> {
    return [...this.map.values()];
  }
}

const globalRef = globalThis as typeof globalThis & {
  __agentApprovalStore?: ApprovalStore;
};

// Store 选择只发生在这里；Runtime / API 不感知 memory / sqlite
export function getApprovalStore(): ApprovalStore {
  if (globalRef.__agentApprovalStore) {
    return globalRef.__agentApprovalStore;
  }
  let store: ApprovalStore;
  if (process.env.AGENT_APPROVAL_STORE === "sqlite") {
    const dbPath =
      process.env.AGENT_TASK_DB_PATH ?? `${process.cwd()}/.data/agent.sqlite`;
    store = new SQLiteApprovalStore(dbPath);
  } else {
    store = new MemoryApprovalStore();
  }
  globalRef.__agentApprovalStore = store;
  return store;
}
