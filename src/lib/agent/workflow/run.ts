import { randomUUID } from "node:crypto";

import type { ToolSet } from "ai";

import { streamAgent, MAX_AGENT_STEPS } from "@/lib/agent/loop";
import { getTaskStore } from "@/lib/agent/task/task-store";
import {
  emit,
  makeLoopEventHandler,
  wrapToolsWithPermissions,
} from "@/lib/agent/task/runtime";
import { resolveTools } from "@/lib/agent/tool-resolver";
import { loadSkillInstructions } from "@/lib/agent/skills";
import { createApproval } from "@/lib/agent/approvals";
import { startTrace } from "@/lib/agent/trace/collector";
import {
  sanitizeToolInput,
  sanitizeToolOutput,
} from "@/lib/agent/trace/sanitize";
import { runWorkflow, type WorkflowExecutors } from "@/lib/agent/workflow/engine";
import { putExecution } from "@/lib/agent/workflow/execution-store";
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
} from "@/lib/agent/workflow/types";

/**
 * Workflow Task Runtime
 *
 * 把 Workflow Engine 跑在现有 Task 内：复用 Task lifecycle / SSE / Trace / Permission / Approval。
 * Engine 负责节点编排与 context，节点的真实执行由这里注入的 executors 用现有基建完成。
 */

function nowIso(): string {
  return new Date().toISOString();
}

const taskStore = getTaskStore();

interface ExecutorContext {
  taskId: string;
  execution: WorkflowExecution;
  tools: ToolSet; // 已 resolve + permission 包装
  skillInstructions: string;
  abortController: AbortController;
  toolSeq: { n: number };
}

function buildExecutors(ctx: ExecutorContext): WorkflowExecutors {
  const { taskId, execution } = ctx;

  return {
    emitWorkflow(type) {
      emit(taskId, type, {
        workflowId: execution.workflowId,
        executionId: execution.executionId,
      });
    },

    emitNode(type, node) {
      emit(taskId, type, {
        workflowId: execution.workflowId,
        executionId: execution.executionId,
        nodeId: node.id,
        nodeType: node.type,
      });
    },

    async runAgentNode(node: WorkflowNode, context) {
      const instructions = String(node.config?.instructions ?? "继续完成当前步骤。");
      const contextHint = `\n\n[workflow context]\n${JSON.stringify(context).slice(0, 2000)}`;
      const result = await streamAgent({
        messages: [{ role: "user", content: instructions + contextHint }],
        tools: ctx.tools,
        instructions: ctx.skillInstructions,
        maxSteps: Number(node.config?.maxSteps ?? MAX_AGENT_STEPS),
        abortSignal: ctx.abortController.signal,
        onEvent: makeLoopEventHandler(taskId),
      });
      return { answer: result.answer, steps: result.steps };
    },

    async runToolNode(node: WorkflowNode, context) {
      const toolName = String(node.config?.tool ?? "");
      const tool = ctx.tools[toolName];
      if (!tool || typeof tool.execute !== "function") {
        throw new Error(`tool not found: ${toolName}`);
      }

      const input = (node.config?.input ?? {}) as Record<string, unknown>;
      const step = (ctx.toolSeq.n += 1);

      emit(taskId, "tool.started", {
        step,
        tool: toolName,
        input: sanitizeToolInput(toolName, input),
      });

      // 经由 permission 包装后的 execute；writeFile/runCommand 会在此触发审批。
      // 各工具 execute 均忽略第二参 options，这里传占位值。
      const execute = tool.execute as (
        input: unknown,
        options: unknown,
      ) => Promise<unknown>;
      const output = await execute(input, {
        toolCallId: `wf-${step}`,
        messages: [],
      });

      // 若审批被拒，permission gate 会把 task 置 cancelled 并中止
      if ((await taskStore.get(taskId))?.status === "cancelled") {
        execution.status = "cancelled";
        throw new Error("tool approval rejected");
      }

      const safe = sanitizeToolOutput(toolName, output);
      emit(taskId, "tool.completed", {
        step,
        tool: toolName,
        success: (output as { success?: boolean })?.success !== false,
        result: safe,
      });
      void context;
      return safe;
    },

    async runApprovalNode(node: WorkflowNode) {
      const toolName = String(node.config?.toolName ?? "workflow");
      const reason = String(node.config?.reason ?? "Workflow step requires approval");
      const { approval, decision } = await createApproval(taskId, toolName, { reason });

      if ((await taskStore.get(taskId))?.status === "running") {
        await taskStore.transition(taskId, "waiting");
      }
      emit(taskId, "approval.required", {
        approvalId: approval.id,
        toolName,
        reason,
        input: { reason },
      });

      const status = await decision;

      if (status === "approved") {
        if ((await taskStore.get(taskId))?.status === "waiting") {
          await taskStore.transition(taskId, "running");
        }
        emit(taskId, "approval.approved", { approvalId: approval.id, toolName });
        return "approved";
      }

      emit(taskId, "approval.rejected", { approvalId: approval.id, toolName });
      return "rejected";
    },
  };
}

