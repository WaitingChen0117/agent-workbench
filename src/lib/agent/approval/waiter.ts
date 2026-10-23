import type { ApprovalStatus } from "@/lib/agent/approval/approval-store";

/**
 * ApprovalWaiter —— 进程内的「等待者」注册表。
 *
 * Promise 无法持久化：Approval 的「状态」存 SQLite（可跨进程），
 * 而「正在 await 的执行」只能活在当前进程。重启后原进程的 waiter 消失，
 * 此时由 resume 路径（执行被批准的工具一次）代替，而不是依赖原 Promise。
 */
type Resolver = (status: Exclude<ApprovalStatus, "pending">) => void;

const globalRef = globalThis as typeof globalThis & {
  __agentApprovalWaiters?: Map<string, Resolver>;
};

const waiters: Map<string, Resolver> =
  globalRef.__agentApprovalWaiters ??
  (globalRef.__agentApprovalWaiters = new Map());

export function registerWaiter(
  approvalId: string,
): Promise<Exclude<ApprovalStatus, "pending">> {
  return new Promise((resolve) => {
    waiters.set(approvalId, resolve);
  });
}

export function hasWaiter(approvalId: string): boolean {
  return waiters.has(approvalId);
}

export function resolveWaiter(
  approvalId: string,
  status: Exclude<ApprovalStatus, "pending">,
): boolean {
  const resolver = waiters.get(approvalId);
  if (!resolver) return false;
  waiters.delete(approvalId);
  resolver(status);
  return true;
}
