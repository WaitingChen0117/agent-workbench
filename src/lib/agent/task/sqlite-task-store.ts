import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assertTransition } from "@/lib/agent/task/state-machine";
import type {
  CreateTaskInput,
  TaskPatch,
  TaskStore,
} from "@/lib/agent/task/task-store";
import type {
  AgentTask,
  AgentTaskEvent,
  TaskStatus,
} from "@/lib/agent/task/types";

/**
 * SQLiteTaskStore —— TaskStore 的真正持久化实现（基于 Node 内置 node:sqlite，无额外依赖）。
 *
 * - 进程重启后 Task / Event 仍在；支持 Crash Recovery。
 * - transition 在事务内「读当前态 → 校验 → 写」，复用现有状态机，不绕过。
 * - 同一 Task 的 Event sequence 由 PRIMARY KEY(task_id, sequence) 保证严格递增、不重复。
 * - 不是安全边界：敏感数据在写入前已由上层 sanitize（事件）/ 为用户内容（messages）。
 */
function nowIso(): string {
  return new Date().toISOString();
}

interface TaskRow {
  id: string;
  status: string;
  messages: string;
  answer: string | null;
  error: string | null;
  current_step: number;
  max_steps: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  type: string;
  timestamp: string;
  payload: string | null;
}

function rowToTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    status: row.status as TaskStatus,
    messages: JSON.parse(row.messages),
    currentStep: row.current_step,
    maxSteps: row.max_steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answer: row.answer ?? undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
  };
}

export class SQLiteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        messages TEXT NOT NULL,
        answer TEXT,
        error TEXT,
        current_step INTEGER NOT NULL DEFAULT 0,
        max_steps INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_task_events (
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload TEXT,
        PRIMARY KEY (task_id, sequence)
      );
    `);
  }

  async create(input: CreateTaskInput): Promise<AgentTask> {
    const ts = nowIso();
    const task: AgentTask = {
      id: randomUUID(),
      status: "pending",
      messages: input.messages,
      currentStep: 0,
      maxSteps: input.maxSteps,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO agent_tasks
         (id, status, messages, answer, error, current_step, max_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.status,
        JSON.stringify(task.messages),
        null,
        null,
        task.currentStep,
        task.maxSteps,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  async get(id: string): Promise<AgentTask | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  // PLACEHOLDER_SQLITE
  async update(id: string, patch: TaskPatch): Promise<AgentTask | null> {
    const current = await this.get(id);
    if (!current) return null;
    // patch 类型已排除 status：update 不能改状态
    const updated: AgentTask = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET messages = ?, answer = ?, error = ?, current_step = ?, max_steps = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(updated.messages),
        updated.answer ?? null,
        updated.error ? JSON.stringify(updated.error) : null,
        updated.currentStep,
        updated.maxSteps,
        updated.updatedAt,
        id,
      );
    return updated;
  }

  async transition(id: string, to: TaskStatus): Promise<AgentTask | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM agent_tasks WHERE id = ?")
        .get(id) as TaskRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const current = rowToTask(row);
      if (current.status === to) {
        this.db.exec("COMMIT"); // 幂等：同态直接返回
        return current;
      }
      assertTransition(current.status, to); // 非法转换抛错 → 下方 catch 回滚
      const updatedAt = nowIso();
      this.db
        .prepare("UPDATE agent_tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(to, updatedAt, id);
      this.db.exec("COMMIT");
      return { ...current, status: to, updatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_task_events WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(id);
  }

  async list(): Promise<AgentTask[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_tasks ORDER BY created_at ASC")
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  async appendEvent(id: string, event: AgentTaskEvent): Promise<void> {
    // 在事务内取下一个 sequence，保证同一 Task 内严格递增、不重复
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { next } = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM agent_task_events WHERE task_id = ?",
        )
        .get(id) as { next: number };
      this.db
        .prepare(
          `INSERT INTO agent_task_events (task_id, sequence, id, type, timestamp, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          next,
          event.id,
          event.type,
          event.timestamp,
          event.data === undefined ? null : JSON.stringify(event.data),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getEvents(id: string): Promise<AgentTaskEvent[]> {
    const rows = this.db
      .prepare(
        "SELECT id, type, timestamp, payload FROM agent_task_events WHERE task_id = ? ORDER BY sequence ASC",
      )
      .all(id) as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      taskId: id,
      type: row.type as AgentTaskEvent["type"],
      timestamp: row.timestamp,
      data: row.payload ? JSON.parse(row.payload) : undefined,
    }));
  }
}

