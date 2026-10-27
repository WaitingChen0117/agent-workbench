import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecrets } from "@/lib/agent/trace/sanitize";
import { withBusyRetry, tx } from "@/lib/agent/persistence/sqlite-util";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ListOptions,
  type PageResult,
} from "@/lib/agent/persistence/pagination";
import type {
  AgentTrace,
  AgentTraceStep,
  TraceStatus,
  TraceStepType,
} from "@/lib/agent/trace/types";
import type { TraceHeader, TraceStore } from "@/lib/agent/trace/trace-store";

/**
 * SQLiteTraceStore（Phase 10.7-A 增量）—— 复用 AGENT_TASK_DB_PATH。
 * appendStep 为事件级增量：按 step_id 幂等；sequence 由 SQLite 原子分配（BEGIN IMMEDIATE + MAX+1）。
 * 持久化前对 input/output 再跑 redactSecrets（SQLite 即敏感边界）。
 */
interface TraceRow {
  task_id: string;
  trace_id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
}
interface StepRow {
  step_id: string;
  trace_id: string;
  task_id: string;
  sequence: number;
  type: string;
  name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  input: string | null;
  output: string | null;
  usage: string | null;
  workflow_id: string | null;
  execution_id: string | null;
  node_id: string | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function toStep(row: StepRow): AgentTraceStep {
  return {
    stepId: row.step_id,
    traceId: row.trace_id,
    sequence: row.sequence,
    type: row.type as TraceStepType,
    name: row.name ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    status: row.status as TraceStatus,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: row.output ? JSON.parse(row.output) : undefined,
    usage: row.usage ? JSON.parse(row.usage) : undefined,
    workflowId: row.workflow_id ?? undefined,
    executionId: row.execution_id ?? undefined,
    nodeId: row.node_id ?? undefined,
  };
}

// PLACEHOLDER_CLASS

export class SQLiteTraceStore implements TraceStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_traces (
        task_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_trace_steps (
        step_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        input TEXT,
        output TEXT,
        usage TEXT,
        workflow_id TEXT,
        execution_id TEXT,
        node_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trace_steps_task ON agent_trace_steps(task_id);
      CREATE INDEX IF NOT EXISTS idx_trace_steps_exec ON agent_trace_steps(execution_id);
      CREATE INDEX IF NOT EXISTS idx_trace_steps_node ON agent_trace_steps(execution_id, node_id);
    `);
  }

  createTrace(header: TraceHeader): void {
    withBusyRetry(() =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO agent_traces (task_id, trace_id, started_at, ended_at, status)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(header.taskId, header.traceId, header.startedAt, null, header.status),
    );
  }

  // 事件级增量：按 step_id 幂等；新 step 的 sequence 由 SQLite 原子分配（MAX+1）。
  appendStep(taskId: string, step: AgentTraceStep): void {
    const input = step.input !== undefined ? JSON.stringify(redactSecrets(step.input)) : null;
    const output = step.output !== undefined ? JSON.stringify(redactSecrets(step.output)) : null;
    const usage = step.usage !== undefined ? JSON.stringify(step.usage) : null;
    tx(this.db, () => {
      const existing = this.db
        .prepare("SELECT sequence FROM agent_trace_steps WHERE step_id = ?")
        .get(step.stepId) as { sequence?: number } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_trace_steps SET type=?, name=?, started_at=?, ended_at=?, duration_ms=?, status=?, input=?, output=?, usage=?, workflow_id=?, execution_id=?, node_id=? WHERE step_id=?`,
          )
          .run(
            step.type, step.name ?? null, step.startedAt, step.endedAt ?? null,
            step.durationMs ?? null, step.status, input, output, usage,
            step.workflowId ?? null, step.executionId ?? null, step.nodeId ?? null, step.stepId,
          );
        return;
      }
      const { next } = this.db
        .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_trace_steps WHERE trace_id = ?")
        .get(step.traceId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO agent_trace_steps
           (step_id, trace_id, task_id, sequence, type, name, started_at, ended_at, duration_ms, status, input, output, usage, workflow_id, execution_id, node_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          step.stepId, step.traceId, taskId, next, step.type, step.name ?? null,
          step.startedAt, step.endedAt ?? null, step.durationMs ?? null, step.status,
          input, output, usage, step.workflowId ?? null, step.executionId ?? null, step.nodeId ?? null,
        );
    });
  }

  updateSummary(taskId: string, patch: { status?: TraceStatus; endedAt?: string }): void {
    const cur = this.db
      .prepare("SELECT status, ended_at FROM agent_traces WHERE task_id = ?")
      .get(taskId) as { status: string; ended_at: string | null } | undefined;
    if (!cur) return;
    withBusyRetry(() =>
      this.db
        .prepare("UPDATE agent_traces SET status = ?, ended_at = ? WHERE task_id = ?")
        .run(patch.status ?? cur.status, patch.endedAt ?? cur.ended_at, taskId),
    );
  }

  // 兼容层：整条写入（供既有调用/评测），内部复用增量方法
  putTrace(trace: AgentTrace): void {
    tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO agent_traces (task_id, trace_id, started_at, ended_at, status)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET trace_id=excluded.trace_id, started_at=excluded.started_at, ended_at=excluded.ended_at, status=excluded.status`,
        )
        .run(trace.taskId, trace.traceId, trace.startedAt, trace.endedAt ?? null, trace.status);
      this.db.prepare("DELETE FROM agent_trace_steps WHERE trace_id = ?").run(trace.traceId);
    });
    for (const s of trace.steps) this.appendStep(trace.taskId, { ...s, traceId: trace.traceId });
  }

  getByTaskId(taskId: string): AgentTrace | null {
    const header = this.db
      .prepare("SELECT * FROM agent_traces WHERE task_id = ?")
      .get(taskId) as TraceRow | undefined;
    if (!header) return null;
    const stepRows = this.db
      .prepare("SELECT * FROM agent_trace_steps WHERE task_id = ? ORDER BY sequence ASC")
      .all(taskId) as StepRow[];
    return {
      traceId: header.trace_id,
      taskId: header.task_id,
      startedAt: header.started_at,
      endedAt: header.ended_at ?? undefined,
      status: header.status as TraceStatus,
      steps: stepRows.map(toStep),
    };
  }

  listByWorkflowExecutionId(executionId: string): AgentTraceStep[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_trace_steps WHERE execution_id = ? ORDER BY sequence ASC")
      .all(executionId) as StepRow[];
    return rows.map(toStep);
  }

  listByWorkflowNodeId(executionId: string, nodeId: string): AgentTraceStep[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_trace_steps WHERE execution_id = ? AND node_id = ? ORDER BY sequence ASC")
      .all(executionId, nodeId) as StepRow[];
    return rows.map(toStep);
  }

  listPage(options: ListOptions): PageResult<AgentTrace> {
    const limit = clampLimit(options.limit);
    const cursor = decodeCursor<{ started: string; id: string }>(options.cursor);
    const rows = (
      cursor
        ? this.db
            .prepare(
              `SELECT * FROM agent_traces WHERE (started_at < ? OR (started_at = ? AND trace_id < ?))
               ORDER BY started_at DESC, trace_id DESC LIMIT ?`,
            )
            .all(cursor.started, cursor.started, cursor.id, limit + 1)
        : this.db
            .prepare("SELECT * FROM agent_traces ORDER BY started_at DESC, trace_id DESC LIMIT ?")
            .all(limit + 1)
    ) as TraceRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((h) => ({
      traceId: h.trace_id,
      taskId: h.task_id,
      startedAt: h.started_at,
      endedAt: h.ended_at ?? undefined,
      status: h.status as TraceStatus,
      steps: [],
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ started: last.started_at, id: last.trace_id }) : undefined,
    };
  }

  delete(taskId: string): void {
    const header = this.db
      .prepare("SELECT trace_id FROM agent_traces WHERE task_id = ?")
      .get(taskId) as { trace_id?: string } | undefined;
    tx(this.db, () => {
      this.db.prepare("DELETE FROM agent_traces WHERE task_id = ?").run(taskId);
      if (header?.trace_id) {
        this.db.prepare("DELETE FROM agent_trace_steps WHERE trace_id = ?").run(header.trace_id);
      }
    });
  }

  cleanupTerminalBefore(cutoffIso: string): number {
    const rows = this.db
      .prepare("SELECT task_id, status, ended_at FROM agent_traces")
      .all() as TraceRow[];
    let n = 0;
    for (const r of rows) {
      if (TERMINAL.has(r.status) && r.ended_at && r.ended_at < cutoffIso) {
        this.delete(r.task_id);
        n += 1;
      }
    }
    return n;
  }
}
