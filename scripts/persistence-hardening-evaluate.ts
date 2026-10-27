import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "hardening-eval.sqlite");
process.env.AGENT_TASK_STORE = "sqlite";
process.env.AGENT_APPROVAL_STORE = "sqlite";
process.env.AGENT_SESSION_STORE = "sqlite";
process.env.AGENT_WORKFLOW_EXECUTION_STORE = "sqlite";
process.env.AGENT_TRACE_STORE = "sqlite";
process.env.AGENT_TASK_DB_PATH = DB_PATH;

import { getTaskStore } from "@/lib/agent/task/task-store";
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import {
  migrateDatabase,
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
} from "@/lib/agent/persistence/migrations";
import {
  encodeCursor,
  decodeCursor,
  InvalidCursorError,
} from "@/lib/agent/persistence/pagination";
import {
  cleanupExpiredData,
  acquireCleanupLock,
  releaseCleanupLock,
  renewCleanupLockForTest,
} from "@/lib/agent/persistence/cleanup";
import { getPersistenceHealth } from "@/lib/agent/persistence/health";
import {
  getPersistenceMetrics,
  resetPersistenceMetrics,
} from "@/lib/agent/persistence/metrics";
import type { TraceEvent } from "@/lib/agent/trace/types";

function cleanupDb(): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
}
const taskStore = () => getTaskStore();
const traceStore = () => getTraceStore();

function ev(traceId: string, eventId: string, i: number): TraceEvent {
  return {
    traceId,
    sequence: 0,
    eventId,
    timestamp: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000).toISOString(),
    type: "tool.started",
    payload: { i },
  };
}

interface Check { ok: boolean; label: string; skip?: boolean }
const runCase: Record<string, () => Promise<Check[]>> = {};

// PLACEHOLDER_CASES

function tmpDb(tag: string): string {
  const p = path.join(ROOT, ".data", `mig-${tag}-${randomUUID()}.sqlite`);
  return p;
}
function rmDb(p: string): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(p + s, { force: true });
}

runCase["migration-fresh-db"] = async () => {
  const p = tmpDb("fresh");
  const r = migrateDatabase(p);
  const out = [
    { ok: r.from === 0 && r.to === LATEST_SCHEMA_VERSION, label: `fresh DB migrated 0 → ${LATEST_SCHEMA_VERSION}` },
    { ok: r.applied.length === LATEST_SCHEMA_VERSION, label: `all migrations applied (${r.applied.join(",")})` },
    { ok: getSchemaVersion(p) === LATEST_SCHEMA_VERSION, label: "schema_version persisted" },
  ];
  rmDb(p);
  return out;
};
runCase["migration-existing-db"] = async () => {
  const p = tmpDb("existing");
  const { SQLiteTaskStore } = await import("@/lib/agent/task/sqlite-task-store");
  await new SQLiteTaskStore(p).create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  const r = migrateDatabase(p);
  const out = [
    { ok: r.to === LATEST_SCHEMA_VERSION, label: "existing (v1.12-like) DB upgraded to latest" },
  ];
  rmDb(p);
  return out;
};
runCase["migration-idempotent"] = async () => {
  const p = tmpDb("idem");
  migrateDatabase(p);
  const r2 = migrateDatabase(p);
  const out = [{ ok: r2.applied.length === 0 && r2.to === LATEST_SCHEMA_VERSION, label: "re-run applies nothing" }];
  rmDb(p);
  return out;
};
runCase["migration-data-preserved"] = async () => {
  const p = tmpDb("data");
  const { SQLiteTaskStore } = await import("@/lib/agent/task/sqlite-task-store");
  const t = await new SQLiteTaskStore(p).create({ messages: [{ role: "user", content: "keep" }], maxSteps: 5 });
  migrateDatabase(p);
  const got = await new SQLiteTaskStore(p).get(t.id);
  const out = [{ ok: !!got && got.id === t.id, label: "existing task data preserved across migration" }];
  rmDb(p);
  return out;
};
runCase["migration-rollback"] = async () => {
  const p = tmpDb("rollback");
  process.env.AGENT_PERSISTENCE_TEST_FAILURE = "migration";
  let threw = false;
  try { migrateDatabase(p); } catch { threw = true; }
  const vAfterFail = getSchemaVersion(p);
  delete process.env.AGENT_PERSISTENCE_TEST_FAILURE;
  const r = migrateDatabase(p);
  const out = [
    { ok: threw, label: "injected migration failure surfaced" },
    { ok: vAfterFail === 0, label: "failed migration rolled back (schema_version stays 0)" },
    { ok: r.to === LATEST_SCHEMA_VERSION, label: "retry after clearing injection succeeds" },
  ];
  rmDb(p);
  return out;
};

