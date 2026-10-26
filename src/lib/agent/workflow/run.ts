import { randomUUID } from "node:crypto";

import type { ToolSet } from "ai";

import { streamAgent, MAX_AGENT_STEPS } from "@/lib/agent/loop";
import { getTaskStore } from "@/lib/agent/task/task-store";
import {
  emit,
  makeLoopEventHandler,
  wrapToolsWithPermissions,
} from "@/lib/agent/task/runtime";
import * as eventBus from "@/lib/agent/task/event-bus";
import { resolveTools } from "@/lib/agent/tool-resolver";
import { loadSkillInstructions } from "@/lib/agent/skills";
import { createApproval } from "@/lib/agent/approvals";
import { getApprovalStore } from "@/lib/agent/approval/approval-store";
import { preApprovalGuard } from "@/lib/agent/guard";
import { startTrace } from "@/lib/agent/trace/collector";
import {
  sanitizeToolInput,
  sanitizeToolOutput,
} from "@/lib/agent/trace/sanitize";
import {
  runWorkflow,
  resolveNext,
  type WorkflowExecutors,
} from "@/lib/agent/workflow/engine";
import {
  getWorkflowExecutionStore,
  type WorkflowExecutionStore,
} from "@/lib/agent/workflow/execution-store";
import { validateWorkflow } from "@/lib/agent/workflow/validator";
import type {
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowNode,
} from "@/lib/agent/workflow/types";

/**
 * Workflow Task Runtime（Phase 10.5：持久化 + 跨进程 Resume）
 *
 * 复用现有 Task lifecycle / SSE / Trace / Permission / Approval / Agent Loop。
 * WorkflowExecution / NodeExecution / context 持久化到 WorkflowExecutionStore；
 * Engine 每执行一个节点即持久化，崩溃后可从 waiting 节点跨进程恢复、已完成节点不重跑。
 */
function nowIso(): string {
  return new Date().toISOString();
}

const taskStore = getTaskStore();
const execStore: WorkflowExecutionStore = getWorkflowExecutionStore();

const WORKSPACE_ROOT = process.cwd();

interface ExecutorContext {
  taskId: string;
  execution: WorkflowExecution;
  definition: WorkflowDefinition;
  tools: ToolSet; // 已 resolve + permission 包装
  skillInstructions: string;
  abortController: AbortController;
  toolSeq: { n: number };
}

// PLACEHOLDER_EXECUTORS

