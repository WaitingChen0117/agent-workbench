import { validateWorkflow } from "@/lib/agent/workflow/validator";
import type {
  ConditionNodeConfig,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowExecution,
  WorkflowNode,
} from "@/lib/agent/workflow/types";

/**
 * Workflow Engine —— 纯编排，节点的真实执行由注入的 executors 完成（复用现有 Agent/Tool/Approval 基建）。
 */
export interface WorkflowExecutors {
  runAgentNode(node: WorkflowNode, context: Record<string, unknown>): Promise<unknown>;
  runToolNode(node: WorkflowNode, context: Record<string, unknown>): Promise<unknown>;
  runApprovalNode(
    node: WorkflowNode,
    context: Record<string, unknown>,
  ): Promise<"approved" | "rejected">;
  emitNode(
    type:
      | "workflow.node.started"
      | "workflow.node.completed"
      | "workflow.node.failed",
    node: WorkflowNode,
  ): void;
  emitWorkflow(
    type: "workflow.started" | "workflow.completed" | "workflow.failed",
  ): void;
  // Phase 10.5：节点/执行态持久化钩子（Memory 实现为 no-op 亦可）
  persistNodeRunning(node: WorkflowNode): Promise<void>;
  persistNodeCompleted(
    node: WorkflowNode,
    result: unknown,
    branch?: "true" | "false",
  ): Promise<void>;
  persistNodeFailed(
    node: WorkflowNode,
    error: { code: string; message: string },
  ): Promise<void>;
  persistExecution(): Promise<void>;
}

const MAX_CONTEXT_STRING = 4000;

function nowIso(): string {
  return new Date().toISOString();
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function evalCondition(
  node: WorkflowNode,
  context: Record<string, unknown>,
): boolean {
  const config = (node.config ?? {}) as unknown as ConditionNodeConfig;
  const actual = getByPath(context, config.field);

  switch (config.operator) {
    case "equals":
      return actual === config.value;
    case "notEquals":
      return actual !== config.value;
    case "exists":
      return actual !== undefined && actual !== null;
    default:
      return false;
  }
}

// 写回 context，避免无界增长：长字符串截断
function writeContext(
  execution: WorkflowExecution,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > MAX_CONTEXT_STRING) {
    execution.context[key] = value.slice(0, MAX_CONTEXT_STRING) + "…";
  } else {
    execution.context[key] = value;
  }
}

export function resolveNext(
  def: WorkflowDefinition,
  nodeId: string,
  isCondition: boolean,
  branch: "true" | "false" | undefined,
): string | undefined {
  const outgoing: WorkflowEdge[] = def.edges.filter((e) => e.source === nodeId);
  if (outgoing.length === 0) {
    return undefined;
  }

  if (isCondition) {
    const match = outgoing.find((e) => e.condition?.branch === branch);
    if (match) return match.target;
    // 回退到无 condition 的边
    const fallback = outgoing.find((e) => !e.condition);
    return fallback?.target ?? outgoing[0].target;
  }

  // 非 condition 节点：优先无条件边
  const unconditional = outgoing.find((e) => !e.condition);
  return (unconditional ?? outgoing[0]).target;
}

export interface RunWorkflowOptions {
  // Phase 10.5：从指定节点恢复执行（context 已预加载，前序已完成节点不再重跑）。
  resumeFromNodeId?: string;
}

export async function runWorkflow(
  def: WorkflowDefinition,
  execution: WorkflowExecution,
  executors: WorkflowExecutors,
  options: RunWorkflowOptions = {},
): Promise<void> {
  const validation = validateWorkflow(def);
  if (!validation.valid || !validation.startNodeId) {
    execution.status = "failed";
    execution.error = {
      code: "WORKFLOW_INVALID",
      message: validation.errors.join("; "),
    };
    execution.endedAt = nowIso();
    await executors.persistExecution();
    executors.emitWorkflow("workflow.failed");
    return;
  }

  const resuming = !!options.resumeFromNodeId;
  if (!resuming) {
    executors.emitWorkflow("workflow.started");
  }

  const nodeMap = new Map(def.nodes.map((n) => [n.id, n]));
  const maxSteps = def.maxSteps ?? 100;
  let currentId: string | undefined =
    options.resumeFromNodeId ?? validation.startNodeId;
  let steps = execution.stepCount ?? 0;

  while (currentId) {
    steps += 1;
    execution.stepCount = steps;
    if (steps > maxSteps) {
      execution.status = "failed";
      execution.error = {
        code: "WORKFLOW_MAX_STEPS",
        message: `exceeded maxSteps (${maxSteps})`,
      };
      execution.endedAt = nowIso();
      await executors.persistExecution();
      executors.emitWorkflow("workflow.failed");
      return;
    }

    const node = nodeMap.get(currentId) as WorkflowNode;
    execution.currentNodeId = currentId;
    await executors.persistNodeRunning(node);
    await executors.persistExecution();
    executors.emitNode("workflow.node.started", node);

    let branch: "true" | "false" | undefined;

    try {
      switch (node.type) {
        case "agent": {
          const result = await executors.runAgentNode(node, execution.context);
          writeContext(
            execution,
            (node.config?.output as string) ?? "agentResult",
            result,
          );
          await executors.persistNodeCompleted(node, result);
          break;
        }
        case "tool": {
          const result = await executors.runToolNode(node, execution.context);
          const key =
            (node.config?.output as string) ??
            `${String(node.config?.tool ?? "tool")}Result`;
          writeContext(execution, key, result);
          await executors.persistNodeCompleted(node, result);
          break;
        }
        case "approval": {
          const decision = await executors.runApprovalNode(
            node,
            execution.context,
          );
          if (decision === "rejected") {
            await executors.persistNodeCompleted(node, { decision });
            executors.emitNode("workflow.node.completed", node);
            execution.status = "cancelled";
            execution.endedAt = nowIso();
            await executors.persistExecution();
            executors.emitWorkflow("workflow.failed");
            return;
          }
          await executors.persistNodeCompleted(node, { decision });
          break;
        }
        case "condition": {
          branch = evalCondition(node, execution.context) ? "true" : "false";
          writeContext(execution, `${node.id}.branch`, branch);
          await executors.persistNodeCompleted(node, { branch }, branch);
          break;
        }
        case "end": {
          await executors.persistNodeCompleted(node, undefined);
          executors.emitNode("workflow.node.completed", node);
          execution.status = "completed";
          execution.endedAt = nowIso();
          await executors.persistExecution();
          executors.emitWorkflow("workflow.completed");
          return;
        }
      }

      await executors.persistExecution();
      executors.emitNode("workflow.node.completed", node);
    } catch (error) {
      const err = {
        code: "NODE_FAILED",
        message: error instanceof Error ? error.message : "node failed",
      };
      await executors.persistNodeFailed(node, err);
      executors.emitNode("workflow.node.failed", node);
      // 若节点执行中已被取消（如工具审批被拒），保持 cancelled，不覆盖为 failed
      if (execution.status !== "cancelled") {
        execution.status = "failed";
        execution.error = err;
      }
      execution.endedAt = nowIso();
      await executors.persistExecution();
      executors.emitWorkflow("workflow.failed");
      return;
    }

    const next = resolveNext(def, currentId, node.type === "condition", branch);
    if (!next) {
      execution.status = "completed";
      execution.endedAt = nowIso();
      await executors.persistExecution();
      executors.emitWorkflow("workflow.completed");
      return;
    }
    currentId = next;
  }
}
