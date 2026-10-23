/**
 * Workflow / DAG Runtime 数据模型（Phase 8）
 *
 * Workflow 在现有 Task Runtime 之上编排节点：Agent / Tool / Approval / Condition / End。
 * 它不替代 Task Runtime —— cancellation / waiting / approval / SSE / lifecycle 仍由 Task Runtime 负责。
 */

export type WorkflowNodeType =
  | "agent"
  | "tool"
  | "condition"
  | "approval"
  | "end";

export type ConditionOperator = "equals" | "notEquals" | "exists";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  name?: string;
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  source: string;
  target: string;
  // 仅 condition 节点的出边使用：选择 true / false 分支
  condition?: { branch: "true" | "false" };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  maxSteps?: number;
}

export type WorkflowStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  taskId: string;
  status: WorkflowStatus;
  currentNodeId?: string;
  startedAt: string;
  endedAt?: string;
  error?: { code: string; message: string };
  context: Record<string, unknown>;
}

// --- 各节点 config 形状（读取时做窄化，不强依赖） ---

export interface AgentNodeConfig {
  instructions?: string;
  output?: string; // 写回 context 的键名，默认 agentResult
  maxSteps?: number;
}

export interface ToolNodeConfig {
  tool: string;
  input?: Record<string, unknown>;
  output?: string; // 默认 <tool>Result
}

export interface ApprovalNodeConfig {
  toolName?: string; // 展示用途，默认 "workflow"
  reason?: string;
}

export interface ConditionNodeConfig {
  field: string; // 以点号路径读取 context，如 "testResult.exitCode"
  operator: ConditionOperator;
  value?: unknown;
}