function buildExecutors(ctx: ExecutorContext): WorkflowExecutors {
  const { taskId, execution } = ctx;
  const executionId = execution.executionId;

  const persistExecution = async (): Promise<void> => {
    await execStore.update(executionId, {
      status: execution.status,
      currentNodeId: execution.currentNodeId,
      endedAt: execution.endedAt,
      error: execution.error,
      context: execution.context,
      stepCount: execution.stepCount,
    });
  };

  return {
    emitWorkflow(type) {
      emit(taskId, type, {
        workflowId: execution.workflowId,
        executionId,
      });
    },

    emitNode(type, node) {
      emit(taskId, type, {
        workflowId: execution.workflowId,
        executionId,
        nodeId: node.id,
        nodeType: node.type,
      });
    },

    async persistNodeRunning(node) {
      const existing = await execStore.getNode(executionId, node.id);
      // resume 场景：已 completed 的节点绝不回退/重跑
      if (existing?.status === "completed") return;
      await execStore.upsertNode({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
        status: "running",
        startedAt: existing?.startedAt ?? nowIso(),
        approvalId: existing?.approvalId,
        attempt: existing?.attempt ?? 1,
      });
    },

    async persistNodeCompleted(node, result, branch) {
      const existing = await execStore.getNode(executionId, node.id);
      await execStore.upsertNode({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
        status: "completed",
        startedAt: existing?.startedAt ?? nowIso(),
        endedAt: nowIso(),
        result:
          result === undefined
            ? undefined
            : sanitizeToolOutput(node.id, result),
        approvalId: existing?.approvalId,
        branch,
        attempt: existing?.attempt ?? 1,
      });
    },

    async persistNodeFailed(node, error) {
      const existing = await execStore.getNode(executionId, node.id);
      await execStore.upsertNode({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
        status: "failed",
        startedAt: existing?.startedAt ?? nowIso(),
        endedAt: nowIso(),
        error,
        attempt: existing?.attempt ?? 1,
      });
    },

    persistExecution,

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

      // 经由 permission 包装后的 execute；approval_required 工具会在此触发审批并阻塞。
      const execute = tool.execute as (
        input: unknown,
        options: unknown,
      ) => Promise<unknown>;
      const output = await execute(input, {
        toolCallId: `wf-${step}`,
        messages: [],
      });

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

      // 关联 approvalId 到该审批节点，供跨进程 resume 定位
      await execStore.upsertNode({
        executionId,
        nodeId: node.id,
        nodeType: node.type,
        status: "waiting",
        startedAt: nowIso(),
        approvalId: approval.id,
        attempt: 1,
      });

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

// 把 Workflow 终态映射到 Task 终态（若 Task 尚未被 gate 终态化）
async function finalizeTask(execution: WorkflowExecution): Promise<void> {
  const taskId = execution.taskId;
  const current = (await taskStore.get(taskId))?.status;
  if (current !== "running" && current !== "waiting") return;

  if (execution.status === "completed") {
    await taskStore.update(taskId, {
      answer: JSON.stringify(execution.context).slice(0, 4000),
    });
    await taskStore.transition(taskId, "completed");
    emit(taskId, "task.completed", { executionId: execution.executionId });
  } else if (execution.status === "cancelled") {
    await taskStore.transition(taskId, "cancelled");
    emit(taskId, "task.cancelled", { executionId: execution.executionId });
  } else if (execution.status === "failed") {
    await taskStore.update(taskId, {
      error: execution.error ?? { code: "WORKFLOW_FAILED", message: "failed" },
    });
    await taskStore.transition(taskId, "failed");
    emit(taskId, "task.failed", execution.error);
  }
}

// 共享执行体：首次运行与 resume 都走这里（resume 时传 resumeFromNodeId）。
async function runWorkflowExecution(
  execution: WorkflowExecution,
  definition: WorkflowDefinition,
  options: { resumeFromNodeId?: string } = {},
): Promise<void> {
  const taskId = execution.taskId;
  const abortController = new AbortController();
  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));

  // 订阅 gate / approval 事件：approval_required 的「工具节点」由 gate 创建审批，
  // 这里把 approvalId 关联到当前 waiting 节点并把 execution 置 waiting（不绕过 gate）。
  const unsub = eventBus.subscribe(taskId, (e) => {
    if (e.type !== "approval.required") return;
    const approvalId = (e.data as { approvalId?: string }).approvalId;
    const nodeId = execution.currentNodeId;
    if (!approvalId || !nodeId) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;
    void (async () => {
      const existing = await execStore.getNode(execution.executionId, nodeId);
      await execStore.upsertNode({
        executionId: execution.executionId,
        nodeId,
        nodeType: node.type,
        status: "waiting",
        startedAt: existing?.startedAt ?? nowIso(),
        approvalId,
        attempt: existing?.attempt ?? 1,
      });
      await execStore.update(execution.executionId, { status: "waiting" });
    })();
  });

  try {
    const [baseTools, skillInstructions] = await Promise.all([
      resolveTools(),
      loadSkillInstructions(),
    ]);
    const tools = wrapToolsWithPermissions(baseTools, { taskId, abortController });
    const executors = buildExecutors({
      taskId,
      execution,
      definition,
      tools,
      skillInstructions,
      abortController,
      toolSeq: { n: execution.stepCount ?? 0 },
    });

    await runWorkflow(definition, execution, executors, options);
    await finalizeTask(execution);
  } catch (error) {
    execution.status = "failed";
    execution.error = {
      code: "WORKFLOW_ERROR",
      message: error instanceof Error ? error.message : "workflow error",
    };
    execution.endedAt = nowIso();
    await execStore.update(execution.executionId, {
      status: "failed",
      error: execution.error,
      endedAt: execution.endedAt,
      context: execution.context,
      stepCount: execution.stepCount,
    });
    const status = (await taskStore.get(taskId))?.status;
    if (status !== "failed" && status !== "cancelled" && status !== "completed") {
      await taskStore.transition(taskId, "failed");
      emit(taskId, "task.failed", execution.error);
    }
  } finally {
    unsub();
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
    stepCount: 0,
    definition,
  };
  await execStore.create(execution);

  void (async () => {
    await taskStore.transition(task.id, "running");
    emit(task.id, "task.started");
    await runWorkflowExecution(execution, definition);
  })();

  return execution;
}

