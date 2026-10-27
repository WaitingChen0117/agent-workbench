import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  NodeExecutionStatus,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNodeExecution,
  WorkflowNodeType,
  WorkflowStatus,
} from "@/lib/agent/workflow/types";
import type {
  WorkflowExecutionPatch,
  WorkflowExecutionStore,
} from "@/lib/agent/workflow/execution-store";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";

/**
 * SQLiteWorkflowExecutionStore —— 复用 Task 的同一个 SQLite 库（AGENT_TASK_DB_PATH）。
 * 两张表：agent_workflow_executions / agent_workflow_node_executions。
 * JSON 字段（error / context / result）以 TEXT 存储，读回时 JSON.parse。
 */
interface ExecRow {
  execution_id: string;
  workflow_id: string;
  task_id: string;
  status: string;
  current_node_id: string | null;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  context: string;
  definition: string | null;
  step_count: number;
  updated_at: string;
}
interface NodeRow {
  execution_id: string;
  node_id: string;
  node_type: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  result: string | null;
  error: string | null;
  approval_id: string | null;
  branch: string | null;
  attempt: number;
}

function toExec(row: ExecRow): WorkflowExecution {
  return {
    executionId: row.execution_id,
    workflowId: row.workflow_id,
    taskId: row.task_id,
    status: row.status as WorkflowStatus,
    currentNodeId: row.current_node_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
    context: JSON.parse(row.context),
    stepCount: row.step_count,
    updatedAt: row.updated_at,
    definition: row.definition
      ? (JSON.parse(row.definition) as WorkflowDefinition)
      : undefined,
  };
}
function toNode(row: NodeRow): WorkflowNodeExecution {
  return {
    executionId: row.execution_id,
    nodeId: row.node_id,
    nodeType: row.node_type as WorkflowNodeType,
    status: row.status as NodeExecutionStatus,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ? JSON.parse(row.error) : undefined,
    approvalId: row.approval_id ?? undefined,
    branch: (row.branch as "true" | "false" | null) ?? undefined,
    attempt: row.attempt,
  };
}

// PLACEHOLDER_CLASS

function nowIso(): string {
  return new Date().toISOString();
}

