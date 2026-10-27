import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, ".data", "trace-eval.sqlite");
process.env.AGENT_TRACE_STORE = "sqlite";
process.env.AGENT_TASK_DB_PATH = DB_PATH;

import { getTraceStore } from "@/lib/agent/trace/trace-store";
import { computeMetrics } from "@/lib/agent/trace/metrics";
import type { AgentTrace, AgentTraceStep, TraceStepType } from "@/lib/agent/trace/types";

function cleanupDb(): void {
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
}

let seq = 0;
function step(partial: Partial<AgentTraceStep> & { type: TraceStepType }): AgentTraceStep {
  seq += 1;
  return {
    stepId: randomUUID(),
    traceId: "trace",
    sequence: seq,
    type: partial.type,
    name: partial.name,
    startedAt: new Date(Date.parse("2026-01-01T00:00:00Z") + seq * 1000).toISOString(),
    endedAt: new Date(Date.parse("2026-01-01T00:00:01Z") + seq * 1000).toISOString(),
    durationMs: 1000,
    status: partial.status ?? "completed",
    input: partial.input,
    output: partial.output,
    workflowId: partial.workflowId,
    executionId: partial.executionId,
    nodeId: partial.nodeId,
  };
}

function mkTrace(taskId: string, steps: AgentTraceStep[], status: AgentTrace["status"] = "completed"): AgentTrace {
  return {
    traceId: `trace-${taskId}`,
    taskId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: status === "running" ? undefined : "2026-01-01T00:10:00Z",
    status,
    steps: steps.map((s) => ({ ...s, traceId: `trace-${taskId}` })),
  };
}

const store = () => getTraceStore();

interface Check { ok: boolean; label: string }
const runCase: Record<string, () => Check[] | Promise<Check[]>> = {};

// PLACEHOLDER_CASES

function childWrite(trace: AgentTrace): { ok?: boolean } {
  const b64 = Buffer.from(JSON.stringify(trace)).toString("base64");
  const res = spawnSync("npx", ["tsx", "scripts/trace-child.ts", "write", b64], {
    cwd: ROOT,
    env: { ...process.env, AGENT_TRACE_STORE: "sqlite", AGENT_TASK_DB_PATH: DB_PATH },
    encoding: "utf-8",
  });
  const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "{}";
  return JSON.parse(line);
}

