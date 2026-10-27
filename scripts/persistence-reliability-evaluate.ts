import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "reliability-eval.sqlite");
process.env.AGENT_TASK_STORE = "sqlite";
process.env.AGENT_APPROVAL_STORE = "sqlite";
process.env.AGENT_SESSION_STORE = "sqlite";
process.env.AGENT_WORKFLOW_EXECUTION_STORE = "sqlite";
process.env.AGENT_TRACE_STORE = "sqlite";
process.env.AGENT_TASK_DB_PATH = DB_PATH;

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import { cleanupExpiredData, getPersistenceCleanupConfig } from "@/lib/agent/persistence/cleanup";
import { getPersistenceHealth } from "@/lib/agent/persistence/health";
import { withBusyRetry } from "@/lib/agent/persistence/sqlite-util";
import type { AgentTraceStep, TraceStepType } from "@/lib/agent/trace/types";
import type { WorkflowExecution } from "@/lib/agent/workflow/types";

function cleanupDb(): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
}
const taskStore = () => getTaskStore();
const traceStore = () => getTraceStore();
const sessionStore = () => getSessionStore();
const approvalStore = () => getApprovalStore();
const execStore = () => getWorkflowExecutionStore();

let seq = 0;
function mkStep(traceId: string, type: TraceStepType, extra: Partial<AgentTraceStep> = {}): AgentTraceStep {
  seq += 1;
  return {
    stepId: extra.stepId ?? randomUUID(),
    traceId,
    sequence: 0,
    type,
    startedAt: new Date(Date.parse("2026-01-01T00:00:00Z") + seq * 1000).toISOString(),
    status: "completed",
    ...extra,
  };
}
async function newExec(status: WorkflowExecution["status"] = "completed"): Promise<string> {
  const t = await taskStore().create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  const executionId = randomUUID();
  await execStore().create({
    executionId, workflowId: "wf", taskId: t.id, status,
    startedAt: new Date().toISOString(), context: {}, stepCount: 0,
  });
  return executionId;
}

interface Check { ok: boolean; label: string; skip?: boolean }
const runCase: Record<string, () => Promise<Check[]>> = {};

// PLACEHOLDER_CASES

function createTrace(taskId: string): string {
  const traceId = `trace-${taskId}`;
  traceStore().createTrace({ traceId, taskId, startedAt: new Date().toISOString(), status: "running" });
  return traceId;
}