export interface WorkflowResumeResult {
  ok: boolean;
  status?: string;
  reason?: string;
}

/**
 * 跨进程恢复一个 waiting 的 Workflow（审批已 approved 后调用）。
 * 重跑 Guard → 执行被批准工具一次 → 恢复 context → 从下一个节点继续 DAG。
 */
export async function resumeWorkflowExecution(
  executionId: string,
): Promise<WorkflowResumeResult> {
  const execution = await execStore.get(executionId);
  if (!execution) return { ok: false, reason: "not_found" };
  if (execution.status !== "waiting") {
    return { ok: true, status: execution.status }; // 幂等
  }

  const definition = execution.definition;
  if (!definition || !validateWorkflow(definition).valid) {
    return failWorkflow(execution, "RESUME_INVALID", "workflow definition invalid");
  }

  const nodes = await execStore.listNodes(executionId);
  const waiting = nodes.find((n) => n.status === "waiting");
  if (!waiting) {
    return failWorkflow(
      execution,
      "RESUME_NO_WAITING_NODE",
      "no waiting node to resume",
    );
  }

  const node = definition.nodes.find((n) => n.id === waiting.nodeId);
  if (!node) {
    return failWorkflow(execution, "RESUME_NODE_MISSING", "waiting node not in def");
  }

  // Agent 节点跨进程 resume：工作流内 Agent 节点无持久化会话，诚实标记不支持。
  if (node.type === "agent") {
    return failWorkflow(
      execution,
      "RESUME_UNSUPPORTED",
      "agent node cannot be resumed across process",
    );
  }

  // 定位审批记录（已被 applyApprovalDecision 置为 approved）
  const approvalId = waiting.approvalId;
  const approval = approvalId
    ? await getApprovalStore().get(approvalId)
    : null;

  await execStore.transition(executionId, "running");
  await taskStore.transition(execution.taskId, "running").catch(() => undefined);

  // 若为 approval_required 的「工具节点」：重跑 Guard + 执行被批准工具恰好一次
  if (node.type === "tool") {
    const toolName = String(node.config?.tool ?? "");
    const input = (approval?.input ?? node.config?.input ?? {}) as Record<
      string,
      unknown
    >;
    const guard = await preApprovalGuard(toolName, input, WORKSPACE_ROOT);
    if (!guard.ok) {
      return failWorkflow(
        execution,
        "RESUME_GUARD_DENIED",
        guard.error ?? "guard denied",
      );
    }
    const tools = await resolveTools();
    const tool = tools[toolName];
    if (!tool || typeof tool.execute !== "function") {
      return failWorkflow(
        execution,
        "RESUME_UNSUPPORTED",
        `tool not found: ${toolName}`,
      );
    }
    const step = (execution.stepCount ?? 0) + 1;
    emit(execution.taskId, "tool.started", {
      step,
      tool: toolName,
      input: sanitizeToolInput(toolName, input),
    });
    const execute = tool.execute as (i: unknown, o: unknown) => Promise<unknown>;
    const output = await execute(input, {
      toolCallId: `resume-${approvalId}`,
      messages: [],
    });
    const safe = sanitizeToolOutput(toolName, output);
    emit(execution.taskId, "tool.completed", {
      step,
      tool: toolName,
      success: (output as { success?: boolean })?.success !== false,
      result: safe,
    });
    const key =
      (node.config?.output as string) ?? `${String(node.config?.tool ?? "tool")}Result`;
    execution.context[key] = safe;
    execution.stepCount = step;
    await execStore.upsertNode({
      executionId,
      nodeId: node.id,
      nodeType: node.type,
      status: "completed",
      startedAt: waiting.startedAt ?? nowIso(),
      endedAt: nowIso(),
      result: safe,
      approvalId,
      attempt: waiting.attempt,
    });
  } else if (node.type === "approval") {
    // 审批节点：approval 已 approved，节点直接完成（本身不执行工具）
    emit(execution.taskId, "approval.approved", {
      approvalId,
      toolName: String(node.config?.toolName ?? "workflow"),
    });
    await execStore.upsertNode({
      executionId,
      nodeId: node.id,
      nodeType: node.type,
      status: "completed",
      startedAt: waiting.startedAt ?? nowIso(),
      endedAt: nowIso(),
      result: { decision: "approved" },
      approvalId,
      attempt: waiting.attempt,
    });
  }

  await execStore.update(executionId, {
    status: "running",
    context: execution.context,
    stepCount: execution.stepCount,
    currentNodeId: node.id,
  });

  // 从「被批准节点的下一个节点」继续 DAG（前序已完成节点不重跑）
  const next = resolveNext(definition, node.id, false, undefined);
  if (!next) {
    execution.status = "completed";
    execution.endedAt = nowIso();
    await execStore.update(executionId, {
      status: "completed",
      endedAt: execution.endedAt,
      context: execution.context,
    });
    emit(execution.taskId, "workflow.completed", {
      workflowId: execution.workflowId,
      executionId,
    });
    await finalizeTask(execution);
    return { ok: true, status: "completed" };
  }

  // 后台继续执行，不阻塞决策返回
  const fresh = (await execStore.get(executionId)) ?? execution;
  fresh.definition = definition;
  void runWorkflowExecution(fresh, definition, { resumeFromNodeId: next });
  return { ok: true, status: "resumed" };
}

