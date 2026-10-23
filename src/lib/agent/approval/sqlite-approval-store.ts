import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentApproval,
  ApprovalAction,
  ApprovalPatch,
  ApprovalStore,
  ApprovalStatus,
  CreateApprovalInput,
} from "@/lib/agent/approval/approval-store";
import { newApproval } from "@/lib/agent/approval/approval-store";

/**
 * SQLiteApprovalStore —— Approval 的持久化实现（复用 Task 的同一个 SQLite 库/连接路径）。
 * resolve 在事务内完成 pending → approved/rejected，保证原子与幂等（同一 approval 只能成功解析一次）。
 */
interface ApprovalRow {
  id: string;
  task_id: string;
  tool_name: string;
  input: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

function rowToApproval(row: ApprovalRow): AgentApproval {
  return {
    id: row.id,
    taskId: row.task_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input),
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export class SQLiteApprovalStore implements ApprovalStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_task ON agent_approvals(task_id);
    `);
  }

  async create(input: CreateApprovalInput): Promise<AgentApproval> {
    const approval = newApproval(input);
    this.db
      .prepare(
        `INSERT INTO agent_approvals (id, task_id, tool_name, input, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.taskId,
        approval.toolName,
        JSON.stringify(approval.input),
        approval.status,
        approval.createdAt,
        null,
      );
    return approval;
  }

  async get(id: string): Promise<AgentApproval | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  async getByTaskId(taskId: string): Promise<AgentApproval[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_approvals WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async update(id: string, patch: ApprovalPatch): Promise<AgentApproval | null> {
    const current = await this.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.db
      .prepare("UPDATE agent_approvals SET input = ? WHERE id = ?")
      .run(JSON.stringify(updated.input), id);
    return updated;
  }

  async resolve(id: string, action: ApprovalAction): Promise<AgentApproval | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM agent_approvals WHERE id = ?")
        .get(id) as ApprovalRow | undefined;
      if (!row || row.status !== "pending") {
        this.db.exec("ROLLBACK");
        return null;
      }
      const status: ApprovalStatus = action === "approve" ? "approved" : "rejected";
      const resolvedAt = new Date().toISOString();
      this.db
        .prepare("UPDATE agent_approvals SET status = ?, resolved_at = ? WHERE id = ?")
        .run(status, resolvedAt, id);
      this.db.exec("COMMIT");
      return { ...rowToApproval(row), status, resolvedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_approvals WHERE id = ?").run(id);
  }

  async list(): Promise<AgentApproval[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_approvals ORDER BY created_at ASC")
      .all() as ApprovalRow[];
    return rows.map(rowToApproval);
  }
}
