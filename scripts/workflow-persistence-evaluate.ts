import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";
import { SQLiteWorkflowExecutionStore } from "@/lib/agent/workflow/sqlite-execution-store";
import { recoverTasks } from "@/lib/agent/task/recovery";
import type { AgentTaskEvent } from "@/lib/agent/task/types";
import type { WorkflowDefinition, WorkflowExecution } from "@/lib/agent/workflow/types";

/**
 * Workflow Execution Persistence + Full Workflow Resume Evaluation（Phase 10.5）
 *
 * 真实跨进程（child_process）验证：一个运行到 approval waiting 的 Workflow，
 * 在 Process A 退出后，Process B 从 SQLite 恢复 Task/Execution/NodeExecution/Approval/Context，
 * approve 后重跑 Guard、执行被批准工具一次、从正确节点续跑 DAG，已完成节点/Condition 不重复。
 */
const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "workflow-eval.sqlite");
const CHILD_ENV: Record<string, string> = {
  AGENT_TASK_STORE: "sqlite",
  AGENT_APPROVAL_STORE: "sqlite",
  AGENT_SESSION_STORE: "sqlite",
  AGENT_WORKFLOW_EXECUTION_STORE: "sqlite",
  AGENT_TASK_DB_PATH: DB_PATH,
  AGENT_GIT_PUSH_MODE: "mock",
};

function cleanupDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
}

const taskStore = () => new SQLiteTaskStore(DB_PATH);
const approvalStore = () => new SQLiteApprovalStore(DB_PATH);
const execStore = () => new SQLiteWorkflowExecutionStore(DB_PATH);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function enc(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64");
}