async function failWorkflow(
  execution: WorkflowExecution,
  code: string,
  message: string,
): Promise<WorkflowResumeResult> {
  execution.status = "failed";
  execution.error = { code, message };
  execution.endedAt = nowIso();
  await execStore.update(execution.executionId, {
    status: "failed",
    error: execution.error,
    endedAt: execution.endedAt,
  });
  await taskStore
    .update(execution.taskId, { error: { code, message } })
    .catch(() => undefined);
  const status = (await taskStore.get(execution.taskId))?.status;
  if (status === "running" || status === "waiting") {
    await taskStore.transition(execution.taskId, "failed");
  }
  emit(execution.taskId, "workflow.failed", {
    workflowId: execution.workflowId,
    executionId: execution.executionId,
    code,
  });
  emit(execution.taskId, "task.failed", { code, message });
  return { ok: false, reason: code };
}

/**
 * 跨进程 reject 一个 waiting 的 Workflow：execution → cancelled，Task → cancelled。
 */
export async function rejectWorkflowExecution(
  executionId: string,
): Promise<WorkflowResumeResult> {
  const execution = await execStore.get(executionId);
  if (!execution) return { ok: false, reason: "not_found" };
  if (execution.status !== "waiting") {
    return { ok: true, status: execution.status };
  }

  const nodes = await execStore.listNodes(executionId);
  const waiting = nodes.find((n) => n.status === "waiting");
  if (waiting) {
    await execStore.upsertNode({
      ...waiting,
      status: "completed",
      endedAt: nowIso(),
      result: { decision: "rejected" },
    });
    emit(execution.taskId, "approval.rejected", {
      approvalId: waiting.approvalId,
      toolName: String(
        execution.definition?.nodes.find((n) => n.id === waiting.nodeId)?.config
          ?.toolName ?? "workflow",
      ),
    });
  }

  execution.status = "cancelled";
  execution.endedAt = nowIso();
  await execStore.update(executionId, {
    status: "cancelled",
    endedAt: execution.endedAt,
  });
  emit(execution.taskId, "workflow.failed", {
    workflowId: execution.workflowId,
    executionId,
    reason: "rejected",
  });
  if ((await taskStore.get(execution.taskId))?.status === "waiting") {
    await taskStore.transition(execution.taskId, "cancelled");
    emit(execution.taskId, "task.cancelled", { reason: "approval rejected" });
  }
  return { ok: true, status: "cancelled" };
}
