import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { preApprovalGuard } from "@/lib/agent/guard";
import { createAndStartTask } from "@/lib/agent/task/runtime";
import { createAndStartWorkflowTask } from "@/lib/agent/workflow/run";
import { getExecution } from "@/lib/agent/workflow/execution-store";
import * as eventBus from "@/lib/agent/task/event-bus";
import { applyApprovalDecision } from "@/lib/agent/task/runtime";
import { getTaskStore } from "@/lib/agent/task/task-store";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

const exec = promisify(execFile);
const ROOT = process.cwd();

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: ROOT, shell: false });
  return stdout;
}
async function head(): Promise<string> {
  return (await git(["rev-parse", "HEAD"])).trim();
}
async function isStaged(file: string): Promise<boolean> {
  const out = await git(["status", "--porcelain=v1"]);
  return out.split("\n").some((l) => l[0] && l[0] !== " " && l[0] !== "?" && l.slice(3) === file);
}

interface WfCase { tool?: string; file?: string; mode?: "approve" | "reject"; expect: string; sideEffect?: string; message?: string; input?: unknown; }

function driveTask(taskId: string, mode: "approve" | "reject"): Promise<void> {
  return new Promise((resolve) => {
    const unsub = eventBus.subscribe(taskId, (e) => {
      if (e.type === "approval.required") {
        void applyApprovalDecision(taskId, (e.data as { approvalId: string }).approvalId, mode);
      }
      if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") {
        unsub();
        resolve();
      }
    });
  });
}

async function runWorkflow(def: WorkflowDefinition, mode: "approve" | "reject"): Promise<string | undefined> {
  const ex = await createAndStartWorkflowTask({ definition: def, input: {} });
  await driveTask(ex.taskId, mode);
  // 让引擎 catch/收尾完成后再读 execution 状态，避免与 task.cancelled 事件竞争
  await new Promise((r) => setTimeout(r, 30));
  return getExecution(ex.executionId)?.status;
}

// PLACEHOLDER_GWE
function addNode(tool: string, file: string): WorkflowDefinition {
  return {
    id: `wf-${tool}`, name: tool, version: "1",
    nodes: [
      { id: "t1", type: "tool", config: { tool, input: { paths: [file] }, output: "r" } },
      { id: "e1", type: "end" },
    ],
    edges: [{ source: "t1", target: "e1" }],
  };
}

async function runCase(c: { id: string; kind: string } & WfCase): Promise<{ ok: boolean; note: string }> {
  switch (c.kind) {
    case "guard": {
      const r = await preApprovalGuard(c.tool as string, c.input, ROOT);
      const ok = c.expect === "denied" ? !r.ok : r.ok;
      return { ok, note: r.ok ? "allowed" : `denied: ${r.error}` };
    }
    case "workflow-tool": {
      await fs.writeFile(path.join(ROOT, c.file as string), "gwe\n", "utf-8");
      const status = await runWorkflow(addNode(c.tool as string, c.file as string), c.mode as "approve" | "reject");
      let sideOk = true;
      if (c.sideEffect === "staged") sideOk = await isStaged(c.file as string);
      if (c.sideEffect === "notStaged") sideOk = !(await isStaged(c.file as string));
      return { ok: status === c.expect && sideOk, note: `status=${status}, sideEffect=${sideOk}` };
    }
    case "workflow-status-add": {
      await fs.writeFile(path.join(ROOT, c.file as string), "gwe\n", "utf-8");
      const def: WorkflowDefinition = {
        id: "wf-status-add", name: "status-add", version: "1",
        nodes: [
          { id: "s1", type: "tool", config: { tool: "gitStatus", output: "st" } },
          { id: "a1", type: "tool", config: { tool: "gitAdd", input: { paths: [c.file] }, output: "add" } },
          { id: "e1", type: "end" },
        ],
        edges: [{ source: "s1", target: "a1" }, { source: "a1", target: "e1" }],
      };
      const status = await runWorkflow(def, "approve");
      return { ok: status === c.expect, note: `status=${status}` };
    }
    case "commit": {
      await fs.writeFile(path.join(ROOT, c.file as string), "gwe commit\n", "utf-8");
      // 先 staging（approve），保证有可提交内容
      await runWorkflow(addNode("gitAdd", c.file as string), "approve");
      const before = await head();
      const def: WorkflowDefinition = {
        id: "wf-commit", name: "commit", version: "1",
        nodes: [
          { id: "c1", type: "tool", config: { tool: "gitCommit", input: { message: c.message }, output: "commit" } },
          { id: "e1", type: "end" },
        ],
        edges: [{ source: "c1", target: "e1" }],
      };
      const status = await runWorkflow(def, c.mode as "approve" | "reject");
      const after = await head();
      let sideOk = true;
      if (c.sideEffect === "newCommit") sideOk = before !== after;
      if (c.sideEffect === "noNewCommit") sideOk = before === after;
      return { ok: status === c.expect && sideOk, note: `status=${status}, headChanged=${before !== after}` };
    }
    case "agent": {
      await fs.writeFile(path.join(ROOT, c.file as string), "gwe agent\n", "utf-8");
      const before = await head();
      const task = await createAndStartTask({
        messages: [{ role: "user", content: `请用 gitAdd 暂存文件 ${c.file}，再用 gitCommit 提交，message 为 "${c.message}"。只暂存这个文件。` }],
        maxSteps: 12,
      });
      await driveTask(task.id, "approve");
      const after = await head();
      const finalStatus = (await getTaskStore().get(task.id))?.status;
      const ok = finalStatus === "completed" && before !== after;
      return { ok, note: `status=${finalStatus}, headChanged=${before !== after}` };
    }
    default:
      return { ok: false, note: "unknown kind" };
  }
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/git-write-evaluation.json"), "utf-8");
  const cases = JSON.parse(raw).cases as Array<{ id: string; kind: string } & WfCase>;

  console.log("========================================");
  console.log("Git Write Evaluation");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    const r = await runCase(c);
    if (r.ok) passed += 1;
    console.log(`Case: ${c.id.padEnd(26)} ${r.ok ? "PASS" : "FAIL"}  (${r.note})`);
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

main().catch((e) => { console.error(e); process.exit(1); });

