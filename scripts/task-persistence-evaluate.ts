import fs from "node:fs/promises";
import path from "node:path";

import { getTaskStore } from "@/lib/agent/task/task-store";
import { createAndRunTask, createAndStartTask } from "@/lib/agent/task/runtime";
import * as eventBus from "@/lib/agent/task/event-bus";
import { applyApprovalDecision } from "@/lib/agent/task/runtime";

const ROOT = process.cwd();
const store = getTaskStore();

async function newTask() {
  return store.create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
}

interface Check {
  ok: boolean;
  label: string;
}

async function runCase(kind: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string) => checks.push({ ok, label });

  switch (kind) {
    case "create": {
      const t = await newTask();
      const got = await store.get(t.id);
      add(!!got && got.id === t.id && got.status === "pending", "create then get returns task (pending)");
      break;
    }
    case "update": {
      const t = await newTask();
      await store.transition(t.id, "running");
      add((await store.get(t.id))?.status === "running", "transition → running reflected by get");
      await store.update(t.id, { currentStep: 3 });
      add((await store.get(t.id))?.currentStep === 3, "update field reflected by get");
      break;
    }
    case "lifecycle": {
      const t = await newTask();
      const seq: Array<"running" | "waiting" | "completed"> = ["running", "waiting", "running", "completed"];
      let allOk = true;
      for (const s of seq) {
        await store.transition(t.id, s);
        if ((await store.get(t.id))?.status !== s) allOk = false;
      }
      add(allOk, "created→running→waiting→running→completed each readable from store");
      break;
    }
    case "failed": {
      const t = await newTask();
      await store.transition(t.id, "running");
      await store.transition(t.id, "failed");
      add((await store.get(t.id))?.status === "failed", "running→failed final state = failed");
      break;
    }
    case "cancelled": {
      const t = await newTask();
      await store.transition(t.id, "running");
      await store.transition(t.id, "cancelled");
      add((await store.get(t.id))?.status === "cancelled", "running→cancelled final state = cancelled");
      break;
    }
    case "delete": {
      const t = await newTask();
      await store.delete(t.id);
      add((await store.get(t.id)) === null, "after delete get returns null");
      break;
    }
    case "list": {
      const a = await newTask();
      const b = await newTask();
      const list = await store.list();
      const ids = new Set(list.map((t) => t.id));
      add(ids.has(a.id) && ids.has(b.id), "list contains created tasks");
      break;
    }
    case "cancel-idempotent": {
      const t = await newTask();
      await store.transition(t.id, "running");
      await store.transition(t.id, "cancelled");
      let threw = false;
      try {
        await store.transition(t.id, "cancelled"); // 重复 cancel
      } catch {
        threw = true;
      }
      add(!threw && (await store.get(t.id))?.status === "cancelled", "repeated cancel is idempotent (no error, stays cancelled)");
      break;
    }
    case "runtime": {
      const { task } = await createAndRunTask({ messages: [{ role: "user", content: "用一句话打个招呼。" }] });
      add((await store.get(task.id))?.status === "completed", "runtime task reaches completed in store");
      break;
    }
    case "approval": {
      const file = "tmp-tp-eval.txt";
      const task = await createAndStartTask({
        messages: [{ role: "user", content: `请用 writeFile 创建文件 ${file}，内容为 hi。只做这一件事。` }],
        maxSteps: 8,
      });
      let sawWaiting = false;
      await new Promise<void>((resolve) => {
        const unsub = eventBus.subscribe(task.id, (e) => {
          if (e.type === "approval.required") {
            void store.get(task.id).then((t) => {
              if (t?.status === "waiting") sawWaiting = true;
              void applyApprovalDecision(task.id, (e.data as { approvalId: string }).approvalId, "approve");
            });
          }
          if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") {
            unsub();
            resolve();
          }
        });
      });
      const finalStatus = (await store.get(task.id))?.status;
      add(sawWaiting, "store shows waiting during approval");
      add(finalStatus === "completed", `store shows completed after approve (got ${finalStatus})`);
      await fs.rm(path.join(ROOT, file), { force: true });
      break;
    }
    default:
      add(false, "unknown kind");
  }
  return checks;
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/task-persistence-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Task Persistence Evaluation");
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
  process.exit(passed === cases.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
