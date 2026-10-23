import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";
import { recoverTasks } from "@/lib/agent/task/recovery";

/**
 * Approval Persistence + Task Resume Evaluation（Phase 10.3）
 *
 * 验证：Approval 状态持久化到 SQLite、跨进程可读、pending→approved/rejected 原子幂等；
 * waiting 任务在「进程重启」后能真正 resume（在新进程里把被批准的工具恰好执行一次），
 * reject 则取消；并确认不会重复副作用。跨进程场景通过 child_process 真实验证。
 */
const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "approval-eval.sqlite");
const CHILD_ENV: Record<string, string> = {
  AGENT_TASK_STORE: "sqlite",
  AGENT_APPROVAL_STORE: "sqlite",
  AGENT_TASK_DB_PATH: DB_PATH,
  AGENT_GIT_PUSH_MODE: "mock",
};

function cleanupDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
}

function taskStore(): SQLiteTaskStore {
  return new SQLiteTaskStore(DB_PATH);
}
function approvalStore(): SQLiteApprovalStore {
  return new SQLiteApprovalStore(DB_PATH);
}

// 启动独立子进程做真实跨进程验证，返回其最后一行 JSON
function spawnChild(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/approval-child.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...CHILD_ENV },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`child exited ${code}: ${err.slice(0, 300)}`));
      }
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

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT }).toString();
}

async function newWaitingTask(): Promise<string> {
  const ts = taskStore();
  const task = await ts.create({
    messages: [{ role: "user", content: "需要审批" }],
    maxSteps: 5,
  });
  await ts.transition(task.id, "running");
  await ts.transition(task.id, "waiting");
  return task.id;
}

interface Check {
  ok: boolean;
  label: string;
}

