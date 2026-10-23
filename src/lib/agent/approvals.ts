import {
  getApprovalStore,
  type AgentApproval,
  type ApprovalAction,
  type ApprovalStatus,
} from "@/lib/agent/approval/approval-store";
import {
  registerWaiter,
  resolveWaiter,
} from "@/lib/agent/approval/waiter";

/**
 * Approval 门面（保持历史 API 兼容）：状态走持久化 ApprovalStore，
 * 等待走进程内 waiter。两者分离，使 Approval 可跨进程恢复。
 */
export type { AgentApproval, ApprovalAction, ApprovalStatus };

export interface CreatedApproval {
  approval: AgentApproval;
  // Agent Loop / Workflow 在工具执行处 await 它，直到被 approve / reject（仅同进程有效）
  decision: Promise<Exclude<ApprovalStatus, "pending">>;
}

export async function createApproval(
  taskId: string,
  toolName: string,
  input: unknown,
): Promise<CreatedApproval> {
  const approval = await getApprovalStore().create({ taskId, toolName, input });
  const decision = registerWaiter(approval.id);
  return { approval, decision };
}

export async function getApproval(id: string): Promise<AgentApproval | null> {
  return getApprovalStore().get(id);
}

export async function listApprovals(taskId: string): Promise<AgentApproval[]> {
  return getApprovalStore().getByTaskId(taskId);
}

/**
 * 原子解析 Approval：pending → approved/rejected（持久化），并尝试唤醒同进程 waiter。
 * 返回 { approval, hadWaiter }；若已非 pending / 不存在则返回 null（幂等，不重复执行）。
 */
export async function resolveApprovalState(
  id: string,
  action: ApprovalAction,
): Promise<{ approval: AgentApproval; hadWaiter: boolean } | null> {
  const approval = await getApprovalStore().resolve(id, action);
  if (!approval) return null;
  const hadWaiter = resolveWaiter(
    id,
    action === "approve" ? "approved" : "rejected",
  );
  return { approval, hadWaiter };
}
