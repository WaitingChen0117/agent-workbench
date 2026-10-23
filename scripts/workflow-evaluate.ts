import fs from "node:fs/promises";
import path from "node:path";

import { validateWorkflow } from "@/lib/agent/workflow/validator";
import { createAndStartWorkflowTask } from "@/lib/agent/workflow/run";
import { getExecution } from "@/lib/agent/workflow/execution-store";
import * as eventBus from "@/lib/agent/task/event-bus";
import { resolveApproval } from "@/lib/agent/approvals";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

const ROOT = process.cwd();

type Criterion =
  | { type: "executionStatus"; value: string }
  | { type: "contextHas"; key: string }
  | { type: "errorCode"; value: string };

interface WfCase {
  id: string;
  description?: string;
  workflow: WorkflowDefinition;
  input?: unknown;
  mode?: "approve" | "reject";
  expectInvalid?: boolean;
  cleanup?: string[];
  successCriteria?: Criterion[];
}

async function runWorkflowCase(c: WfCase): Promise<{ status: string | undefined; context: Record<string, unknown>; errorCode?: string }> {
  const execution = await createAndStartWorkflowTask({ definition: c.workflow, input: c.input });
  return new Promise((resolve) => {
    const unsub = eventBus.subscribe(execution.taskId, (e) => {
      if (e.type === "approval.required") {
        resolveApproval((e.data as { approvalId: string }).approvalId, c.mode === "reject" ? "reject" : "approve");
      }
      if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") {
        unsub();
        const ex = getExecution(execution.executionId);
        resolve({ status: ex?.status, context: ex?.context ?? {}, errorCode: ex?.error?.code });
      }
    });
  });
}

function checkCriterion(c: Criterion, r: { status: string | undefined; context: Record<string, unknown>; errorCode?: string }): { ok: boolean; label: string } {
  switch (c.type) {
    case "executionStatus":
      return { ok: r.status === c.value, label: `execution status = ${c.value} (got ${r.status})` };
    case "contextHas":
      return { ok: c.key in r.context, label: `context has ${c.key}` };
    case "errorCode":
      return { ok: r.errorCode === c.value, label: `error code = ${c.value} (got ${r.errorCode})` };
  }
}

// PLACEHOLDER_WF_MAIN
async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/workflow-evaluation.json"), "utf-8");
  const cases: WfCase[] = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Workflow Evaluation");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    let pass: boolean;
    const checks: Array<{ ok: boolean; label: string }> = [];

    if (c.expectInvalid) {
      const v = validateWorkflow(c.workflow);
      pass = !v.valid;
      checks.push({ ok: pass, label: `rejected invalid workflow (${v.errors[0] ?? ""})` });
    } else {
      const r = await runWorkflowCase(c);
      for (const crit of c.successCriteria ?? []) {
        checks.push(checkCriterion(crit, r));
      }
      pass = checks.every((x) => x.ok);
      if (c.cleanup) {
        for (const p of c.cleanup) await fs.rm(path.join(ROOT, p), { force: true });
      }
    }

    if (pass) passed += 1;
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${pass ? "PASS" : "FAIL"}`);
    for (const chk of checks) console.log(`  [${chk.ok ? "ok" : "XX"}] ${chk.label}`);
  }

  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${cases.length - passed}`);
  console.log(`Success Rate: ${Math.round((passed / cases.length) * 100)}%`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