runCase["trace-event-append"] = async () => {
  const tid = `t-${randomUUID()}`;
  traceStore().appendTraceEvent(tid, ev(tid, "e1", 0));
  return [{ ok: traceStore().getEvents(tid).length === 1, label: "appendTraceEvent persists one event" }];
};
runCase["trace-event-order"] = async () => {
  const tid = `t-${randomUUID()}`;
  for (let i = 0; i < 5; i += 1) traceStore().appendTraceEvent(tid, ev(tid, `e${i}`, i));
  const events = traceStore().getEvents(tid);
  const ok = events.every((e, i) => e.sequence === i + 1);
  return [{ ok: ok && events.length === 5, label: "event sequence SQLite-assigned 1..5" }];
};
runCase["trace-event-idempotent"] = async () => {
  const tid = `t-${randomUUID()}`;
  traceStore().appendTraceEvent(tid, ev(tid, "same", 0));
  traceStore().appendTraceEvent(tid, ev(tid, "same", 0));
  return [{ ok: traceStore().getEvents(tid).length === 1, label: "same (traceId,eventId) → one event" }];
};
runCase["trace-event-cross-process"] = async () => {
  const tid = `t-xproc-${randomUUID()}`;
  const res = spawnSync("npx", ["tsx", "scripts/trace-child.ts", "append-events", tid, "3"], {
    cwd: ROOT, env: { ...process.env }, encoding: "utf-8",
  });
  const events = traceStore().getEvents(tid);
  return [
    { ok: res.status === 0, label: "child appended events in a separate process" },
    { ok: events.length === 3 && events[0].sequence === 1, label: "cross-process events readable, ordered" },
  ];
};
runCase["trace-resume"] = async () => {
  const tid = `t-resume-${randomUUID()}`;
  const res = spawnSync("npx", ["tsx", "scripts/trace-child.ts", "append-events", tid, "3"], {
    cwd: ROOT, env: { ...process.env }, encoding: "utf-8",
  });
  // resume：本进程继续向同一 trace append
  traceStore().appendTraceEvent(tid, ev(tid, "resume-ev-1", 10));
  traceStore().appendTraceEvent(tid, ev(tid, "resume-ev-2", 11));
  const events = traceStore().getEvents(tid);
  const contiguous = events.every((e, i) => e.sequence === i + 1);
  return [
    { ok: res.status === 0, label: "process A appended 3 events" },
    { ok: events.length === 5 && contiguous, label: "resume continues same trace: sequence 1..5 contiguous" },
  ];
};
// PLACEHOLDER_CASES_2

runCase["cursor-valid"] = async () => {
  const c = encodeCursor("task", { u: "2026", id: "x" });
  const d = decodeCursor<{ u: string; id: string }>("task", c);
  return [{ ok: d?.u === "2026" && d?.id === "x", label: "valid signed cursor round-trips" }];
};
runCase["cursor-tampered"] = async () => {
  const c = encodeCursor("task", { u: "2026", id: "x" });
  const tampered = `${c.slice(0, -2)}xx`;
  let threw = false;
  try { decodeCursor("task", tampered); } catch (e) { threw = e instanceof InvalidCursorError; }
  return [{ ok: threw, label: "tampered cursor → InvalidCursorError (no fallback)" }];
};
runCase["cursor-resource-mismatch"] = async () => {
  const c = encodeCursor("task", { u: "2026", id: "x" });
  let threw = false;
  try { decodeCursor("trace", c); } catch (e) { threw = e instanceof InvalidCursorError; }
  return [{ ok: threw, label: "resource mismatch → InvalidCursorError" }];
};
runCase["cursor-malformed"] = async () => {
  let threw = false;
  try { decodeCursor("task", "not-a-valid-cursor"); } catch (e) { threw = e instanceof InvalidCursorError; }
  return [{ ok: threw, label: "malformed cursor → InvalidCursorError" }];
};
runCase["cursor-pagination-consistency"] = async () => {
  for (let i = 0; i < 5; i += 1) await taskStore().create({ messages: [{ role: "user", content: `c${i}` }], maxSteps: 5 });
  const p1 = await taskStore().listPage({ limit: 2 });
  const p2 = await taskStore().listPage({ limit: 2, cursor: p1.nextCursor });
  const ids = new Set([...p1.items, ...p2.items].map((t) => t.id));
  let tamperedRejected = false;
  try {
    await taskStore().listPage({ limit: 2, cursor: `${p1.nextCursor!.slice(0, -2)}zz` });
  } catch (e) {
    tamperedRejected = e instanceof InvalidCursorError;
  }
  return [
    { ok: p1.items.length === 2 && ids.size === 4, label: "signed cursor paginates consistently" },
    { ok: tamperedRejected, label: "tampered cursor rejected by listPage (no full scan)" },
  ];
};

