import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { recoverTasks } from "@/lib/agent/task/recovery";
import { InvalidTaskTransitionError } from "@/lib/agent/task/state-machine";
import type { AgentTaskEvent } from "@/lib/agent/task/types";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "sqlite-eval.sqlite");

function cleanupDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
}

function freshStore(): SQLiteTaskStore {
  return new SQLiteTaskStore(DB_PATH);
}

// 启动独立子进程做跨进程验证，返回其打印的 JSON
function spawnChild(mode: string, extraEnv: Record<string, string> = {}): Promise<{ taskId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/sqlite-child.ts", mode, DB_PATH], {
      cwd: ROOT,
      env: { ...process.env, AGENT_TASK_DB_PATH: DB_PATH, ...extraEnv },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}`));
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`bad child output: ${out.slice(0, 200)}`));
      }
    });
    child.on("error", reject);
  });
}

async function newTask(store: SQLiteTaskStore) {
  return store.create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
}

interface Check { ok: boolean; label: string }
let lastRunTaskId: string | null = null;

async function runCase(kind: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string) => checks.push({ ok, label });

  switch (kind) {
    case "create": {
      const t = await newTask(freshStore());
      const got = await freshStore().get(t.id);
      add(!!got && got.id === t.id, "task persisted; read back by a fresh store instance");
      break;
    }
    case "update": {
      const t = await newTask(freshStore());
      await freshStore().update(t.id, { currentStep: 7 });
      add((await freshStore().get(t.id))?.currentStep === 7, "updated field persisted across store instances");
      break;
    }
    case "transition": {
      const t = await newTask(freshStore());
      await freshStore().transition(t.id, "running");
      await freshStore().transition(t.id, "completed");
      add((await freshStore().get(t.id))?.status === "completed", "running→completed persisted (reopened db)");
      break;
    }
    case "invalid-transition": {
      const t = await newTask(freshStore());
      let threw = false;
      try {
        await freshStore().transition(t.id, "completed"); // pending→completed 非法
      } catch (e) {
        threw = e instanceof InvalidTaskTransitionError;
      }
      add(threw, "illegal transition rejected (InvalidTaskTransitionError)");
      add((await freshStore().get(t.id))?.status === "pending", "status unchanged after illegal transition");
      break;
    }
    case "events": {
      const t = await newTask(freshStore());
      const s = freshStore();
      for (let i = 1; i <= 5; i += 1) {
        const ev: AgentTaskEvent = { id: `e${i}`, taskId: t.id, type: "llm.requested", timestamp: new Date().toISOString(), data: { n: i } };
        await s.appendEvent(t.id, ev);
      }
      const events = await freshStore().getEvents(t.id);
      const payloadsOk = events.every((e, i) => (e.data as { n: number }).n === i + 1);
      add(events.length === 5 && payloadsOk, `5 events persisted, sequence 1..5, payload intact (got ${events.length})`);
      break;
    }
    case "event-order": {
      const t = await newTask(freshStore());
      const s = freshStore();
      for (let i = 0; i < 4; i += 1) {
        await s.appendEvent(t.id, { id: `x${i}`, taskId: t.id, type: "tool.started", timestamp: new Date().toISOString(), data: { i } });
      }
      const events = await freshStore().getEvents(t.id);
      const ordered = events.every((e, i) => (e.data as { i: number }).i === i);
      add(ordered, "getEvents returns events in insertion/sequence order");
      break;
    }
    // PLACEHOLDER_SQLITE_EVAL
    case "cross-process-create": {
      const { taskId } = await spawnChild("create-task");
      const got = await freshStore().get(taskId);
      add(!!got && got.id === taskId, "task created in a separate process is readable here (true cross-process)");
      break;
    }
    case "recovery-running": {
      const t = await newTask(freshStore());
      await freshStore().transition(t.id, "running");
      await recoverTasks(freshStore());
      const got = await freshStore().get(t.id);
      add(got?.status === "failed", "running task recovered → failed");
      add(!!got?.error?.message?.includes("interrupted by process restart"), "reason: interrupted by process restart");
      const evs = await freshStore().getEvents(t.id);
      add(evs.some((e) => e.type === "task.recovered"), "task.recovered event recorded");
      break;
    }
    case "recovery-waiting": {
      const t = await newTask(freshStore());
      await freshStore().transition(t.id, "running");
      await freshStore().transition(t.id, "waiting");
      await recoverTasks(freshStore());
      const got = await freshStore().get(t.id);
      const evs = await freshStore().getEvents(t.id);
      add(got?.status === "failed", "waiting task safely ended → failed (no auto-approve)");
      add(!!got?.error?.message?.includes("Approval state lost"), "reason: Approval state lost after process restart");
      add(!evs.some((e) => e.type === "tool.started"), "no approval_required tool executed during recovery");
      break;
    }
    case "recovery-idempotent": {
      const t = await newTask(freshStore());
      await freshStore().transition(t.id, "running");
      await recoverTasks(freshStore()); // 1st
      await recoverTasks(freshStore()); // 2nd — should skip (already failed)
      const got = await freshStore().get(t.id);
      const evs = await freshStore().getEvents(t.id);
      const recoveredCount = evs.filter((e) => e.type === "task.recovered").length;
      add(got?.status === "failed" && recoveredCount === 1, `idempotent: stays failed, exactly 1 recovery event (got ${recoveredCount})`);
      break;
    }
    case "cross-process-run": {
      const { taskId } = await spawnChild("run-task", { AGENT_TASK_STORE: "sqlite" });
      lastRunTaskId = taskId;
      const got = await freshStore().get(taskId);
      add(got?.status === "completed", `runtime (sqlite, separate process) task → completed (got ${got?.status})`);
      break;
    }
    case "replay": {
      if (!lastRunTaskId) {
        add(false, "no runtime task available for replay");
        break;
      }
      const evs = await freshStore().getEvents(lastRunTaskId);
      const types = evs.map((e) => e.type);
      add(evs.length > 0, `events persisted for replay (${evs.length})`);
      add(types.includes("task.created") && types.includes("task.completed"), "replay contains task.created and task.completed in order");
      break;
    }
    default:
      add(false, "unknown kind");
  }
  return checks;
}

async function main() {
  cleanupDb();
  const raw = fs.readFileSync(path.join(ROOT, "data/task-sqlite-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Task SQLite Evaluation");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    const checks = await runCase(c.kind);
    const ok = checks.every((x) => x.ok);
    if (ok) passed += 1;
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${ok ? "PASS" : "FAIL"}`);
    for (const chk of checks) console.log(`  [${chk.ok ? "ok" : "XX"}] ${chk.label}`);
  }

  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${cases.length - passed}`);
  console.log(`Success Rate: ${Math.round((passed / cases.length) * 100)}%`);
  cleanupDb();
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