function spawnChild(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/workflow-child.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...CHILD_ENV },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 500)}`));
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

async function pendingApproval(taskId: string, exclude?: string, maxTries = 100): Promise<string | undefined> {
  for (let i = 0; i < maxTries; i += 1) {
    const list = (await approvalStore().getByTaskId(taskId)).filter(
      (a) => a.status === "pending" && a.id !== exclude,
    );
    if (list.length > 0) return list[0].id;
    await sleep(100);
  }
  return undefined;
}

// PLACEHOLDER_HELPERS

interface Check {
  ok: boolean;
  label: string;
}

function nodeStartedCount(evs: AgentTaskEvent[], nodeId: string): number {
  return evs.filter(
    (e) =>
      e.type === "workflow.node.started" &&
      (e.data as { nodeId?: string })?.nodeId === nodeId,
  ).length;
}
function toolCompletedCount(evs: AgentTaskEvent[], tool: string): number {
  return evs.filter(
    (e) => e.type === "tool.completed" && (e.data as { tool?: string })?.tool === tool,
  ).length;
}

// 工作流定义构造器 -------------------------------------------------------------
function singleToolWf(id: string, tool: string, input: unknown): WorkflowDefinition {
  return {
    id,
    name: id,
    version: "1",
    nodes: [
      { id: "t", type: "tool", config: { tool, input, output: `${tool}Result` } },
      { id: "e", type: "end" },
    ],
    edges: [{ source: "t", target: "e" }],
  };
}

const runCase: Record<string, () => Promise<Check[]>> = {};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

function sampleExecution(taskId: string): WorkflowExecution {
  return {
    executionId: randomUUID(),
    workflowId: "wf-sample",
    taskId,
    status: "running",
    startedAt: new Date().toISOString(),
    context: {},
    stepCount: 0,
  };
}

// PLACEHOLDER_CASES

runCase["workflow-create"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  const exec = sampleExecution(task.id);
  await execStore().create(exec);
  const got = await execStore().get(exec.executionId);
  return [
    { ok: !!got, label: "execution created and readable by a fresh store instance" },
    { ok: got?.status === "running", label: "initial status persisted" },
    { ok: got?.taskId === task.id, label: "linked to task" },
  ];
};

runCase["workflow-persist"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  const exec = sampleExecution(task.id);
  await execStore().create(exec);
  await execStore().update(exec.executionId, { status: "completed", context: { a: 1 }, currentNodeId: "n2" });
  const got = await execStore().get(exec.executionId);
  return [
    { ok: got?.status === "completed", label: "status update persisted across instances" },
    { ok: (got?.context as { a?: number })?.a === 1, label: "context persisted (JSON roundtrip)" },
    { ok: got?.currentNodeId === "n2", label: "currentNodeId persisted" },
  ];
};

runCase["workflow-node-persist"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  const exec = sampleExecution(task.id);
  await execStore().create(exec);
  await execStore().upsertNode({
    executionId: exec.executionId,
    nodeId: "n1",
    nodeType: "tool",
    status: "completed",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    result: { ok: true },
    attempt: 1,
  });
  const got = await execStore().getNode(exec.executionId, "n1");
  return [
    { ok: got?.status === "completed", label: "node execution persisted" },
    { ok: (got?.result as { ok?: boolean })?.ok === true, label: "node result persisted (JSON roundtrip)" },
    { ok: got?.attempt === 1, label: "attempt defaults to 1" },
  ];
};

runCase["workflow-context-persist"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  const exec = sampleExecution(task.id);
  await execStore().create(exec);
  await execStore().update(exec.executionId, { context: { searchResult: { files: ["a.ts"] }, nested: { x: [1, 2] } } });
  const got = await execStore().get(exec.executionId);
  const ctx = got?.context as { searchResult?: { files?: string[] }; nested?: { x?: number[] } };
  return [
    { ok: ctx?.searchResult?.files?.[0] === "a.ts", label: "tool result context persisted" },
    { ok: ctx?.nested?.x?.length === 2, label: "nested JSON structure recovered correctly" },
  ];
};

runCase["workflow-node-order"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  const exec = sampleExecution(task.id);
  await execStore().create(exec);
  for (let i = 0; i < 4; i += 1) {
    await execStore().upsertNode({
      executionId: exec.executionId,
      nodeId: `n${i}`,
      nodeType: "tool",
      status: "completed",
      startedAt: new Date(Date.parse("2026-01-01T00:00:0" + i + "Z")).toISOString(),
      attempt: 1,
    });
  }
  const nodes = await execStore().listNodes(exec.executionId);
  const ordered = nodes.every((n, i) => n.nodeId === `n${i}`);
  return [
    { ok: nodes.length === 4, label: "all node executions persisted" },
    { ok: ordered, label: "listNodes returns nodes in started order" },
  ];
};

runCase["workflow-restart-persistence"] = async () => {
  const rel = "tmp-wf-restart.txt";
  const def = singleToolWf("wf-restart", "writeFile", { path: rel, content: "x" });
  const { taskId, executionId } = (await spawnChild(["setup", enc(def)])) as {
    taskId: string;
    executionId: string;
  };
  await pendingApproval(taskId);
  const exec = await execStore().get(executionId);
  const nodes = await execStore().listNodes(executionId);
  const task = await taskStore().get(taskId);
  const waitingNode = nodes.find((n) => n.status === "waiting");
  return [
    { ok: !!exec, label: "execution created in a separate process is readable here" },
    { ok: exec?.status === "waiting", label: "execution persisted as waiting across process boundary" },
    { ok: task?.status === "waiting", label: "task persisted as waiting" },
    { ok: !!waitingNode && !!waitingNode.approvalId, label: "waiting node persisted with approvalId link" },
  ];
};

runCase["recovery-running"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  await taskStore().transition(task.id, "running");
  const exec = { ...sampleExecution(task.id), status: "running" as const };
  await execStore().create(exec);
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const e2 = await execStore().get(exec.executionId);
  const t2 = await taskStore().get(task.id);
  const evs = await taskStore().getEvents(task.id);
  const rec = evs.find((e) => e.type === "task.recovered");
  return [
    { ok: e2?.status === "failed", label: "running workflow recovered → failed (no auto rerun)" },
    { ok: t2?.status === "failed", label: "task also failed" },
    { ok: (rec?.data as { reason?: string })?.reason === "workflow_running_recovery", label: "reason workflow_running_recovery" },
  ];
};

runCase["recovery-waiting-approval"] = async () => {
  const rel = "tmp-wf-recwait.txt";
  const def = singleToolWf("wf-recwait", "writeFile", { path: rel, content: "x" });
  const { taskId, executionId } = (await spawnChild(["setup", enc(def)])) as {
    taskId: string;
    executionId: string;
  };
  await pendingApproval(taskId);
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const exec = await execStore().get(executionId);
  const task = await taskStore().get(taskId);
  const evs = await taskStore().getEvents(taskId);
  const recCount = evs.filter((e) => e.type === "task.recovered").length;
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const recCount2 = (await taskStore().getEvents(taskId)).filter((e) => e.type === "task.recovered").length;
  const rec = evs.find((e) => e.type === "task.recovered");
  return [
    { ok: exec?.status === "waiting", label: "waiting workflow with pending approval kept waiting" },
    { ok: task?.status === "waiting", label: "task kept waiting" },
    { ok: (rec?.data as { reason?: string })?.reason === "workflow_approval_waiting", label: "reason workflow_approval_waiting" },
    { ok: recCount === 1 && recCount2 === 1, label: `idempotent recovery (task.recovered=${recCount2})` },
  ];
};

runCase["recovery-missing-approval"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  await taskStore().transition(task.id, "running");
  await taskStore().transition(task.id, "waiting");
  const exec = { ...sampleExecution(task.id), status: "waiting" as const };
  await execStore().create(exec);
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const e2 = await execStore().get(exec.executionId);
  const t2 = await taskStore().get(task.id);
  const evs = await taskStore().getEvents(task.id);
  const rec = evs.find((e) => e.type === "task.recovered");
  return [
    { ok: e2?.status === "failed", label: "waiting workflow without pending approval → failed" },
    { ok: t2?.status === "failed", label: "task failed" },
    { ok: (rec?.data as { reason?: string })?.reason === "workflow_missing_approval", label: "reason workflow_missing_approval" },
  ];
};

// PLACEHOLDER_CASES_2

runCase["resume-writeFile"] = async () => {
  const rel = "tmp-wf-write.txt";
  const abs = path.join(ROOT, rel);
  fs.rmSync(abs, { force: true });
  const def = singleToolWf("wf-write", "writeFile", { path: rel, content: "wf-resumed-write" });
  const { taskId, executionId } = (await spawnChild(["setup", enc(def)])) as {
    taskId: string;
    executionId: string;
  };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!])) as { taskStatus?: string };
  const exec = await execStore().get(executionId);
  const evs = await taskStore().getEvents(taskId);
  const node = await execStore().getNode(executionId, "t");
  const out = [
    { ok: res.taskStatus === "completed", label: `workflow task completed (got ${res.taskStatus})` },
    { ok: exec?.status === "completed", label: "execution persisted as completed" },
    { ok: fs.existsSync(abs) && fs.readFileSync(abs, "utf-8") === "wf-resumed-write", label: "writeFile side effect happened once" },
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile executed exactly once" },
    { ok: node?.status === "completed", label: "tool node persisted as completed" },
  ];
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["resume-gitAdd"] = async () => {
  const rel = "tmp-wf-gitadd.txt";
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, "wf stage\n");
  const def = singleToolWf("wf-gitadd", "gitAdd", { paths: [rel] });
  const { taskId } = (await spawnChild(["setup", enc(def)])) as { taskId: string };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!])) as { taskStatus?: string };
  const evs = await taskStore().getEvents(taskId);
  const { execFileSync } = await import("node:child_process");
  const staged = execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT })
    .toString()
    .split("\n")
    .some((l) => l[0] === "A" && l.slice(3) === rel);
  const out = [
    { ok: res.taskStatus === "completed", label: `workflow task completed (got ${res.taskStatus})` },
    { ok: staged, label: "gitAdd staged file after restart (guard re-validated)" },
    { ok: toolCompletedCount(evs, "gitAdd") === 1, label: "gitAdd executed exactly once" },
  ];
  execFileSync("git", ["reset", "--", rel], { cwd: ROOT });
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["resume-gitPush-mock"] = async () => {
  const { execFileSync } = await import("node:child_process");
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT }).toString().trim();
  const def = singleToolWf("wf-push", "gitPush", { remote: "origin", branch });
  const { taskId } = (await spawnChild(["setup", enc(def)])) as { taskId: string };
  const approvalId = await pendingApproval(taskId);
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!])) as { taskStatus?: string };
  const evs = await taskStore().getEvents(taskId);
  const pushEv = evs.find(
    (e) => e.type === "tool.completed" && (e.data as { tool?: string })?.tool === "gitPush",
  );
  const resultJson = JSON.stringify((pushEv?.data as { result?: unknown })?.result ?? {});
  return [
    { ok: res.taskStatus === "completed", label: `workflow task completed (got ${res.taskStatus})` },
    { ok: toolCompletedCount(evs, "gitPush") === 1, label: "gitPush executed exactly once (guard+approval+resume)" },
    { ok: resultJson.includes("mock"), label: "push ran in mock mode — no real push" },
  ];
};

runCase["condition-resume"] = async () => {
  const rel = "tmp-wf-cond.txt";
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, "cond stage\n");
  const def: WorkflowDefinition = {
    id: "wf-cond",
    name: "wf-cond",
    version: "1",
    nodes: [
      { id: "s", type: "tool", config: { tool: "gitStatus", input: {}, output: "gitStatusResult" } },
      { id: "c", type: "condition", config: { field: "gitStatusResult", operator: "exists" } },
      { id: "a", type: "tool", config: { tool: "gitAdd", input: { paths: [rel] }, output: "gitAddResult" } },
      { id: "e", type: "end" },
    ],
    edges: [
      { source: "s", target: "c" },
      { source: "c", target: "a", condition: { branch: "true" } },
      { source: "c", target: "e", condition: { branch: "false" } },
      { source: "a", target: "e" },
    ],
  };
  const { taskId, executionId } = (await spawnChild(["setup", enc(def)])) as {
    taskId: string;
    executionId: string;
  };
  const approvalId = await pendingApproval(taskId);
  // 恢复前：condition 已在 Process A 计算并持久化
  const condBefore = await execStore().getNode(executionId, "c");
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!])) as { taskStatus?: string };
  const exec = await execStore().get(executionId);
  const evs = await taskStore().getEvents(taskId);
  const { execFileSync } = await import("node:child_process");
  const out = [
    { ok: condBefore?.status === "completed" && condBefore?.branch === "true", label: "condition computed & persisted (branch=true) before restart" },
    { ok: res.taskStatus === "completed", label: `workflow completed after resume (got ${res.taskStatus})` },
    { ok: exec?.status === "completed", label: "execution completed" },
    { ok: nodeStartedCount(evs, "c") === 1, label: `condition NOT recomputed on resume (node.started=${nodeStartedCount(evs, "c")})` },
    { ok: toolCompletedCount(evs, "gitAdd") === 1, label: "approved gitAdd executed once" },
  ];
  execFileSync("git", ["reset", "--", rel], { cwd: ROOT });
  fs.rmSync(abs, { force: true });
  return out;
};

runCase["full-workflow-resume"] = async () => {
  const rel = "tmp-wf-full.txt";
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, "full stage\n");
  const def: WorkflowDefinition = {
    id: "wf-full",
    name: "wf-full",
    version: "1",
    nodes: [
      { id: "A", type: "tool", config: { tool: "searchFiles", input: { query: "export", path: "src" }, output: "searchFilesResult" } },
      { id: "B", type: "tool", config: { tool: "gitStatus", input: {}, output: "gitStatusResult" } },
      { id: "ap", type: "tool", config: { tool: "gitAdd", input: { paths: [rel] }, output: "gitAddResult" } },
      { id: "cond", type: "condition", config: { field: "gitAddResult", operator: "exists" } },
      { id: "D", type: "tool", config: { tool: "gitLog", input: { limit: 3 }, output: "gitLogResult" } },
      { id: "e", type: "end" },
    ],
    edges: [
      { source: "A", target: "B" },
      { source: "B", target: "ap" },
      { source: "ap", target: "cond" },
      { source: "cond", target: "D", condition: { branch: "true" } },
      { source: "cond", target: "e", condition: { branch: "false" } },
      { source: "D", target: "e" },
    ],
  };
  const { taskId, executionId } = (await spawnChild(["setup", enc(def)])) as {
    taskId: string;
    executionId: string;
  };
  const approvalId = await pendingApproval(taskId);
  // 恢复前：A / B 已完成
  const aBefore = await execStore().getNode(executionId, "A");
  const bBefore = await execStore().getNode(executionId, "B");
  const res = (await spawnChild(["apply", "approve", taskId, approvalId!])) as { taskStatus?: string };
  const exec = await execStore().get(executionId);
  const evs = await taskStore().getEvents(taskId);
  const ctx = exec?.context as Record<string, unknown>;
  const { execFileSync } = await import("node:child_process");
  const out = [
    { ok: aBefore?.status === "completed" && bBefore?.status === "completed", label: "A & B completed before restart" },
    { ok: nodeStartedCount(evs, "A") === 1 && nodeStartedCount(evs, "B") === 1, label: "A & B NOT re-executed after resume (started once)" },
    { ok: toolCompletedCount(evs, "gitAdd") === 1, label: "approved gitAdd executed exactly once" },
    { ok: nodeStartedCount(evs, "cond") === 1, label: "condition computed once" },
    { ok: nodeStartedCount(evs, "D") === 1 && !!ctx?.gitLogResult, label: "D executed once after resume" },
    { ok: res.taskStatus === "completed" && exec?.status === "completed", label: "workflow + task completed" },
    { ok: !!ctx?.searchFilesResult && !!ctx?.gitStatusResult && !!ctx?.gitAddResult, label: "context complete across restart" },
    { ok: toolCompletedCount(evs, "gitPush") === 0, label: "no real git push in this flow" },
    { ok: evs[0]?.type === "task.created", label: "event sequence intact (task.created first)" },
  ];
  execFileSync("git", ["reset", "--", rel], { cwd: ROOT });
  fs.rmSync(abs, { force: true });
  return out;
};

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(
    path.join(ROOT, "data/workflow-persistence-evaluation.json"),
    "utf-8",
  );
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Workflow Execution Persistence + Full Resume");
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
