/**
 * 跨进程验证子进程（workflow-agent-resume-evaluate 启动）。
 * 为 Workflow Agent Node 注入 deterministic stub runner（取代真实 LLM），
 * 其余（Session / Gate / Approval / Tool Resolver / WorkflowExecution）全部真实。
 *
 * 用法：
 *   tsx scripts/workflow-agent-child.ts setup <defB64> <planB64>
 *   tsx scripts/workflow-agent-child.ts apply <action> <taskId> <approvalId> <planB64>
 */
import type { ToolSet } from "ai";

import {
  setAgentLoopRunner,
  applyApprovalDecision,
  type AgentLoopRunnerArgs,
} from "@/lib/agent/task/runtime";
import { createAndStartWorkflowTask } from "@/lib/agent/workflow/run";
import { getTaskStore } from "@/lib/agent/task/task-store";
import type { AgentResult } from "@/lib/agent/loop";
import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

interface PlanStep { tool: string; input: unknown }

function decode<T>(b64: string): T {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as T;
}
function countToolResults(messages: { content: string }[]): number {
  return messages.filter((m) => m.content.includes("[tool-result:")).length;
}

function installStub(plan: PlanStep[]): void {
  const stub = async (args: AgentLoopRunnerArgs): Promise<AgentResult> => {
    const base = (await getTaskStore().get(args.taskId))?.currentStep ?? 0;
    const step = base + 1;
    args.onEvent({ type: "agent.step.started", step });
    args.onEvent({ type: "llm.requested", step });
    const index = countToolResults(args.messages);
    if (index < plan.length) {
      const { tool: toolName, input } = plan[index];
      const tools = args.tools as ToolSet;
      const execute = tools[toolName]?.execute as
        | ((i: unknown, o: unknown) => Promise<unknown>)
        | undefined;
      if (!execute) return { answer: `stub: missing ${toolName}`, toolCalls: [], steps: step };
      await execute(input, { toolCallId: `stub-${toolName}-${step}`, messages: [] });
      return { answer: "", toolCalls: [], steps: step };
    }
    args.onEvent({ type: "message.started", step });
    args.onEvent({ type: "message.delta", step, content: "agent node done" });
    args.onEvent({ type: "message.completed", step });
    args.onEvent({ type: "agent.step.completed", step, toolCalls: 0 });
    return { answer: "agent node done", toolCalls: [], steps: step };
  };
  setAgentLoopRunner(stub);
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
    installStub(decode<PlanStep[]>(process.argv[4]));
    const execution = await createAndStartWorkflowTask({ definition, input: {} });
    console.log(JSON.stringify({ taskId: execution.taskId, executionId: execution.executionId }));
    await waitForStatus(execution.taskId, ["waiting", "completed", "failed", "cancelled"]);
    process.exit(0);
  } else if (mode === "apply") {
    const action = process.argv[3] as "approve" | "reject";
    const taskId = process.argv[4];
    const approvalId = process.argv[5];
    installStub(decode<PlanStep[]>(process.argv[6]));
    const result = await applyApprovalDecision(taskId, approvalId, action);
    const taskStatus = await waitForStatus(taskId, ["waiting", "completed", "failed", "cancelled"]);
    console.log(JSON.stringify({ ...result, taskStatus }));
    process.exit(0);
  } else {
    console.error("unknown mode");
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