// PLACEHOLDER_RUN
async function runWorkflowTask(
  definition: WorkflowDefinition,
  execution: WorkflowExecution,
): Promise<void> {
  const taskId = execution.taskId;
  await taskStore.transition(taskId, "running");
  emit(taskId, "task.started");

  const abortController = new AbortController();

  try {
    const [baseTools, skillInstructions] = await Promise.all([
      resolveTools(),
      loadSkillInstructions(),
    ]);
    const tools = wrapToolsWithPermissions(baseTools, { taskId, abortController });

    const executors = buildExecutors({
      taskId,
      execution,
      tools,
      skillInstructions,
      abortController,
      toolSeq: { n: 0 },
    });

    await runWorkflow(definition, execution, executors);
    putExecution(execution);

    // Workflow 终态 → Task 终态（若尚未被 gate 终态化）
    const current = (await taskStore.get(taskId))?.status;
    if (current === "running" || current === "waiting") {
      if (execution.status === "completed") {
        await taskStore.update(taskId, {
          answer: JSON.stringify(execution.context).slice(0, 4000),
        });
        await taskStore.transition(taskId, "completed");
        emit(taskId, "task.completed", { executionId: execution.executionId });
      } else if (execution.status === "cancelled") {
        await taskStore.transition(taskId, "cancelled");
        emit(taskId, "task.cancelled", { executionId: execution.executionId });
      } else {
        await taskStore.update(taskId, {
          error: execution.error ?? { code: "WORKFLOW_FAILED", message: "failed" },
        });
        await taskStore.transition(taskId, "failed");
        emit(taskId, "task.failed", execution.error);
      }
    }
  } catch (error) {
    execution.status = "failed";
    execution.error = {
      code: "WORKFLOW_ERROR",
      message: error instanceof Error ? error.message : "workflow error",
    };
    execution.endedAt = nowIso();
    putExecution(execution);
    const status = (await taskStore.get(taskId))?.status;
    if (status !== "failed" && status !== "cancelled" && status !== "completed") {
      await taskStore.transition(taskId, "failed");
      emit(taskId, "task.failed", execution.error);
    }
  }
}

/**
 * 创建并启动一个 Workflow Task（异步）。立即返回 Execution，后台执行。
 */
export async function createAndStartWorkflowTask(input: {
  definition: WorkflowDefinition;
  input?: unknown;
}): Promise<WorkflowExecution> {
  const { definition } = input;
  const task = await taskStore.create({
    messages: [{ role: "user", content: `workflow:${definition.name}` }],
    maxSteps: definition.maxSteps ?? 100,
  });
  startTrace(task.id);
  emit(task.id, "task.created");

  const execution: WorkflowExecution = {
    executionId: randomUUID(),
    workflowId: definition.id,
    taskId: task.id,
    status: "running",
    startedAt: nowIso(),
    context: { input: input.input },
  };
  putExecution(execution);

  void runWorkflowTask(definition, execution);

  return execution;
}

