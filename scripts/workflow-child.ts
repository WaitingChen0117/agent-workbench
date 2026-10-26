/**
 * 跨进程验证子进程（由 workflow-persistence-evaluate 启动）。
 * 用法：
 *   tsx scripts/workflow-child.ts setup <defB64> <inputB64>
 *   tsx scripts/workflow-child.ts apply <action> <taskId> <approvalId>
 *
 * Workflow 节点用真实 Tool Resolver / Permission Gate / Approval（不注入 stub，
 * 因为这些工作流只含 tool/condition/approval 节点，不依赖 LLM）。
 */
import {
  createAndStartWorkflowTask,
} from "@/lib/agent/workflow/run";
import { applyApprovalDecision } from "@/lib/agent/task/runtime";
import { getTaskStore } from "@/lib/agent/task/task-store";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

function decode<T>(b64: string): T {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForStatus(taskId: string, targets: string[], maxTries = 400): Promise<string | undefined> {
  const store = getTaskStore();
  for (let i = 0; i < maxTries; i += 1) {
    const t = await store.get(taskId);
    if (t && targets.includes(t.status)) return t.status;
    await sleep(100);
  }
  return (await store.get(taskId))?.status;
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "setup") {
    const definition = decode<WorkflowDefinition>(process.argv[3]);
    const input = process.argv[4] ? decode<unknown>(process.argv[4]) : {};
    const execution = await createAndStartWorkflowTask({ definition, input });
    console.log(
      JSON.stringify({ taskId: execution.taskId, executionId: execution.executionId }),
    );
    await waitForStatus(execution.taskId, ["waiting", "completed", "failed", "cancelled"]);
    process.exit(0);
  } else if (mode === "apply") {
    const action = process.argv[3] as "approve" | "reject";
    const taskId = process.argv[4];
    const approvalId = process.argv[5];
    const result = await applyApprovalDecision(taskId, approvalId, action);
    const taskStatus = await waitForStatus(taskId, [
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ]);
    console.log(JSON.stringify({ ...result, taskStatus }));
    process.exit(0);
  } else {
    console.error("unknown mode");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
