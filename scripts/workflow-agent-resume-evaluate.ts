import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";
import { SQLiteSessionStore } from "@/lib/agent/session/sqlite-session-store";
import { SQLiteWorkflowExecutionStore } from "@/lib/agent/workflow/sqlite-execution-store";
import { recoverTasks } from "@/lib/agent/task/recovery";
import type { AgentTaskEvent } from "@/lib/agent/task/types";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

/**
 * Workflow Agent Node Resume Evaluation（Phase 10.6-A）
 *
 * 真实跨进程验证：Workflow 的 Agent Node 复用 Phase 10.4 AgentSession，
 * 跨进程 approve 后重新进入 SAME Agent Loop，可连续多次 approval，最终 Agent Node 完成、
 * Workflow 继续至 end。execute-once / Guard / Permission 均不被绕过。
 */
const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "wf-agent-eval.sqlite");
const CHILD_ENV: Record<string, string> = {
  AGENT_TASK_STORE: "sqlite",
  AGENT_APPROVAL_STORE: "sqlite",
  AGENT_SESSION_STORE: "sqlite",
  AGENT_WORKFLOW_EXECUTION_STORE: "sqlite",
  AGENT_TRACE_STORE: "sqlite",
  AGENT_TASK_DB_PATH: DB_PATH,
  AGENT_GIT_PUSH_MODE: "mock",
};

function cleanupDb(): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
}
const taskStore = () => new SQLiteTaskStore(DB_PATH);
const approvalStore = () => new SQLiteApprovalStore(DB_PATH);
const sessionStore = () => new SQLiteSessionStore(DB_PATH);
const execStore = () => new SQLiteWorkflowExecutionStore(DB_PATH);

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function enc(v: unknown): string { return Buffer.from(JSON.stringify(v)).toString("base64"); }