async function runCase(kind: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (ok: boolean, label: string) => checks.push({ ok, label });

  switch (kind) {
    case "approval-create": {
      const taskId = await newWaitingTask();
      const created = await approvalStore().create({
        taskId,
        toolName: "writeFile",
        input: { path: "tmp-a.txt", content: "hi" },
      });
      // 用「全新 store 实例」读回，验证真的落库而非内存
      const got = await approvalStore().get(created.id);
      add(!!got, "approval persisted; read back by a fresh store instance");
      add(got?.status === "pending", "initial status is pending");
      add(got?.toolName === "writeFile", "toolName persisted");
      add(
        JSON.stringify((got?.input as { path?: string })?.path) === '"tmp-a.txt"',
        "structured input persisted (needed for resume)",
      );
      break;
    }
    case "approval-restart-persistence": {
      // 在独立进程创建 approval，再在本进程读回 —— 真正的跨进程持久化
      const { approvalId } = (await spawnChild(["create-approval", DB_PATH])) as {
        approvalId: string;
      };
      const got = await approvalStore().get(approvalId);
      add(!!got, "approval created in a separate process is readable here");
      add(got?.status === "pending", "survived process boundary as pending");
      break;
    }
    case "approval-approve-persist": {
      const taskId = await newWaitingTask();
      const a = await approvalStore().create({
        taskId,
        toolName: "writeFile",
        input: {},
      });
      const resolved = await approvalStore().resolve(a.id, "approve");
      add(resolved?.status === "approved", "resolve(approve) returns approved");
      const got = await approvalStore().get(a.id);
      add(got?.status === "approved", "approved status persisted across instances");
      add(!!got?.resolvedAt, "resolvedAt timestamp persisted");
      break;
    }
    case "approval-reject-persist": {
      const taskId = await newWaitingTask();
      const a = await approvalStore().create({
        taskId,
        toolName: "writeFile",
        input: {},
      });
      await approvalStore().resolve(a.id, "reject");
      const got = await approvalStore().get(a.id);
      add(got?.status === "rejected", "rejected status persisted across instances");
      add(!!got?.resolvedAt, "resolvedAt timestamp persisted");
      break;
    }
    case "approval-invalid-transition": {
      const taskId = await newWaitingTask();
      const a = await approvalStore().create({ taskId, toolName: "writeFile", input: {} });
      await approvalStore().resolve(a.id, "approve");
      // 已 approved 再 reject → null，状态不变
      const second = await approvalStore().resolve(a.id, "reject");
      add(second === null, "resolving an already-resolved approval returns null");
      add(
        (await approvalStore().get(a.id))?.status === "approved",
        "status stays approved after illegal re-resolve",
      );
      break;
    }
    case "approval-idempotent": {
      const taskId = await newWaitingTask();
      const a = await approvalStore().create({ taskId, toolName: "writeFile", input: {} });
      const first = await approvalStore().resolve(a.id, "approve");
      const again = await approvalStore().resolve(a.id, "approve");
      add(first?.status === "approved" && again === null, "resolve is atomic: only first succeeds (execute-once)");
      break;
    }
    case "recovery-waiting-approval": {
      const taskId = await newWaitingTask();
      await approvalStore().create({ taskId, toolName: "writeFile", input: {} });
      const result = await recoverTasks(taskStore(), approvalStore());
      const got = await taskStore().get(taskId);
      add(got?.status === "waiting", "waiting task WITH pending approval stays waiting (resumable)");
      add(result.keptWaiting >= 1, "recovery result counts it as keptWaiting");
      const evs = await taskStore().getEvents(taskId);
      const rec = evs.find((e) => e.type === "task.recovered");
      add(!!rec && (rec.data as { reason?: string }).reason === "approval_waiting", "task.recovered(approval_waiting) recorded");
      // 幂等：再跑一次不重复发事件
      await recoverTasks(taskStore(), approvalStore());
      const recCount = (await taskStore().getEvents(taskId)).filter((e) => e.type === "task.recovered").length;
      add(recCount === 1, `recovery is idempotent (exactly 1 recovered event, got ${recCount})`);
      break;
    }
    case "recovery-missing-approval": {
      const taskId = await newWaitingTask();
      const result = await recoverTasks(taskStore(), approvalStore());
      const got = await taskStore().get(taskId);
      add(got?.status === "failed", "waiting task WITHOUT pending approval safely ends → failed");
      add(!!got?.error?.message?.includes("no pending approval"), "failure reason: no pending approval");
      add(result.recovered >= 1, "recovery result counts it as recovered(→failed)");
      break;
    }
    case "resume-writeFile": {
      const relPath = "tmp-approval-resume.txt";
      const abs = path.join(ROOT, relPath);
      fs.rmSync(abs, { force: true });
      const input = Buffer.from(
        JSON.stringify({ path: relPath, content: "resumed-after-restart" }),
      ).toString("base64");
      const { taskId, approvalId } = (await spawnChild([
        "setup-waiting",
        DB_PATH,
        "writeFile",
        input,
      ])) as { taskId: string; approvalId: string };
      // 新进程里 approve → resume：把 writeFile 恰好执行一次
      const res = (await spawnChild(["apply", "approve", taskId, approvalId])) as {
        ok?: boolean;
        status?: string;
      };
      add(res.ok === true && res.status === "approved", "apply(approve) in a fresh process succeeded");
      const got = await taskStore().get(taskId);
      add(got?.status === "completed", `task resumed to completed (got ${got?.status})`);
      add(fs.existsSync(abs), "approved writeFile side effect happened after restart");
      add(fs.readFileSync(abs, "utf-8") === "resumed-after-restart", "file content matches approved input");
      const evs = await taskStore().getEvents(taskId);
      const toolDone = evs.filter((e) => e.type === "tool.completed").length;
      add(toolDone === 1, `tool executed exactly once (tool.completed=${toolDone})`);
      fs.rmSync(abs, { force: true });
      break;
    }
    case "resume-gitAdd": {
      const relPath = "tmp-approval-gitadd.txt";
      const abs = path.join(ROOT, relPath);
      fs.writeFileSync(abs, "stage me after restart\n");
      const input = Buffer.from(JSON.stringify({ paths: [relPath] })).toString("base64");
      const { taskId, approvalId } = (await spawnChild([
        "setup-waiting",
        DB_PATH,
        "gitAdd",
        input,
      ])) as { taskId: string; approvalId: string };
      const res = (await spawnChild(["apply", "approve", taskId, approvalId])) as {
        ok?: boolean;
        status?: string;
      };
      add(res.ok === true, "apply(approve) in a fresh process succeeded");
      const got = await taskStore().get(taskId);
      add(got?.status === "completed", `task resumed to completed (got ${got?.status})`);
      const staged = git(["status", "--porcelain=v1"])
        .split("\n")
        .some((l) => l[0] === "A" && l.slice(3) === relPath);
      add(staged, "approved gitAdd staged the file after restart (re-validated by guard)");
      // cleanup：取消暂存并删除临时文件
      git(["reset", "--", relPath]);
      fs.rmSync(abs, { force: true });
      break;
    }
    case "resume-workflow": {
      // Workflow 审批节点的 approval toolName 不是可解析的本地/MCP 工具，
      // 跨进程无法续跑 in-memory 的 WorkflowExecution（技术债务）。
      // 验证：resume 安全失败、不产生副作用、不发 tool.started。
      const input = Buffer.from(JSON.stringify({ reason: "workflow step" })).toString("base64");
      const { taskId, approvalId } = (await spawnChild([
        "setup-waiting",
        DB_PATH,
        "workflow",
        input,
      ])) as { taskId: string; approvalId: string };
      const res = (await spawnChild(["apply", "approve", taskId, approvalId])) as {
        ok?: boolean;
      };
      add(res.ok === true, "apply(approve) returns ok (approval state resolved)");
      const got = await taskStore().get(taskId);
      add(got?.status === "failed", "non-resumable workflow approval ends → failed (honest limitation)");
      add(got?.error?.code === "RESUME_UNSUPPORTED", "failure code RESUME_UNSUPPORTED");
      const evs = await taskStore().getEvents(taskId);
      add(!evs.some((e) => e.type === "tool.started"), "no tool.started: no side effect attempted");
      break;
    }
    case "resume-no-duplicate-side-effect": {
      const relPath = "tmp-approval-once.txt";
      const abs = path.join(ROOT, relPath);
      fs.rmSync(abs, { force: true });
      const input = Buffer.from(
        JSON.stringify({ path: relPath, content: "written-once" }),
      ).toString("base64");
      const { taskId, approvalId } = (await spawnChild([
        "setup-waiting",
        DB_PATH,
        "writeFile",
        input,
      ])) as { taskId: string; approvalId: string };
      await spawnChild(["apply", "approve", taskId, approvalId]);
      const firstMtime = fs.statSync(abs).mtimeMs;
      // 第二个进程再次 approve 同一 approval → 幂等，不应二次写入/二次副作用
      const second = (await spawnChild(["apply", "approve", taskId, approvalId])) as {
        ok?: boolean;
        status?: string;
      };
      add(second.ok === true && second.status === "approved", "second approve is idempotent (returns approved)");
      const evs = await taskStore().getEvents(taskId);
      const toolDone = evs.filter((e) => e.type === "tool.completed").length;
      add(toolDone === 1, `tool.completed stays 1 across duplicate approvals (got ${toolDone})`);
      add(fs.readFileSync(abs, "utf-8") === "written-once", "file content unchanged after duplicate approve");
      add(fs.statSync(abs).mtimeMs === firstMtime, "file not rewritten by duplicate approve (mtime stable)");
      fs.rmSync(abs, { force: true });
      break;
    }
    // PLACEHOLDER_CASES_2
    default:
      add(false, `unknown kind: ${kind}`);
  }

  return checks;
}

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(
    path.join(ROOT, "data/approval-persistence-evaluation.json"),
    "utf-8",
  );
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Approval Persistence + Resume Evaluation");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    let checks: Check[];
    try {
      checks = await runCase(c.kind);
    } catch (e) {
      checks = [{ ok: false, label: `threw: ${(e as Error).message}` }];
    }
    const ok = checks.length > 0 && checks.every((x) => x.ok);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
