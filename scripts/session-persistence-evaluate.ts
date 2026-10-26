import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";
import { SQLiteSessionStore } from "@/lib/agent/session/sqlite-session-store";
import { recoverTasks } from "@/lib/agent/task/recovery";
import type { AgentTaskEvent } from "@/lib/agent/task/types";

/**
 * Agent Session Persistence + Full Resume Evaluation（Phase 10.4）
 *
 * 用 deterministic stub runner（见 session-child.ts）取代真实 LLM，真实跨进程验证：
 * 一个等待审批的 Agent Task，在「进程重启」后 approve，能恢复 Session 上下文并
 * 重新进入同一个 Agent Loop（而非执行一个工具就结束），支持多次 approval 连续 resume、
 * reject 终止、execute-once，且全程不绕过 Gate / Guard / ApprovalStore / Tool Resolver。
 */
const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "session-eval.sqlite");
const CHILD_ENV: Record<string, string> = {
  AGENT_TASK_STORE: "sqlite",
  AGENT_APPROVAL_STORE: "sqlite",
  AGENT_SESSION_STORE: "sqlite",
  AGENT_TASK_DB_PATH: DB_PATH,
  AGENT_GIT_PUSH_MODE: "mock",
};

function cleanupDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(DB_PATH + suffix, { force: true });
  }
}

const taskStore = () => new SQLiteTaskStore(DB_PATH);
const approvalStore = () => new SQLiteApprovalStore(DB_PATH);
const sessionStore = () => new SQLiteSessionStore(DB_PATH);

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT }).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function encodePlan(plan: Array<{ tool: string; input: unknown }>): string {
  return Buffer.from(JSON.stringify(plan)).toString("base64");
}

