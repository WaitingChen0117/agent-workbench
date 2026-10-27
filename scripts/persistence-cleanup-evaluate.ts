import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "cleanup-eval.sqlite");
// 必须在任何 getXStore() 之前设置，使 cleanup 与 setup 使用同一个 SQLite 库
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
import { cleanupExpiredData } from "@/lib/agent/persistence/cleanup";
import { randomUUID } from "node:crypto";
import type { WorkflowStatus } from "@/lib/agent/workflow/types";

function cleanupDb(): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
}

const DAY = 86_400_000;
// 让 cleanup 认为"现在"在未来 8 天：ttl=7 → 所有刚创建的终态数据都过期
const FUTURE = () => new Date().getTime() + 8 * DAY;

const taskStore = () => getTaskStore();
const approvalStore = () => getApprovalStore();
const sessionStore = () => getSessionStore();
const execStore = () => getWorkflowExecutionStore();
const traceStore = () => getTraceStore();

// 创建一个指定终态/非终态的 Task
async function mkTask(to: "completed" | "failed" | "cancelled" | "running" | "waiting"): Promise<string> {
  const t = await taskStore().create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  await taskStore().transition(t.id, "running");
  if (to === "completed") await taskStore().transition(t.id, "completed");
  else if (to === "failed") await taskStore().transition(t.id, "failed");
  else if (to === "cancelled") { await taskStore().transition(t.id, "waiting"); await taskStore().transition(t.id, "cancelled"); }
  else if (to === "waiting") await taskStore().transition(t.id, "waiting");
  return t.id;
}

interface Check { ok: boolean; label: string }
const runCase: Record<string, () => Promise<Check[]>> = {};

// PLACEHOLDER_CASES

async function addWorkflow(taskId: string, status: WorkflowStatus): Promise<void> {
  await execStore().create({
    executionId: randomUUID(),
    workflowId: "wf",
    taskId,
    status,
    startedAt: new Date().toISOString(),
    context: {},
    stepCount: 0,
  });
}

const cleanup = () => cleanupExpiredData({ ttlDays: 7, nowMs: FUTURE() });

runCase["cleanup-expired-completed"] = async () => {
  const id = await mkTask("completed");
  const r = await cleanup();
  return [
    { ok: (await taskStore().get(id)) === null, label: "expired completed task deleted" },
    { ok: r.deletedTasks >= 1, label: `deletedTasks>=1 (got ${r.deletedTasks})` },
  ];
};
runCase["cleanup-expired-failed"] = async () => {
  const id = await mkTask("failed");
  await cleanup();
  return [{ ok: (await taskStore().get(id)) === null, label: "expired failed task deleted" }];
};
runCase["cleanup-expired-cancelled"] = async () => {
  const id = await mkTask("cancelled");
  await cleanup();
  return [{ ok: (await taskStore().get(id)) === null, label: "expired cancelled task deleted" }];
};
runCase["cleanup-keeps-running"] = async () => {
  const id = await mkTask("running");
  await cleanup();
  return [{ ok: !!(await taskStore().get(id)), label: "running task kept (not terminal)" }];
};
runCase["cleanup-keeps-waiting"] = async () => {
  const id = await mkTask("waiting");
  await cleanup();
  return [{ ok: !!(await taskStore().get(id)), label: "waiting task kept" }];
};
runCase["cleanup-keeps-pending-approval"] = async () => {
  const id = await mkTask("completed");
  await approvalStore().create({ taskId: id, toolName: "writeFile", input: {} }); // pending
  await cleanup();
  return [{ ok: !!(await taskStore().get(id)), label: "terminal task WITH pending approval kept (safety guard)" }];
};
runCase["cleanup-keeps-active-workflow"] = async () => {
  const id = await mkTask("completed");
  await addWorkflow(id, "running");
  await cleanup();
  return [{ ok: !!(await taskStore().get(id)), label: "terminal task with active workflow kept" }];
};
runCase["cleanup-keeps-waiting-session"] = async () => {
  const id = await mkTask("completed");
  const s = await sessionStore().create({ taskId: id });
  await sessionStore().update(s.sessionId, { status: "waiting" });
  await cleanup();
  return [{ ok: !!(await taskStore().get(id)), label: "terminal task with waiting session kept" }];
};
runCase["cleanup-trace"] = async () => {
  const id = await mkTask("completed");
  traceStore().putTrace({
    traceId: randomUUID(),
    taskId: id,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    status: "completed",
    steps: [],
  });
  await cleanup();
  return [
    { ok: (await taskStore().get(id)) === null, label: "expired completed task deleted" },
    { ok: traceStore().getByTaskId(id) === null, label: "its trace deleted too" },
  ];
};
runCase["cleanup-idempotent"] = async () => {
  const id = await mkTask("completed");
  await cleanup();
  const r2 = await cleanup();
  return [
    { ok: (await taskStore().get(id)) === null, label: "task stays deleted" },
    { ok: r2.deletedTasks === 0, label: `second cleanup deletes nothing (got ${r2.deletedTasks})` },
  ];
};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(path.join(ROOT, "data/persistence-cleanup-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;
  console.log("========================================");
  console.log("Persistence Cleanup / TTL Evaluation");
  console.log("========================================");
  let passed = 0;
  for (const c of cases) {
    let checks: Check[];
    try { checks = await run(c.kind); } catch (e) { checks = [{ ok: false, label: `threw: ${(e as Error).message}` }]; }
    const ok = checks.length > 0 && checks.every((x) => x.ok);
    if (ok) passed += 1;
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${ok ? "PASS" : "FAIL"}`);
    for (const chk of checks) console.log(`  [${chk.ok ? "ok" : "XX"}] ${chk.label}`);
  }
  console.log("\n========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${cases.length - passed}`);
  console.log(`Success Rate: ${Math.round((passed / cases.length) * 100)}%`);
  cleanupDb();
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
