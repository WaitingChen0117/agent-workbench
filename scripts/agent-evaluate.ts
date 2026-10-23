import fs from "node:fs/promises";
import path from "node:path";

import { createAndStartTask } from "@/lib/agent/task/runtime";
import * as eventBus from "@/lib/agent/task/event-bus";
import { resolveApproval } from "@/lib/agent/approvals";
import { getTaskStore } from "@/lib/agent/task/task-store";
import { getTraceByTask } from "@/lib/agent/trace/store";
import { computeMetrics } from "@/lib/agent/trace/metrics";

/**
 * Agent Evaluation CLI
 *
 * 独立于 Agent Runtime 的外部测试：加载 data/agent-evaluation.json，
 * 逐个运行真实 Agent 任务（自动批准审批），再根据 successCriteria 判定通过与否。
 * 目标是发现问题，不得为了通过而改 Case 或改 Agent 行为。
 */

const ROOT = process.cwd();

type Criterion =
  | { type: "statusCompleted" }
  | { type: "answerContains"; value: string }
  | { type: "toolUsed"; tool: string }
  | { type: "fileExists"; path: string }
  | { type: "fileNotContains"; path: string; value: string };

interface EvalCase {
  id: string;
  task: string;
  expectedTools?: string[];
  maxSteps?: number;
  setup?: { writeFile: string; content: string };
  cleanup?: string[];
  successCriteria: Criterion[];
}

interface DriveResult {
  taskId: string;
  status: string | undefined;
  answer: string | undefined;
  toolNames: string[];
}

async function driveTask(content: string, maxSteps: number): Promise<DriveResult> {
  const task = await createAndStartTask({ messages: [{ role: "user", content }], maxSteps });
  const toolNames: string[] = [];

  return new Promise((resolve) => {
    const unsub = eventBus.subscribe(task.id, (e) => {
      if (e.type === "tool.started") {
        toolNames.push((e.data as { tool: string }).tool);
      }
      if (e.type === "approval.required") {
        resolveApproval((e.data as { approvalId: string }).approvalId, "approve");
      }
      if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") {
        unsub();
        void getTaskStore().get(task.id).then((final) =>
          resolve({ taskId: task.id, status: final?.status ?? undefined, answer: final?.answer, toolNames }),
        );
      }
    });
  });
}

// PLACEHOLDER_EVAL
async function checkCriterion(
  c: Criterion,
  r: DriveResult,
): Promise<{ ok: boolean; label: string }> {
  switch (c.type) {
    case "statusCompleted":
      return { ok: r.status === "completed", label: `status=completed (got ${r.status})` };
    case "answerContains": {
      const ok = (r.answer ?? "").toLowerCase().includes(c.value.toLowerCase());
      return { ok, label: `answer contains "${c.value}"` };
    }
    case "toolUsed":
      return { ok: r.toolNames.includes(c.tool), label: `used tool ${c.tool}` };
    case "fileExists": {
      const ok = await fs.access(path.join(ROOT, c.path)).then(() => true).catch(() => false);
      return { ok, label: `file exists ${c.path}` };
    }
    case "fileNotContains": {
      const content = await fs.readFile(path.join(ROOT, c.path), "utf-8").catch(() => "");
      return { ok: content.length > 0 && !content.includes(c.value), label: `${c.path} no longer contains "${c.value}"` };
    }
  }
}

interface CaseResult {
  id: string;
  pass: boolean;
  steps: number;
  toolCalls: number;
  approvals: number;
  durationMs: number | undefined;
  checks: Array<{ ok: boolean; label: string }>;
  status: string | undefined;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  if (c.setup) {
    await fs.mkdir(path.dirname(path.join(ROOT, c.setup.writeFile)), { recursive: true });
    await fs.writeFile(path.join(ROOT, c.setup.writeFile), c.setup.content, "utf-8");
  }

  const result = await driveTask(c.task, c.maxSteps ?? 12);

  const checks = [];
  for (const criterion of c.successCriteria) {
    checks.push(await checkCriterion(criterion, result));
  }

  if (c.cleanup) {
    for (const p of c.cleanup) {
      await fs.rm(path.join(ROOT, p), { force: true });
    }
  }

  const trace = getTraceByTask(result.taskId);
  const metrics = trace ? computeMetrics(trace) : undefined;

  return {
    id: c.id,
    pass: checks.every((x) => x.ok),
    steps: metrics?.agent.stepCount ?? 0,
    toolCalls: metrics?.tool.toolCalls ?? 0,
    approvals: metrics?.approval.approvalCount ?? 0,
    durationMs: metrics?.task.durationMs,
    checks,
    status: result.status,
  };
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/agent-evaluation.json"), "utf-8");
  const cases: EvalCase[] = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Agent Evaluation");
  console.log("========================================");

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${r.pass ? "PASS" : "FAIL"} (task ${r.status})`);
    console.log(`Steps: ${r.steps}`);
    console.log(`Tool Calls: ${r.toolCalls}`);
    console.log(`Approvals: ${r.approvals}`);
    console.log(`Duration: ${r.durationMs ?? "?"} ms`);
    for (const chk of r.checks) {
      console.log(`  [${chk.ok ? "ok" : "XX"}] ${chk.label}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`Total: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${results.length - passed}`);
  console.log(`Success Rate: ${Math.round((passed / results.length) * 100)}%`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