function spawnChild(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/workflow-agent-child.ts", ...args], {
      cwd: ROOT,
      env: { ...process.env, ...CHILD_ENV },
    });
    let out = ""; let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(0, 500)}`));
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`bad child output: ${out.slice(0, 300)}`)); }
    });
    child.on("error", reject);
  });
}

async function pendingApproval(taskId: string, exclude?: string, maxTries = 100): Promise<string | undefined> {
  for (let i = 0; i < maxTries; i += 1) {
    const list = (await approvalStore().getByTaskId(taskId)).filter((a) => a.status === "pending" && a.id !== exclude);
    if (list.length > 0) return list[0].id;
    await sleep(100);
  }
  return undefined;
}

function agentWf(): WorkflowDefinition {
  return {
    id: "wf-agent",
    name: "wf-agent",
    version: "1",
    nodes: [
      { id: "ag", type: "agent", config: { instructions: "按计划执行工具", output: "agentResult", maxSteps: 8 } },
      { id: "e", type: "end" },
    ],
    edges: [{ source: "ag", target: "e" }],
  };
}
function plan(rel: string, gitRel: string): Array<{ tool: string; input: unknown }> {
  return [
    { tool: "writeFile", input: { path: rel, content: "agent-node-write" } },
    { tool: "gitAdd", input: { paths: [gitRel] } },
  ];
}

function nodeStartedCount(evs: AgentTaskEvent[], nodeId: string): number {
  return evs.filter((e) => e.type === "workflow.node.started" && (e.data as { nodeId?: string })?.nodeId === nodeId).length;
}
function toolCompletedCount(evs: AgentTaskEvent[], tool: string): number {
  return evs.filter((e) => e.type === "tool.completed" && (e.data as { tool?: string })?.tool === tool).length;
}
function stepStartedCount(evs: AgentTaskEvent[]): number {
  return evs.filter((e) => e.type === "agent.step.started").length;
}

interface Check { ok: boolean; label: string }
const runCase: Record<string, () => Promise<Check[]>> = {};

// PLACEHOLDER_CASES

interface SetupState { taskId: string; executionId: string; a1: string | undefined; writeAbs: string; gitRel: string; gitAbs: string }

async function setupAgentWorkflow(tag: string): Promise<SetupState> {
  const writeRel = `tmp-wfa-${tag}-w.txt`;
  const gitRel = `tmp-wfa-${tag}-g.txt`;
  const writeAbs = path.join(ROOT, writeRel);
  const gitAbs = path.join(ROOT, gitRel);
  fs.rmSync(writeAbs, { force: true });
  fs.writeFileSync(gitAbs, "stage me\n");
  const { taskId, executionId } = (await spawnChild(["setup", enc(agentWf()), enc(plan(writeRel, gitRel))])) as {
    taskId: string; executionId: string;
  };
  const a1 = await pendingApproval(taskId);
  return { taskId, executionId, a1, writeAbs, gitRel, gitAbs };
}
function cleanupFiles(s: SetupState): void {
  fs.rmSync(s.writeAbs, { force: true });
  try {
    execFileSync("git", ["reset", "--", s.gitRel], { cwd: ROOT });
  } catch { /* ignore */ }
  fs.rmSync(s.gitAbs, { force: true });
}

runCase["agent-node-create"] = async () => {
  const s = await setupAgentWorkflow("create");
  const exec = await execStore().get(s.executionId);
  const task = await taskStore().get(s.taskId);
  cleanupFiles(s);
  return [
    { ok: !!exec, label: "workflow execution created" },
    { ok: !!task, label: "agent task created" },
  ];
};

runCase["agent-node-session-created"] = async () => {
  const s = await setupAgentWorkflow("sess");
  const session = await sessionStore().getByTaskId(s.taskId);
  cleanupFiles(s);
  return [{ ok: !!session, label: "AgentSession created for the workflow task (reused by agent node)" }];
};

runCase["agent-node-approval-waiting"] = async () => {
  const s = await setupAgentWorkflow("wait");
  const task = await taskStore().get(s.taskId);
  const exec = await execStore().get(s.executionId);
  const node = await execStore().getNode(s.executionId, "ag");
  const session = await sessionStore().getByTaskId(s.taskId);
  cleanupFiles(s);
  return [
    { ok: task?.status === "waiting", label: "task waiting" },
    { ok: exec?.status === "waiting", label: "workflow execution waiting" },
    { ok: node?.status === "waiting" && !!node?.approvalId, label: "agent node waiting with approvalId" },
    { ok: !!s.a1, label: "approval pending" },
    { ok: session?.status === "waiting", label: "session waiting" },
  ];
};

runCase["agent-node-restart-persistence"] = async () => {
  const s = await setupAgentWorkflow("restart");
  // 子进程已退出；直接从 SQLite 读
  const exec = await execStore().get(s.executionId);
  const node = await execStore().getNode(s.executionId, "ag");
  const appr = s.a1 ? await approvalStore().get(s.a1) : null;
  cleanupFiles(s);
  return [
    { ok: exec?.status === "waiting", label: "execution readable & waiting across process" },
    { ok: node?.nodeType === "agent" && node?.status === "waiting", label: "agent node execution persisted" },
    { ok: appr?.status === "pending", label: "approval persisted pending" },
  ];
};

runCase["agent-node-approval-resume"] = async () => {
  const s = await setupAgentWorkflow("resume");
  const res = (await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))])) as { taskStatus?: string };
  const evs = await taskStore().getEvents(s.taskId);
  cleanupFiles(s);
  return [
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "approved writeFile executed once on resume" },
    { ok: res.taskStatus === "waiting", label: "agent loop re-entered and hit a 2nd approval (waiting)" },
  ];
};

runCase["agent-node-reenter-loop"] = async () => {
  const s = await setupAgentWorkflow("reenter");
  const evsBefore = await taskStore().getEvents(s.taskId);
  await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))]);
  const evsAfter = await taskStore().getEvents(s.taskId);
  cleanupFiles(s);
  return [
    { ok: stepStartedCount(evsBefore) === 1, label: "1 agent loop invocation before approval" },
    { ok: stepStartedCount(evsAfter) >= 2, label: `agent loop re-entered after approve (step.started=${stepStartedCount(evsAfter)})` },
  ];
};

runCase["agent-node-second-approval"] = async () => {
  const s = await setupAgentWorkflow("second");
  await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))]);
  const a2 = await pendingApproval(s.taskId, s.a1);
  cleanupFiles(s);
  return [{ ok: !!a2 && a2 !== s.a1, label: "a second, independent approval is produced after resume" }];
};

runCase["agent-node-full-resume"] = async () => {
  const s = await setupAgentWorkflow("full");
  const applyA = (await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))])) as { taskStatus?: string };
  const a2 = await pendingApproval(s.taskId, s.a1);
  const applyB = (await spawnChild(["apply", "approve", s.taskId, a2!, enc(plan("x", s.gitRel))])) as { taskStatus?: string };
  const exec = await execStore().get(s.executionId);
  const evs = await taskStore().getEvents(s.taskId);
  const approved = evs.filter((e) => e.type === "approval.approved").length;
  cleanupFiles(s);
  return [
    { ok: applyA.taskStatus === "waiting", label: "after approve#1, re-enter loop → 2nd approval waiting" },
    { ok: !!a2 && a2 !== s.a1, label: "2nd approval independent" },
    { ok: applyB.taskStatus === "completed", label: `after approve#2, workflow completed (got ${applyB.taskStatus})` },
    { ok: stepStartedCount(evs) >= 3, label: `agent loop invoked >=3 times (got ${stepStartedCount(evs)})` },
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile executed exactly once" },
    { ok: toolCompletedCount(evs, "gitAdd") === 1, label: "gitAdd executed exactly once" },
    { ok: approved === 2, label: "both approvals approved" },
    { ok: nodeStartedCount(evs, "ag") === 1, label: "agent node started exactly once (not re-run)" },
    { ok: exec?.status === "completed", label: "workflow execution completed" },
    { ok: toolCompletedCount(evs, "gitPush") === 0, label: "no real git push / github write" },
  ];
};