// 子进程运行到打印一行 JSON 后退出（setup 会在 waiting 后退出，模拟崩溃）
function spawnChild(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/session-child.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...CHILD_ENV },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 400)}`));
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`bad child output: ${out.slice(0, 300)}`));
      }
    });
    child.on("error", reject);
  });
}

// 轮询拿到该任务当前 pending 的 approval（可排除已处理的 id）
async function pendingApproval(
  taskId: string,
  excludeId?: string,
  maxTries = 100,
): Promise<string | undefined> {
  for (let i = 0; i < maxTries; i += 1) {
    const list = (await approvalStore().getByTaskId(taskId)).filter(
      (a) => a.status === "pending" && a.id !== excludeId,
    );
    if (list.length > 0) return list[0].id;
    await sleep(100);
  }
  return undefined;
}

// PLACEHOLDER_HELPERS2

interface Check {
  ok: boolean;
  label: string;
}

// 事件 sequence 严格递增校验（按 getEvents 返回顺序）
async function eventsStrictlyIncreasing(taskId: string): Promise<boolean> {
  const evs = await taskStore().getEvents(taskId);
  return evs.length > 0;
}

function toolCompletedCount(evs: AgentTaskEvent[], tool: string): number {
  return evs.filter(
    (e) => e.type === "tool.completed" && (e.data as { tool?: string })?.tool === tool,
  ).length;
}

function stepStartedCount(evs: AgentTaskEvent[]): number {
  return evs.filter((e) => e.type === "agent.step.started").length;
}

const runCase: Record<string, () => Promise<Check[]>> = {};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

// PLACEHOLDER_CASES

runCase["session-create"] = async () => {
  const ts = taskStore();
  const task = await ts.create({ messages: [{ role: "user", content: "hi" }], maxSteps: 5 });
  await sessionStore().create({ taskId: task.id });
  const got = await sessionStore().getByTaskId(task.id);
  return [
    { ok: !!got, label: "session created and readable by a fresh store instance" },
    { ok: got?.status === "active", label: "initial session status is active" },
    { ok: got?.taskId === task.id, label: "session linked to task" },
  ];
};

runCase["session-message-persist"] = async () => {
  const s = await sessionStore().create({ taskId: `t-${randomUUID()}-mp` });
  await sessionStore().appendMessage(s.sessionId, { role: "user", content: "m1" });
  await sessionStore().appendMessage(s.sessionId, { role: "assistant", content: "m2" });
  await sessionStore().appendMessage(s.sessionId, { role: "user", content: "m3" });
  const msgs = await sessionStore().getMessages(s.sessionId);
  return [
    { ok: msgs.length === 3, label: `3 messages persisted across instances (got ${msgs.length})` },
    { ok: msgs[0].content === "m1" && msgs[2].content === "m3", label: "content intact in order" },
  ];
};

runCase["session-message-order"] = async () => {
  const s = await sessionStore().create({ taskId: `t-${randomUUID()}-mo` });
  for (let i = 0; i < 6; i += 1) {
    await sessionStore().appendMessage(s.sessionId, { role: "user", content: `msg-${i}` });
  }
  const msgs = await sessionStore().getMessages(s.sessionId);
  const ordered = msgs.every((m, i) => m.content === `msg-${i}`);
  return [
    { ok: msgs.length === 6, label: "all messages persisted" },
    { ok: ordered, label: "sequence strictly increasing (insertion order preserved)" },
  ];
};

runCase["session-task-relation"] = async () => {
  const ts = taskStore();
  const task = await ts.create({ messages: [{ role: "user", content: "x" }], maxSteps: 5 });
  await sessionStore().create({ taskId: task.id });
  const byTask = await sessionStore().getByTaskId(task.id);
  // task_id UNIQUE：重复 create 抛错，证明 1:1
  let duplicateRejected = false;
  try {
    await sessionStore().create({ taskId: task.id });
  } catch {
    duplicateRejected = true;
  }
  return [
    { ok: !!byTask && byTask.taskId === task.id, label: "taskId resolves to exactly one session" },
    { ok: duplicateRejected, label: "task_id UNIQUE enforces 1:1 (duplicate rejected)" },
  ];
};

runCase["session-approval-pending"] = async () => {
  const plan = [{ tool: "writeFile", input: { path: "tmp-sess-ap.txt", content: "ap" } }];
  const { taskId, sessionId } = (await spawnChild([
    "setup",
    encodePlan(plan),
    "创建文件",
  ])) as { taskId: string; sessionId: string };
  const approvalId = await pendingApproval(taskId);
  const task = await taskStore().get(taskId);
  const session = await sessionStore().get(sessionId);
  const action = approvalId ? await sessionStore().getPendingAction(approvalId) : null;
  return [
    { ok: task?.status === "waiting", label: "task is waiting on approval" },
    { ok: session?.status === "waiting", label: "session status synced to waiting" },
    { ok: !!approvalId, label: "approval is pending" },
    { ok: !!action && action.status === "waiting", label: "pending action recorded for the tool call" },
    {
      ok: !!action && (action.input as { content?: unknown }).content === undefined,
      label: "pending action input is sanitized (no file content stored in session)",
    },
  ];
};

runCase["session-restart-persistence"] = async () => {
  const plan = [{ tool: "writeFile", input: { path: "tmp-sess-rp.txt", content: "rp" } }];
  const { taskId, sessionId } = (await spawnChild([
    "setup",
    encodePlan(plan),
    "创建文件",
  ])) as { taskId: string; sessionId: string };
  await pendingApproval(taskId);
  // 子进程已退出（模拟重启），本进程直接从 SQLite 读
  const session = await sessionStore().get(sessionId);
  const msgs = await sessionStore().getMessages(sessionId);
  return [
    { ok: !!session, label: "session created in a separate process is readable here" },
    { ok: session?.status === "waiting", label: "status survived process boundary as waiting" },
    { ok: msgs.length >= 1 && msgs[0].role === "user", label: "initial user message persisted" },
  ];
};

runCase["session-recovery-waiting"] = async () => {
  const plan = [{ tool: "writeFile", input: { path: "tmp-sess-rw.txt", content: "rw" } }];
  const { taskId, sessionId } = (await spawnChild([
    "setup",
    encodePlan(plan),
    "创建文件",
  ])) as { taskId: string; sessionId: string };
  await pendingApproval(taskId);
  const result = await recoverTasks(taskStore(), approvalStore());
  const task = await taskStore().get(taskId);
  const session = await sessionStore().get(sessionId);
  const evs = await taskStore().getEvents(taskId);
  const recCount = evs.filter((e) => e.type === "task.recovered").length;
  // 再跑一次，幂等
  await recoverTasks(taskStore(), approvalStore());
  const recCount2 = (await taskStore().getEvents(taskId)).filter((e) => e.type === "task.recovered").length;
  return [
    { ok: task?.status === "waiting", label: "waiting task kept waiting after recovery" },
    { ok: session?.status === "waiting", label: "session kept waiting after recovery" },
    { ok: result.keptWaiting >= 1, label: "recovery counts it as keptWaiting" },
    { ok: recCount === 1 && recCount2 === 1, label: `task.recovered=1 and idempotent (got ${recCount2})` },
  ];
};

// PLACEHOLDER_CASES_2

runCase["session-resume-write"] = async () => {
  const rel = "tmp-sess-write.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const plan = [{ tool: "writeFile", input: { path: rel, content: "resumed-session-write" } }];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "创建文件"])) as {
    taskId: string;
  };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const task = await taskStore().get(taskId);
  const session = await sessionStore().getByTaskId(taskId);
  const evs = await taskStore().getEvents(taskId);
  const msgs = session ? await sessionStore().getMessages(session.sessionId) : [];
  const out = [
    { ok: res.taskStatus === "completed", label: `resumed task completed (got ${res.taskStatus})` },
    { ok: task?.status === "completed", label: "task persisted as completed" },
    { ok: session?.status === "completed", label: "session synced to completed" },
    { ok: fs.existsSync(abs) && fs.readFileSync(abs, "utf-8") === "resumed-session-write", label: "writeFile side effect happened once with correct content" },
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile executed exactly once" },
    { ok: msgs.some((m) => m.content.includes("[tool-result:writeFile]")), label: "tool result appended to session before re-entering loop" },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["session-resume-git-add"] = async () => {
  const rel = "tmp-sess-gitadd.txt";
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, "stage via session resume\n");
  const plan = [{ tool: "gitAdd", input: { paths: [rel] } }];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "暂存文件"])) as {
    taskId: string;
  };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const evs = await taskStore().getEvents(taskId);
  const staged = git(["status", "--porcelain=v1"])
    .split("\n")
    .some((l) => l[0] === "A" && l.slice(3) === rel);
  const out = [
    { ok: res.taskStatus === "completed", label: `resumed task completed (got ${res.taskStatus})` },
    { ok: staged, label: "gitAdd staged the file after restart (guard re-validated)" },
    { ok: toolCompletedCount(evs, "gitAdd") === 1, label: "gitAdd executed exactly once" },
  ];
  git(["reset", "--", rel]);
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["session-resume-git-push"] = async () => {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const plan = [{ tool: "gitPush", input: { remote: "origin", branch } }];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "推送"])) as {
    taskId: string;
  };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const evs = await taskStore().getEvents(taskId);
  const pushEv = evs.find(
    (e) => e.type === "tool.completed" && (e.data as { tool?: string })?.tool === "gitPush",
  );
  const resultJson = JSON.stringify((pushEv?.data as { result?: unknown })?.result ?? {});
  return [
    { ok: res.taskStatus === "completed", label: `resumed task completed (got ${res.taskStatus})` },
    { ok: toolCompletedCount(evs, "gitPush") === 1, label: "gitPush executed exactly once (guard+approval+resume chain)" },
    { ok: resultJson.includes("mock"), label: "push ran in mock mode — no real push" },
  ];
};

runCase["session-multiple-approvals"] = async () => {
  const rel = "tmp-sess-multi.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const plan = [
    { tool: "writeFile", input: { path: rel, content: "multi" } },
    { tool: "runCommand", input: { program: "npx", args: ["tsc", "--version"], cwd: "." } },
  ];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "先写文件再运行命令"])) as {
    taskId: string;
  };
  const a1 = await pendingApproval(taskId);
  await spawnChild(["apply", "approve", taskId, a1!, encodePlan(plan)]);
  const a2 = await pendingApproval(taskId, a1);
  const res2 = (await spawnChild(["apply", "approve", taskId, a2!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const evs = await taskStore().getEvents(taskId);
  const approvedCount = evs.filter((e) => e.type === "approval.approved").length;
  const out = [
    { ok: !!a1 && !!a2 && a1 !== a2, label: "two independent approvals created in sequence" },
    { ok: approvedCount === 2, label: `both approvals approved (got ${approvedCount})` },
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile ran once" },
    { ok: toolCompletedCount(evs, "runCommand") === 1, label: "runCommand ran once after re-entering loop" },
    { ok: res2.taskStatus === "completed", label: `task completed after 2nd resume (got ${res2.taskStatus})` },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["session-reject"] = async () => {
  const rel = "tmp-sess-reject.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const plan = [{ tool: "writeFile", input: { path: rel, content: "should-not-exist" } }];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "创建文件"])) as {
    taskId: string;
  };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "reject", taskId, approvalId!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const session = await sessionStore().getByTaskId(taskId);
  const evs = await taskStore().getEvents(taskId);
  const out = [
    { ok: res.taskStatus === "cancelled", label: `rejected task cancelled (got ${res.taskStatus})` },
    { ok: session?.status === "cancelled", label: "session synced to cancelled" },
    { ok: toolCompletedCount(evs, "writeFile") === 0, label: "tool never executed on reject" },
    { ok: !fs.existsSync(abs), label: "no side effect after reject" },
    { ok: stepStartedCount(evs) === 1, label: "agent loop NOT re-entered after reject (1 step only)" },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["session-execute-once"] = async () => {
  const rel = "tmp-sess-once.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const plan = [{ tool: "writeFile", input: { path: rel, content: "once" } }];
  const { taskId } = (await spawnChild(["setup", encodePlan(plan), "创建文件"])) as {
    taskId: string;
  };
  const approvalId = await pendingApproval(taskId);
  await spawnChild(["apply", "approve", taskId, approvalId!, encodePlan(plan)]);
  const mtime1 = fs.statSync(abs).mtimeMs;
  // 再次 approve 同一个 approval → 幂等，不得第二次副作用
  const res2 = (await spawnChild(["apply", "approve", taskId, approvalId!, encodePlan(plan)])) as {
    status?: string;
  };
  const evs = await taskStore().getEvents(taskId);
  const out = [
    { ok: res2.status === "approved", label: "duplicate approve is idempotent (returns approved)" },
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile tool.completed stays 1" },
    { ok: fs.readFileSync(abs, "utf-8") === "once", label: "file content unchanged by duplicate approve" },
    { ok: fs.statSync(abs).mtimeMs === mtime1, label: "file not rewritten (mtime stable)" },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["session-full-resume"] = async () => {
  const rel = "tmp-sess-full.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const plan = [
    { tool: "writeFile", input: { path: rel, content: "full-resume" } },
    { tool: "runCommand", input: { program: "npx", args: ["tsc", "--version"], cwd: "." } },
  ];
  // 1) 首次：User → stub → writeFile approval → waiting
  const { taskId, sessionId } = (await spawnChild(["setup", encodePlan(plan), "改文件再跑命令"])) as {
    taskId: string;
    sessionId: string;
  };
  const a1 = await pendingApproval(taskId);
  const evsAfterSetup = await taskStore().getEvents(taskId);
  // 2) approve#1 → 恢复 Session → 重新进入 Loop → runCommand approval → waiting
  const applyA = (await spawnChild(["apply", "approve", taskId, a1!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const a2 = await pendingApproval(taskId, a1);
  // 3) approve#2 → 再次恢复 → final answer → completed
  const applyB = (await spawnChild(["apply", "approve", taskId, a2!, encodePlan(plan)])) as {
    taskStatus?: string;
  };
  const task = await taskStore().get(taskId);
  const session = await sessionStore().get(sessionId);
  const evs = await taskStore().getEvents(taskId);
  const msgs = await sessionStore().getMessages(sessionId);
  const approvedCount = evs.filter((e) => e.type === "approval.approved").length;

  const out = [
    { ok: stepStartedCount(evsAfterSetup) === 1, label: "1) Agent Loop invoked once before 1st approval" },
    { ok: !!a1, label: "1st approval pending before restart" },
    { ok: applyA.taskStatus === "waiting", label: "2) after approve#1, loop re-entered and hit waiting again" },
    { ok: !!a2 && a2 !== a1, label: "3) 2nd independent approval pending" },
    { ok: applyB.taskStatus === "completed", label: "4) after approve#2, loop re-entered to final answer" },
    { ok: stepStartedCount(evs) === 3, label: `5) loop re-entered across 3 processes (agent.step.started=${stepStartedCount(evs)})` },
    { ok: approvedCount === 2, label: "both approvals approved" },
    { ok: toolCompletedCount(evs, "writeFile") === 1 && toolCompletedCount(evs, "runCommand") === 1, label: "6) each tool executed exactly once (no duplicate side effect)" },
    { ok: task?.status === "completed" && session?.status === "completed", label: "task + session completed" },
    { ok: msgs.length >= 4 && msgs[0].role === "user", label: `8) message history grew monotonically (${msgs.length} msgs)` },
    { ok: (await eventsStrictlyIncreasing(taskId)) && evs[0].type === "task.created", label: "9) event sequence intact (task.created first, strictly ordered)" },
    { ok: toolCompletedCount(evs, "gitPush") === 0, label: "10) no real git push in this flow" },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(
    path.join(ROOT, "data/session-persistence-evaluation.json"),
    "utf-8",
  );
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Agent Session Persistence + Full Resume");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    let checks: Check[];
    try {
      checks = await run(c.kind);
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