export class SQLiteWorkflowExecutionStore implements WorkflowExecutionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_workflow_executions (
        execution_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_node_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        error TEXT,
        context TEXT NOT NULL,
        definition TEXT,
        step_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wf_exec_task ON agent_workflow_executions(task_id);
      CREATE INDEX IF NOT EXISTS idx_wf_exec_workflow ON agent_workflow_executions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_wf_exec_status ON agent_workflow_executions(status);
      CREATE TABLE IF NOT EXISTS agent_workflow_node_executions (
        execution_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        result TEXT,
        error TEXT,
        approval_id TEXT,
        branch TEXT,
        attempt INTEGER NOT NULL,
        PRIMARY KEY (execution_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wf_node_exec ON agent_workflow_node_executions(execution_id);
    `);
  }

  async create(execution: WorkflowExecution): Promise<WorkflowExecution> {
    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_workflow_executions
         (execution_id, workflow_id, task_id, status, current_node_id, started_at, ended_at, error, context, definition, step_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        execution.executionId,
        execution.workflowId,
        execution.taskId,
        execution.status,
        execution.currentNodeId ?? null,
        execution.startedAt,
        execution.endedAt ?? null,
        execution.error ? JSON.stringify(execution.error) : null,
        JSON.stringify(execution.context ?? {}),
        execution.definition ? JSON.stringify(execution.definition) : null,
        execution.stepCount ?? 0,
        updatedAt,
      );
    return { ...execution, updatedAt };
  }

  async get(executionId: string): Promise<WorkflowExecution | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_workflow_executions WHERE execution_id = ?")
      .get(executionId) as ExecRow | undefined;
    return row ? toExec(row) : null;
  }

  async getByTaskId(taskId: string): Promise<WorkflowExecution | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_workflow_executions WHERE task_id = ? ORDER BY started_at DESC")
      .get(taskId) as ExecRow | undefined;
    return row ? toExec(row) : null;
  }

  async update(
    executionId: string,
    patch: WorkflowExecutionPatch,
  ): Promise<WorkflowExecution | null> {
    const cur = await this.get(executionId);
    if (!cur) return null;
    const next: WorkflowExecution = { ...cur, ...patch };
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE agent_workflow_executions
         SET status = ?, current_node_id = ?, ended_at = ?, error = ?, context = ?, step_count = ?, updated_at = ?
         WHERE execution_id = ?`,
      )
      .run(
        next.status,
        next.currentNodeId ?? null,
        next.endedAt ?? null,
        next.error ? JSON.stringify(next.error) : null,
        JSON.stringify(next.context ?? {}),
        next.stepCount ?? 0,
        updatedAt,
        executionId,
      );
    return { ...next, updatedAt };
  }

  async transition(
    executionId: string,
    to: WorkflowStatus,
  ): Promise<WorkflowExecution | null> {
    return this.update(executionId, { status: to });
  }

  async delete(executionId: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_workflow_executions WHERE execution_id = ?").run(executionId);
    this.db.prepare("DELETE FROM agent_workflow_node_executions WHERE execution_id = ?").run(executionId);
  }

  async list(): Promise<WorkflowExecution[]> {
    const rows = this.db
      .prepare("SELECT * FROM agent_workflow_executions ORDER BY started_at ASC")
      .all() as ExecRow[];
    return rows.map(toExec);
  }

  async listPage(options: ListOptions): Promise<PageResult<WorkflowExecution>> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ u: string; id: string }>("workflow-exec", options.cursor);
    const rows = (
      cursor
        ? this.db
            .prepare(
              `SELECT * FROM agent_workflow_executions WHERE (updated_at < ? OR (updated_at = ? AND execution_id < ?))
               ORDER BY updated_at DESC, execution_id DESC LIMIT ?`,
            )
            .all(cursor.u, cursor.u, cursor.id, limit + 1)
        : this.db
            .prepare("SELECT * FROM agent_workflow_executions ORDER BY updated_at DESC, execution_id DESC LIMIT ?")
            .all(limit + 1)
    ) as ExecRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(toExec);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        hasMore && last
          ? encodeCursor("workflow-exec", { u: last.updatedAt ?? last.startedAt, id: last.executionId })
          : undefined,
    };
  }

  async upsertNode(node: WorkflowNodeExecution): Promise<WorkflowNodeExecution> {
    this.db
      .prepare(
        `INSERT INTO agent_workflow_node_executions
         (execution_id, node_id, node_type, status, started_at, ended_at, result, error, approval_id, branch, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id, node_id) DO UPDATE SET
           node_type = excluded.node_type,
           status = excluded.status,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           result = excluded.result,
           error = excluded.error,
           approval_id = excluded.approval_id,
           branch = excluded.branch,
           attempt = excluded.attempt`,
      )
      .run(
        node.executionId,
        node.nodeId,
        node.nodeType,
        node.status,
        node.startedAt ?? null,
        node.endedAt ?? null,
        node.result !== undefined ? JSON.stringify(node.result) : null,
        node.error ? JSON.stringify(node.error) : null,
        node.approvalId ?? null,
        node.branch ?? null,
        node.attempt,
      );
    return node;
  }

  async getNode(
    executionId: string,
    nodeId: string,
  ): Promise<WorkflowNodeExecution | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_workflow_node_executions WHERE execution_id = ? AND node_id = ?",
      )
      .get(executionId, nodeId) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  async listNodes(executionId: string): Promise<WorkflowNodeExecution[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_workflow_node_executions WHERE execution_id = ? ORDER BY started_at ASC",
      )
      .all(executionId) as NodeRow[];
    return rows.map(toNode);
  }
}
