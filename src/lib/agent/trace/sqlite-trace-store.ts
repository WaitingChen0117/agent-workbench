import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redactSecrets } from "@/lib/agent/trace/sanitize";
import type {
  AgentTrace,
  AgentTraceStep,
  TraceStatus,
  TraceStepType,
} from "@/lib/agent/trace/types";
import type { TraceStore } from "@/lib/agent/trace/trace-store";

/**
 * SQLiteTraceStore —— 复用 Task 的同一个 SQLite 库（AGENT_TASK_DB_PATH）。
 * agent_traces 存 Trace 头，agent_trace_steps 存各步（sequence 严格递增，ORDER BY sequence replay）。
 * 持久化前对 input/output 再跑一次 redactSecrets（SQLite 本身即敏感边界，不只依赖 UI 脱敏）。
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

  putTrace(trace: AgentTrace): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO agent_traces (task_id, trace_id, started_at, ended_at, status)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             trace_id = excluded.trace_id,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             status = excluded.status`,
        )
        .run(
          trace.taskId,
          trace.traceId,
          trace.startedAt,
          trace.endedAt ?? null,
          trace.status,
        );
      // 全量重写该 trace 的 steps（step 数量有限，且每步会多次更新状态）
      this.db.prepare("DELETE FROM agent_trace_steps WHERE trace_id = ?").run(trace.traceId);
      const insert = this.db.prepare(
        `INSERT INTO agent_trace_steps
         (step_id, trace_id, task_id, sequence, type, name, started_at, ended_at, duration_ms, status, input, output, usage, workflow_id, execution_id, node_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of trace.steps) {
        insert.run(
          s.stepId,
          s.traceId,
          trace.taskId,
          s.sequence,
          s.type,
          s.name ?? null,
          s.startedAt,
          s.endedAt ?? null,
          s.durationMs ?? null,
          s.status,
          s.input !== undefined ? JSON.stringify(redactSecrets(s.input)) : null,
          s.output !== undefined ? JSON.stringify(redactSecrets(s.output)) : null,
          s.usage !== undefined ? JSON.stringify(s.usage) : null,
          s.workflowId ?? null,
          s.executionId ?? null,
          s.nodeId ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      .prepare(
        "SELECT * FROM agent_trace_steps WHERE execution_id = ? AND node_id = ? ORDER BY sequence ASC",
      )
      .all(executionId, nodeId) as StepRow[];
    return rows.map(toStep);
  }

  delete(taskId: string): void {
    const header = this.db
      .prepare("SELECT trace_id FROM agent_traces WHERE task_id = ?")
      .get(taskId) as { trace_id?: string } | undefined;
    this.db.prepare("DELETE FROM agent_traces WHERE task_id = ?").run(taskId);
    if (header?.trace_id) {
      this.db.prepare("DELETE FROM agent_trace_steps WHERE trace_id = ?").run(header.trace_id);
    }
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
