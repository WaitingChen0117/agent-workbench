/**
 * 跨进程验证子进程（由 session-persistence-evaluate 启动）。
 * 用一个可注入的 deterministic stub runner 取代真实 LLM —— 仅用于 Evaluation，
 * 不改变生产语义（生产默认仍是 streamAgent/真实 LLM）。
 *
 * stub 决策：扫描 messages 里的 `[tool-result:` 标记数 = 已完成的工具步数 = plan 下标。
 *   index < plan.length → 调用「已 gate 的」工具 plan[index]（真实走 Permission Gate /
 *     PreApproval Guard / ApprovalStore / Tool Resolver），该调用会 await 审批而挂起；
 *   index === plan.length → 返回 final answer。
 *
 * 用法：
 *   tsx scripts/session-child.ts setup <planB64> <userMsg>
 *   tsx scripts/session-child.ts apply <action> <taskId> <approvalId> <planB64>
 */
import type { ToolSet } from "ai";

import {
  setAgentLoopRunner,
  createAndStartTask,
  applyApprovalDecision,
  type AgentLoopRunnerArgs,
} from "@/lib/agent/task/runtime";
import { getTaskStore } from "@/lib/agent/task/task-store";
import { getSessionStore } from "@/lib/agent/session/session-store";
import type { AgentResult } from "@/lib/agent/loop";

interface PlanStep {
  tool: string;
  input: unknown;
}

function decodePlan(b64: string): PlanStep[] {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
}

function countToolResults(messages: { content: string }[]): number {
  return messages.filter((m) => m.content.includes("[tool-result:")).length;
}

// 注入 deterministic stub runner
function installStub(plan: PlanStep[]): void {
  const stub = async (args: AgentLoopRunnerArgs): Promise<AgentResult> => {
    const step = (await getStepBase(args)) + 1;
    args.onEvent({ type: "agent.step.started", step });
    args.onEvent({ type: "llm.requested", step });

    const index = countToolResults(args.messages);
    if (index < plan.length) {
      const { tool: toolName, input } = plan[index];
      const tools = args.tools as ToolSet;
      const toolDef = tools[toolName];
      const execute = toolDef?.execute as
        | ((i: unknown, o: unknown) => Promise<unknown>)
        | undefined;
      if (!execute) {
        return { answer: `stub: tool missing ${toolName}`, toolCalls: [], steps: step };
      }
      // 调用已 gate 的工具：命中审批会在此 await 挂起（模拟等待人工审批时进程仍在）
      await execute(input, { toolCallId: `stub-${toolName}-${step}`, messages: [] });
      // 正常不会到这里（同进程无人审批）；到此说明被同进程 approve，返回占位
      return { answer: "", toolCalls: [], steps: step };
    }

    // 所有计划工具已完成 → final answer
    args.onEvent({ type: "message.started", step });
    args.onEvent({ type: "message.delta", step, content: "all planned tools done" });
    args.onEvent({ type: "message.completed", step });
    args.onEvent({ type: "agent.step.completed", step, toolCalls: 0 });
    return { answer: "all planned tools done", toolCalls: [], steps: step };
  };
  setAgentLoopRunner(stub);
}

// 以当前 task.currentStep 作为 step 基准，保证跨进程 step 单调递增
async function getStepBase(args: AgentLoopRunnerArgs): Promise<number> {
  const task = await getTaskStore().get(args.taskId);
  return task?.currentStep ?? 0;
}

// PLACEHOLDER_MAIN

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 轮询直到 task 状态命中其一（或超时）
async function waitForStatus(
  taskId: string,
  targets: string[],
  maxTries = 300,
): Promise<string | undefined> {
  const store = getTaskStore();
  for (let i = 0; i < maxTries; i += 1) {
    const task = await store.get(taskId);
    if (task && targets.includes(task.status)) return task.status;
    await sleep(100);
  }
  return (await store.get(taskId))?.status;
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "setup") {
    const plan = decodePlan(process.argv[3]);
    const userMsg = process.argv[4] ?? "请按计划执行工具";
    installStub(plan);
    const task = await createAndStartTask({
      messages: [{ role: "user", content: userMsg }],
      maxSteps: 8,
    });
    const session = await getSessionStore().getByTaskId(task.id);
    console.log(
      JSON.stringify({ taskId: task.id, sessionId: session?.sessionId }),
    );
    // 等到任务进入 waiting（第一个审批就绪），然后「崩溃」退出 —— 模拟等待审批时进程重启
    await waitForStatus(task.id, ["waiting", "completed", "failed", "cancelled"]);
    process.exit(0);
  } else if (mode === "apply") {
    const action = process.argv[3] as "approve" | "reject";
    const taskId = process.argv[4];
    const approvalId = process.argv[5];
    const plan = decodePlan(process.argv[6]);
    installStub(plan);
    const result = await applyApprovalDecision(taskId, approvalId, action);
    // resume 后 reenterAgentLoop 是后台执行，等任务离开 running 再退出
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