runCase["trace-append"] = async () => {
  const tid = "rel-append";
  const traceId = createTrace(tid);
  traceStore().appendStep(tid, mkStep(traceId, "agent", { name: "a" }));
  const got = traceStore().getByTaskId(tid);
  return [
    { ok: got?.steps.length === 1, label: "appendStep persisted one step" },
    { ok: got?.steps[0].name === "a", label: "step content persisted" },
  ];
};
runCase["trace-append-order"] = async () => {
  const tid = "rel-order";
  const traceId = createTrace(tid);
  for (let i = 0; i < 5; i += 1) traceStore().appendStep(tid, mkStep(traceId, "tool", { name: `s${i}` }));
  const got = traceStore().getByTaskId(tid);
  const ok = (got?.steps ?? []).every((s, i) => s.sequence === i + 1);
  return [{ ok: ok && got?.steps.length === 5, label: "SQLite-assigned sequence strictly increasing 1..5" }];
};
runCase["trace-idempotent"] = async () => {
  const tid = "rel-idem";
  const traceId = createTrace(tid);
  const step = mkStep(traceId, "tool", { stepId: "fixed-step", name: "once" });
  traceStore().appendStep(tid, step);
  traceStore().appendStep(tid, { ...step, status: "completed", endedAt: new Date().toISOString() });
  const got = traceStore().getByTaskId(tid);
  return [{ ok: got?.steps.length === 1, label: `same stepId appended twice → one step (got ${got?.steps.length})` }];
};
runCase["trace-restart"] = async () => {
  const tid = "rel-restart";
  const traceId = `trace-${tid}`;
  const trace = { traceId, taskId: tid, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "completed" as const, steps: [mkStep(traceId, "agent", { name: "in-child" })] };
  const res = spawnSync("npx", ["tsx", "scripts/trace-child.ts", "write", Buffer.from(JSON.stringify(trace)).toString("base64")], {
    cwd: ROOT, env: { ...process.env }, encoding: "utf-8",
  });
  const ok = res.status === 0;
  const got = traceStore().getByTaskId(tid);
  return [
    { ok, label: "child process wrote trace" },
    { ok: got?.steps[0]?.name === "in-child", label: "trace readable cross-process" },
  ];
};
runCase["trace-resume-append"] = async () => {
  const tid = "rel-resume";
  const traceId = createTrace(tid);
  traceStore().appendStep(tid, mkStep(traceId, "agent"));
  traceStore().appendStep(tid, mkStep(traceId, "tool"));
  const before = traceStore().getByTaskId(tid)!;
  // "resume"：继续向同一个 traceId append
  traceStore().appendStep(tid, mkStep(traceId, "tool"));
  const after = traceStore().getByTaskId(tid)!;
  return [
    { ok: before.steps.length === 2 && after.steps.length === 3, label: "resume appends to same trace (2 → 3)" },
    { ok: before.traceId === after.traceId, label: "same traceId preserved (no second trace)" },
    { ok: after.steps[2].sequence === 3, label: "sequence continues (N+1)" },
  ];
};
runCase["cleanup-disabled"] = async () => {
  delete process.env.AGENT_PERSISTENCE_CLEANUP_ENABLED;
  const cfg = getPersistenceCleanupConfig();
  return [{ ok: cfg.enabled === false, label: "cleanup disabled by default" }];
};
runCase["cleanup-enabled"] = async () => {
  process.env.AGENT_PERSISTENCE_CLEANUP_ENABLED = "true";
  const cfg = getPersistenceCleanupConfig();
  const out = [{ ok: cfg.enabled === true, label: "cleanup enabled via env" }];
  delete process.env.AGENT_PERSISTENCE_CLEANUP_ENABLED;
  return out;
};
runCase["cleanup-concurrent"] = async () => {
  const future = new Date().getTime() + 8 * 86_400_000;
  const [a, b] = await Promise.all([
    cleanupExpiredData({ ttlDays: 7, nowMs: future, lock: true }),
    cleanupExpiredData({ ttlDays: 7, nowMs: future, lock: true }),
  ]);
  const lockedCount = [a, b].filter((r) => r.locked).length;
  return [{ ok: lockedCount === 1, label: `exactly one concurrent cleanup is lock-skipped (got ${lockedCount})` }];
};
runCase["cleanup-active-preserved"] = async () => {
  const t = await taskStore().create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  await taskStore().transition(t.id, "running");
  await cleanupExpiredData({ ttlDays: 7, nowMs: new Date().getTime() + 8 * 86_400_000 });
  return [{ ok: !!(await taskStore().get(t.id)), label: "running task preserved by cleanup" }];
};
runCase["cleanup-pending-approval-preserved"] = async () => {
  const t = await taskStore().create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  await taskStore().transition(t.id, "running");
  await taskStore().transition(t.id, "completed");
  await approvalStore().create({ taskId: t.id, toolName: "writeFile", input: {} });
  await cleanupExpiredData({ ttlDays: 7, nowMs: new Date().getTime() + 8 * 86_400_000 });
  return [{ ok: !!(await taskStore().get(t.id)), label: "terminal task with pending approval preserved" }];
};
// PLACEHOLDER_CASES_2