runCase["agent-node-no-duplicate-side-effect"] = async () => {
  const s = await setupAgentWorkflow("dup");
  await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))]);
  const mtime1 = fs.existsSync(s.writeAbs) ? fs.statSync(s.writeAbs).mtimeMs : 0;
  // 重复 approve 同一个 approval
  await spawnChild(["apply", "approve", s.taskId, s.a1!, enc(plan("x", s.gitRel))]);
  const evs = await taskStore().getEvents(s.taskId);
  const mtime2 = fs.existsSync(s.writeAbs) ? fs.statSync(s.writeAbs).mtimeMs : 0;
  cleanupFiles(s);
  return [
    { ok: toolCompletedCount(evs, "writeFile") === 1, label: "writeFile tool.completed stays 1 on duplicate approve" },
    { ok: mtime1 === mtime2, label: "file not rewritten by duplicate approve" },
  ];
};

runCase["agent-node-guard-denied"] = async () => {
  // 直接构造：waiting agent 节点 + 一个「创建时未过 gate、但 Guard 会拒绝」的审批，
  // 验证 resume 重跑 Guard 并拒绝执行（路径穿越 → validateAddPaths 失败）。
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  await taskStore().transition(task.id, "running");
  await taskStore().transition(task.id, "waiting");
  await sessionStore().create({ taskId: task.id });
  const executionId = randomUUID();
  await execStore().create({
    executionId, workflowId: "wf-agent", taskId: task.id, status: "waiting",
    startedAt: new Date().toISOString(), context: {}, stepCount: 0, definition: agentWf(),
  });
  const appr = await approvalStore().create({
    taskId: task.id,
    toolName: "gitAdd",
    input: { paths: ["../outside-workspace.txt"] },
  });
  await execStore().upsertNode({
    executionId, nodeId: "ag", nodeType: "agent", status: "waiting",
    startedAt: new Date().toISOString(), approvalId: appr.id, attempt: 1,
  });
  const res = (await spawnChild(["apply", "approve", task.id, appr.id, enc([])])) as { taskStatus?: string };
  const exec = await execStore().get(executionId);
  const evs = await taskStore().getEvents(task.id);
  return [
    { ok: res.taskStatus === "failed", label: `guard-denied resume → task failed (got ${res.taskStatus})` },
    { ok: exec?.status === "failed" && exec?.error?.code === "RESUME_GUARD_DENIED", label: "workflow execution failed with RESUME_GUARD_DENIED" },
    { ok: toolCompletedCount(evs, "gitAdd") === 0, label: "tool NOT executed when guard denies" },
  ];
};

runCase["agent-node-missing-approval"] = async () => {
  const s = await setupAgentWorkflow("missing");
  // 删除 pending approval → waiting workflow 无 pending approval
  if (s.a1) await approvalStore().delete(s.a1);
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const exec = await execStore().get(s.executionId);
  const evs = await taskStore().getEvents(s.taskId);
  const rec = evs.find((e) => e.type === "task.recovered");
  cleanupFiles(s);
  return [
    { ok: exec?.status === "failed", label: "waiting agent-node workflow without pending approval → failed" },
    { ok: (rec?.data as { reason?: string })?.reason === "workflow_missing_approval", label: "reason workflow_missing_approval" },
  ];
};

runCase["agent-node-running-recovery"] = async () => {
  const task = await taskStore().create({ messages: [{ role: "user", content: "wf" }], maxSteps: 10 });
  await taskStore().transition(task.id, "running");
  const executionId = randomUUID();
  await execStore().create({
    executionId, workflowId: "wf-agent", taskId: task.id, status: "running",
    startedAt: new Date().toISOString(), context: {}, stepCount: 0, definition: agentWf(),
  });
  await execStore().upsertNode({ executionId, nodeId: "ag", nodeType: "agent", status: "running", startedAt: new Date().toISOString(), attempt: 1 });
  await recoverTasks(taskStore(), approvalStore(), execStore());
  const exec = await execStore().get(executionId);
  const evs = await taskStore().getEvents(task.id);
  const rec = evs.find((e) => e.type === "task.recovered");
  return [
    { ok: exec?.status === "failed", label: "running agent-node workflow recovered → failed (no auto rerun)" },
    { ok: (rec?.data as { reason?: string })?.reason === "workflow_running_recovery", label: "reason workflow_running_recovery" },
  ];
};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(path.join(ROOT, "data/workflow-agent-resume-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;
  console.log("========================================");
  console.log("Workflow Agent Node Resume Evaluation");
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

main().catch((e) => { console.error(e); process.exit(1); });
