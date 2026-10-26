import fs from "node:fs/promises";
import path from "node:path";

import { preApprovalGuard } from "@/lib/agent/guard";
import { validatePushInput } from "@/lib/mcp/git/core";
import { createAndStartWorkflowTask } from "@/lib/agent/workflow/run";
import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";
import { createAndStartTask } from "@/lib/agent/task/runtime";
import * as eventBus from "@/lib/agent/task/event-bus";
import { applyApprovalDecision } from "@/lib/agent/task/runtime";
import { getTraceByTask } from "@/lib/agent/trace/store";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

const ROOT = process.cwd();

interface PushCase {
  id: string;
  kind: string;
  mode?: "approve" | "reject";
  branch?: string;
  expect?: string;
  input?: { remote?: string; branch?: string };
}

function pushNode(branch?: string): WorkflowDefinition {
  return {
    id: "wf-push", name: "push", version: "1",
    nodes: [
      { id: "p1", type: "tool", config: { tool: "gitPush", input: branch ? { branch } : {}, output: "pushResult" } },
      { id: "e1", type: "end" },
    ],
    edges: [{ source: "p1", target: "e1" }],
  };
}

function drive(taskId: string, mode: "approve" | "reject", sink?: { tools: string[]; approvals: string[] }): Promise<void> {
  return new Promise((resolve) => {
    const unsub = eventBus.subscribe(taskId, (e) => {
      if (e.type === "tool.started" && sink) sink.tools.push((e.data as { tool: string }).tool);
      if (e.type === "approval.required") {
        if (sink) sink.approvals.push((e.data as { toolName: string }).toolName);
        void applyApprovalDecision(taskId, (e.data as { approvalId: string }).approvalId, mode);
      }
      if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") {
        unsub();
        resolve();
      }
    });
  });
}

async function runWf(def: WorkflowDefinition, mode: "approve" | "reject"): Promise<{ status?: string; taskId: string }> {
  const ex = await createAndStartWorkflowTask({ definition: def, input: {} });
  await drive(ex.taskId, mode);
  await new Promise((r) => setTimeout(r, 30));
  return { status: (await getWorkflowExecutionStore().get(ex.executionId))?.status, taskId: ex.taskId };
}

async function runCase(c: PushCase): Promise<{ ok: boolean; note: string }> {
  switch (c.kind) {
    case "guard": {
      const r = await preApprovalGuard("gitPush", c.input, ROOT);
      return { ok: !r.ok, note: r.ok ? "NOT denied" : `denied: ${r.error}` };
    }
    case "validate-default": {
      const v = await validatePushInput(ROOT, {});
      return { ok: v.ok && v.remote === "origin" && !!v.branch, note: `remote=${v.remote}, branch=${v.branch}` };
    }
    case "workflow-push": {
      const r = await runWf(pushNode(c.branch), c.mode as "approve" | "reject");
      return { ok: r.status === c.expect, note: `status=${r.status}` };
    }
    case "workflow-status-push": {
      const def: WorkflowDefinition = {
        id: "wf-status-push", name: "status-push", version: "1",
        nodes: [
          { id: "s1", type: "tool", config: { tool: "gitStatus", output: "st" } },
          { id: "p1", type: "tool", config: { tool: "gitPush", input: { branch: c.branch }, output: "pushResult" } },
          { id: "e1", type: "end" },
        ],
        edges: [{ source: "s1", target: "p1" }, { source: "p1", target: "e1" }],
      };
      const r = await runWf(def, "approve");
      return { ok: r.status === c.expect, note: `status=${r.status}` };
    }
    case "trace": {
      const r = await runWf(pushNode(c.branch), "approve");
      const trace = getTraceByTask(r.taskId);
      const hasToolStep = !!trace?.steps.find((s) => s.type === "tool" && s.name === "gitPush");
      const hasApprovalStep = !!trace?.steps.find((s) => s.type === "approval" && s.name === "gitPush");
      const noToken = !/token|authorization|bearer/i.test(JSON.stringify(trace));
      return { ok: hasToolStep && hasApprovalStep && noToken, note: `tool=${hasToolStep}, approval=${hasApprovalStep}, noToken=${noToken}` };
    }
    case "agent": {
      const task = await createAndStartTask({
        messages: [{ role: "user", content: "这是对 gitPush 审批流程的测试。无论当前仓库状态如何，你都必须实际调用一次 gitPush 工具，把当前分支 main 推送到 origin。请现在就调用 gitPush。" }],
        maxSteps: 8,
      });
      const sink = { tools: [] as string[], approvals: [] as string[] };
      await drive(task.id, "approve", sink);
      const ok = sink.tools.includes("gitPush") && sink.approvals.includes("gitPush");
      return { ok, note: `tools=${sink.tools.join(",")}; approvals=${sink.approvals.join(",")}` };
    }
    default:
      return { ok: false, note: "unknown kind" };
  }
}

async function main() {
  // mock executor：验证 / 审批 / workflow / agent 全部真实，仅跳过真实网络 push
  process.env.AGENT_GIT_PUSH_MODE = "mock";

  const raw = await fs.readFile(path.join(ROOT, "data/git-push-evaluation.json"), "utf-8");
  const cases: PushCase[] = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("Git Push Evaluation");
  console.log("========================================");
  console.log("(real network push MOCKED — no push to origin)\n");

  let passed = 0;
  for (const c of cases) {
    const r = await runCase(c);
    if (r.ok) passed += 1;
    console.log(`Case: ${c.id.padEnd(24)} ${r.ok ? "PASS" : "FAIL"}  (${r.note})`);
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