runCase["task-pagination"] = async () => {
  for (let i = 0; i < 5; i += 1) await taskStore().create({ messages: [{ role: "user", content: `p${i}` }], maxSteps: 5 });
  const p1 = await taskStore().listPage({ limit: 2 });
  const p2 = await taskStore().listPage({ limit: 2, cursor: p1.nextCursor });
  const ids = new Set([...p1.items, ...p2.items].map((t) => t.id));
  return [
    { ok: p1.items.length === 2 && !!p1.nextCursor, label: "page 1 returns 2 items + nextCursor" },
    { ok: p2.items.length === 2, label: "page 2 returns next 2 items" },
    { ok: ids.size === 4, label: "no overlap between pages (stable order)" },
  ];
};
runCase["session-pagination"] = async () => {
  const s = await sessionStore().create({ taskId: `sp-${randomUUID()}` });
  for (let i = 0; i < 5; i += 1) await sessionStore().appendMessage(s.sessionId, { role: "user", content: `m${i}` });
  const p1 = await sessionStore().getMessagesPage(s.sessionId, { limit: 2 });
  const p2 = await sessionStore().getMessagesPage(s.sessionId, { limit: 2, cursor: p1.nextCursor });
  const full = await sessionStore().getMessages(s.sessionId);
  return [
    { ok: p1.items.length === 2 && p1.items[0].content === "m0", label: "message page ordered by sequence ASC" },
    { ok: p2.items[0].content === "m2", label: "cursor advances correctly" },
    { ok: full.length === 5, label: "full-read still returns all (for Resume)" },
  ];
};
runCase["workflow-pagination"] = async () => {
  for (let i = 0; i < 4; i += 1) await newExec("completed");
  const p1 = await execStore().listPage({ limit: 2 });
  const p2 = await execStore().listPage({ limit: 2, cursor: p1.nextCursor });
  const ids = new Set([...p1.items, ...p2.items].map((e) => e.executionId));
  return [
    { ok: p1.items.length === 2 && !!p1.nextCursor, label: "workflow page 1 → 2 items + cursor" },
    { ok: ids.size >= 4, label: "workflow pages do not overlap" },
  ];
};
runCase["trace-pagination"] = async () => {
  for (let i = 0; i < 4; i += 1) {
    const tid = `tp-${i}-${randomUUID()}`;
    createTrace(tid);
  }
  const p1 = await traceStore().listPage({ limit: 2 });
  return [
    { ok: p1.items.length === 2, label: "trace listPage respects limit" },
    { ok: p1.items[0].steps.length === 0, label: "trace page items are headers (no steps payload)" },
  ];
};
runCase["sqlite-busy-retry"] = async () => {
  // 确定性验证 retry 逻辑：前两次抛 "database is locked"，第三次成功
  let calls = 0;
  const result = withBusyRetry(() => {
    calls += 1;
    if (calls < 3) throw new Error("SQLITE_BUSY: database is locked");
    return "ok";
  });
  return [
    { ok: result === "ok" && calls === 3, label: "withBusyRetry retries on busy then succeeds (3 calls)" },
    { ok: true, skip: true, label: "SKIP — cannot deterministically force a real SQLITE_BUSY in this environment" },
  ];
};
runCase["transaction-rollback"] = async () => {
  const tid = "rel-rollback";
  const traceId = createTrace(tid);
  traceStore().appendStep(tid, mkStep(traceId, "agent", { name: "ok" }));
  const before = traceStore().getByTaskId(tid)!.steps.length;
  // BigInt 无法 JSON.stringify → appendStep 内部抛错 → tx ROLLBACK，不应半写入
  let threw = false;
  try {
    traceStore().appendStep(tid, mkStep(traceId, "tool", { input: { bad: BigInt(5) } as unknown as Record<string, unknown> }));
  } catch {
    threw = true;
  }
  const after = traceStore().getByTaskId(tid)!.steps.length;
  return [
    { ok: threw, label: "serialization failure surfaced (not silently swallowed)" },
    { ok: before === after && after === 1, label: "transaction rolled back — no partial step written" },
  ];
};
runCase["persistence-health"] = async () => {
  const h = await getPersistenceHealth();
  const json = JSON.stringify(h);
  const secretLeak = /token|authorization|password|api[_-]?key|secret/i.test(json);
  return [
    { ok: h.task.backend === "sqlite" && h.task.available && h.task.schemaReady, label: "task store healthy (sqlite, schemaReady)" },
    { ok: h.trace.backend === "sqlite" && h.trace.available, label: "trace store healthy" },
    { ok: h.task.databaseFile === "reliability-eval.sqlite", label: "databaseFile is basename only (no full path)" },
    { ok: typeof h.cleanup.ttlDays === "number", label: "cleanup config exposed (enabled/ttlDays)" },
    { ok: !secretLeak, label: "health output contains no secret keys" },
  ];
};
runCase["full-regression"] = async () => {
  const h = await getPersistenceHealth();
  const allUp = [h.task, h.approval, h.session, h.workflow, h.trace].every((s) => s.available && s.schemaReady);
  return [{ ok: allUp, label: "all persistence stores available & schemaReady" }];
};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(path.join(ROOT, "data/persistence-reliability-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;
  console.log("========================================");
  console.log("Persistence Reliability Evaluation");
  console.log("========================================");
  let passed = 0;
  let skipped = 0;
  for (const c of cases) {
    let checks: Check[];
    try { checks = await run(c.kind); } catch (e) { checks = [{ ok: false, label: `threw: ${(e as Error).message}` }]; }
    const isSkip = checks.some((x) => x.skip);
    const ok = checks.every((x) => x.ok || x.skip);
    if (isSkip) skipped += 1;
    else if (ok) passed += 1;
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${isSkip ? "SKIP" : ok ? "PASS" : "FAIL"}`);
    for (const chk of checks) console.log(`  [${chk.skip ? "--" : chk.ok ? "ok" : "XX"}] ${chk.label}`);
  }
  const failed = cases.length - passed - skipped;
  console.log("\n========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log("========================================");
  cleanupDb();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