runCase["trace-create"] = () => {
  const id = "t-create";
  store().putTrace(mkTrace(id, [step({ type: "agent", name: "s1" })]));
  const got = store().getByTaskId(id);
  return [
    { ok: !!got, label: "trace persisted and readable" },
    { ok: got?.traceId === `trace-${id}`, label: "traceId persisted" },
  ];
};
runCase["trace-event-persist"] = () => {
  const id = "t-persist";
  store().putTrace(mkTrace(id, [step({ type: "agent", name: "a" }), step({ type: "tool", name: "writeFile" }), step({ type: "llm", name: "llm" })]));
  const got = store().getByTaskId(id);
  return [
    { ok: got?.steps.length === 3, label: `3 steps persisted (got ${got?.steps.length})` },
    { ok: got?.steps[1].name === "writeFile", label: "step content intact" },
  ];
};
runCase["trace-event-order"] = () => {
  const id = "t-order";
  store().putTrace(mkTrace(id, [step({ type: "agent" }), step({ type: "tool" }), step({ type: "approval" }), step({ type: "tool" })]));
  const got = store().getByTaskId(id);
  const ordered = (got?.steps ?? []).every((s, i) => s.sequence === i + 1);
  return [{ ok: ordered && got?.steps.length === 4, label: "steps read back ordered by sequence" }];
};
runCase["trace-restart-read"] = () => {
  const id = "t-restart";
  const res = childWrite(mkTrace(id, [step({ type: "agent", name: "written-in-child" })]));
  const got = store().getByTaskId(id);
  return [
    { ok: res.ok === true, label: "child process wrote the trace" },
    { ok: !!got && got.steps[0].name === "written-in-child", label: "trace written in a separate process is readable here" },
  ];
};
runCase["trace-workflow-read"] = () => {
  const id = "t-wf";
  store().putTrace(mkTrace(id, [step({ type: "workflow", name: "node:a", executionId: "ex1", nodeId: "a" }), step({ type: "tool", executionId: "ex1", nodeId: "a" })]));
  const steps = store().listByWorkflowExecutionId("ex1");
  return [{ ok: steps.length === 2, label: `listByWorkflowExecutionId returns steps (got ${steps.length})` }];
};
runCase["trace-agent-node-read"] = () => {
  const id = "t-node";
  store().putTrace(mkTrace(id, [step({ type: "tool", executionId: "ex2", nodeId: "n1" }), step({ type: "tool", executionId: "ex2", nodeId: "n2" })]));
  const steps = store().listByWorkflowNodeId("ex2", "n1");
  return [{ ok: steps.length === 1 && steps[0].nodeId === "n1", label: "listByWorkflowNodeId filters by node" }];
};
runCase["trace-sensitive-redaction"] = () => {
  const id = "t-redact";
  store().putTrace(mkTrace(id, [step({ type: "tool", name: "x", input: { api_key: "sk-SECRET", token: "abc123", note: "ok" } })]));
  const got = store().getByTaskId(id);
  const input = got?.steps[0].input as { api_key?: string; token?: string; note?: string } | undefined;
  return [
    { ok: input?.api_key === "[REDACTED]" && input?.token === "[REDACTED]", label: "secret keys redacted in persisted trace" },
    { ok: input?.note === "ok", label: "non-secret fields preserved" },
  ];
};
runCase["trace-summary"] = () => {
  const id = "t-summary";
  store().putTrace(mkTrace(id, [
    step({ type: "tool", status: "completed" }),
    step({ type: "tool", status: "completed" }),
    step({ type: "tool", status: "failed" }),
    step({ type: "approval", status: "completed" }),
  ]));
  const got = store().getByTaskId(id)!;
  const m = computeMetrics(got);
  return [
    { ok: m.tool.toolCalls === 3, label: `metrics toolCalls=3 (got ${m.tool.toolCalls})` },
    { ok: m.tool.toolFailure === 1, label: `metrics toolFailure=1 (got ${m.tool.toolFailure})` },
    { ok: m.approval.approvalCount === 1, label: "metrics approvalCount=1" },
  ];
};
runCase["trace-idempotent"] = () => {
  const id = "t-idem";
  const tr = mkTrace(id, [step({ type: "agent" }), step({ type: "tool" })]);
  store().putTrace(tr);
  store().putTrace(tr);
  const got = store().getByTaskId(id);
  return [{ ok: got?.steps.length === 2, label: `re-putTrace does not duplicate steps (got ${got?.steps.length})` }];
};
runCase["trace-cross-process"] = () => {
  const id = "t-xproc";
  childWrite(mkTrace(id, [
    step({ type: "tool", name: "writeFile", sequence: 1, input: { password: "p@ss", path: "a.txt" } }),
    step({ type: "approval", name: "gitAdd" }),
  ]));
  const got = store().getByTaskId(id);
  const input = got?.steps[0].input as { password?: string; path?: string } | undefined;
  const ordered = (got?.steps ?? []).every((s, i) => s.sequence === i + 1);
  return [
    { ok: got?.steps.length === 2 && ordered, label: "cross-process trace read with correct sequence" },
    { ok: input?.password === "[REDACTED]", label: "secret not present in cross-process trace" },
    { ok: input?.path === "a.txt", label: "payload preserved" },
  ];
};

async function run(kind: string): Promise<Check[]> {
  const fn = runCase[kind];
  if (!fn) return [{ ok: false, label: `unknown kind: ${kind}` }];
  return fn();
}

async function main(): Promise<void> {
  cleanupDb();
  const raw = fs.readFileSync(path.join(ROOT, "data/trace-persistence-evaluation.json"), "utf-8");
  const cases: Array<{ id: string; kind: string }> = JSON.parse(raw).cases;
  console.log("========================================");
  console.log("Trace Persistence Evaluation");
  console.log("========================================");
  let passed = 0;
  for (const c of cases) {
    seq = 0;
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
