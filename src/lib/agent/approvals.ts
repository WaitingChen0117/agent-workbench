import { randomUUID } from "node:crypto";

/**
 * Approval Store（Human-in-the-loop）
 *
 * Approval 不是简单的 boolean：它是一个带状态与生命周期的对象，
 * 这样未来可扩展 reason / approvedBy / expiresAt 等字段。
 *
 * ⚠️ 内存实现，挂在 globalThis 兼容 HMR；生产需持久化。
 */
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ApprovalAction = "approve" | "reject";

export interface AgentApproval {
  id: string;
  taskId: string;
  toolName: string;
  input: unknown;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

interface PendingEntry {
  approval: AgentApproval;
  resolve: (status: Exclude<ApprovalStatus, "pending">) => void;
}

interface ApprovalStoreState {
  entries: Map<string, PendingEntry>;
}

const globalRef = globalThis as typeof globalThis & {
  __agentApprovals?: ApprovalStoreState;
};

const state: ApprovalStoreState =
  globalRef.__agentApprovals ??
  (globalRef.__agentApprovals = { entries: new Map() });

export interface CreatedApproval {
  approval: AgentApproval;
  // Agent Loop 在工具执行处 await 它，直到被 approve / reject
  decision: Promise<Exclude<ApprovalStatus, "pending">>;
}

export function createApproval(
  taskId: string,
  toolName: string,
  input: unknown,
): CreatedApproval {
  const approval: AgentApproval = {
    id: randomUUID(),
    taskId,
    toolName,
    input,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  let resolve!: (status: Exclude<ApprovalStatus, "pending">) => void;
  const decision = new Promise<Exclude<ApprovalStatus, "pending">>((r) => {
    resolve = r;
  });

  state.entries.set(approval.id, { approval, resolve });

  return { approval, decision };
}

export function getApproval(id: string): AgentApproval | undefined {
  return state.entries.get(id)?.approval;
}

export function listApprovals(taskId: string): AgentApproval[] {
  return [...state.entries.values()]
    .map((entry) => entry.approval)
    .filter((approval) => approval.taskId === taskId);
}

/**
 * 解析一个待审批项：approve / reject。
 * 返回更新后的 Approval；若不存在或已解析则返回 null。
 */
export function resolveApproval(
  id: string,
  action: ApprovalAction,
): AgentApproval | null {
  const entry = state.entries.get(id);

  if (!entry || entry.approval.status !== "pending") {
    return null;
  }

  const status: Exclude<ApprovalStatus, "pending"> =
    action === "approve" ? "approved" : "rejected";

  entry.approval.status = status;
  entry.approval.resolvedAt = new Date().toISOString();
  entry.resolve(status);

  return entry.approval;
}