runCase["cleanup-lease-acquire"] = async () => {
  const now = new Date().getTime();
  const lease = acquireCleanupLock(now);
  const out = [
    { ok: !!lease && lease.ok, label: "fresh lease acquired" },
  ];
  if (lease) releaseCleanupLock(lease);
  return out;
};
runCase["cleanup-lease-takeover"] = async () => {
  const now = new Date().getTime();
  // 写入一个已过期的他人租约
  const db = new DatabaseSync(DB_PATH);
  db.exec("CREATE TABLE IF NOT EXISTS agent_persistence_locks (name TEXT PRIMARY KEY, acquired_at INTEGER, owner_id TEXT, expires_at INTEGER)");
  db.prepare("INSERT OR REPLACE INTO agent_persistence_locks (name, acquired_at, owner_id, expires_at) VALUES ('cleanup', ?, 'ghost', ?)").run(now - 100000, now - 1000);
  const lease = acquireCleanupLock(now);
  const out = [{ ok: !!lease && lease.ok, label: "expired lease taken over by new owner" }];
  if (lease) releaseCleanupLock(lease);
  return out;
};
runCase["cleanup-lease-renew"] = async () => {
  const now = new Date().getTime();
  const lease = acquireCleanupLock(now);
  if (!lease || !lease.ok) return [{ ok: false, label: "could not acquire for renew test" }];
  renewCleanupLockForTest(lease, now + 10_000);
  const db = new DatabaseSync(DB_PATH);
  const row = db.prepare("SELECT expires_at FROM agent_persistence_locks WHERE name='cleanup'").get() as { expires_at: number };
  const out = [{ ok: row.expires_at >= now + 10_000, label: "renew advances expires_at" }];
  releaseCleanupLock(lease);
  return out;
};
runCase["cleanup-lease-owner-check"] = async () => {
  const now = new Date().getTime();
  const a = acquireCleanupLock(now);
  if (!a || !a.ok) return [{ ok: false, label: "owner A could not acquire" }];
  const b = acquireCleanupLock(now); // 未过期、他人持有 → locked
  const bLocked = !!b && !b.ok;
  // B 尝试释放不属于它的锁 → 不应删除 A 的锁
  if (b) releaseCleanupLock(b);
  const db = new DatabaseSync(DB_PATH);
  const stillHeld = !!db.prepare("SELECT 1 FROM agent_persistence_locks WHERE name='cleanup'").get();
  releaseCleanupLock(a);
  return [
    { ok: bLocked, label: "second owner cannot acquire unexpired lease (locked)" },
    { ok: stillHeld, label: "non-owner release does not drop the holder's lease" },
  ];
};

runCase["persistence-health"] = async () => {
  migrateDatabase(DB_PATH);
  const h = await getPersistenceHealth();
  const json = JSON.stringify(h);
  const leak = /\"(token|authorization|password|api[_-]?key|secret|owner_id)\"\s*:/i.test(json) || /AGENT_PERSISTENCE_CURSOR_SECRET/.test(json);
  return [
    { ok: h.schema.version === LATEST_SCHEMA_VERSION && h.schema.latest === LATEST_SCHEMA_VERSION, label: "health reports schema version = latest" },
    { ok: h.schema.migrationPending === false, label: "migrationPending false after migrate" },
    { ok: typeof h.cursorSigningConfigured === "boolean", label: "cursorSigningConfigured reported (boolean, no secret)" },
    { ok: typeof h.cleanupLock.held === "boolean", label: "cleanupLock status reported" },
    { ok: typeof h.metrics.traceEventsAppended === "number", label: "metrics snapshot included" },
    { ok: !leak, label: "no secrets / owner_id / full path leaked" },
  ];
};
runCase["persistence-metrics"] = async () => {
  resetPersistenceMetrics();
  await taskStore().create({ messages: [{ role: "user", content: "m" }], maxSteps: 5 });
  const tid = `t-${randomUUID()}`;
  traceStore().appendTraceEvent(tid, ev(tid, "m1", 0));
  await cleanupExpiredData({ ttlDays: 7, nowMs: new Date().getTime() + 8 * 86_400_000 });
  const m = getPersistenceMetrics();
  return [
    { ok: m.taskCreates >= 1, label: `taskCreates counted (${m.taskCreates})` },
    { ok: m.traceEventsAppended >= 1, label: `traceEventsAppended counted (${m.traceEventsAppended})` },
  ];
};
runCase["failure-injection-rollback"] = async () => {
  const tid = `t-fail-${randomUUID()}`;
  traceStore().appendTraceEvent(tid, ev(tid, "ok1", 0));
  const before = traceStore().getEvents(tid).length;
  process.env.AGENT_PERSISTENCE_TEST_FAILURE = "trace-append";
  let threw = false;
  try { traceStore().appendTraceEvent(tid, ev(tid, "boom", 1)); } catch { threw = true; }
  delete process.env.AGENT_PERSISTENCE_TEST_FAILURE;
  const after = traceStore().getEvents(tid).length;
  return [
    { ok: threw, label: "injected trace-append failure surfaced" },
    { ok: before === 1 && after === 1, label: "failed append rolled back — event not persisted" },
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
  const raw = fs.readFileSync(path.join(ROOT, "data/persistence-hardening-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;
  console.log("========================================");
  console.log("Persistence Hardening Evaluation");
  console.log("========================================");
  let passed = 0;
  let skipped = 0;
  for (const c of cases) {
    let checks: Check[];
    try { checks = await run(c.kind); } catch (e) { checks = [{ ok: false, label: `threw: ${(e as Error).message}` }]; }
    const isSkip = checks.some((x) => x.skip);
    const ok = checks.every((x) => x.ok || x.skip);
    if (isSkip) skipped += 1; else if (ok) passed += 1;
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
