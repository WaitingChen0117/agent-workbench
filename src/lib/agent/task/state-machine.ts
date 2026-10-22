import type { TaskStatus } from "@/lib/agent/task/types";

/**
 * Task 状态机
 *
 * 只允许下列合法转换，杜绝业务代码把 completed → running 这类非法转换写进去。
 *
 *   pending   → running | cancelled
 *   running   → waiting | completed | failed | cancelled
 *   waiting   → running | cancelled | failed
 *   completed → （终态，不可再转换）
 *   failed    → （终态）
 *   cancelled → （终态）
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["waiting", "completed", "failed", "cancelled"],
  waiting: ["running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTaskTransitionError extends Error {
  readonly from: TaskStatus;
  readonly to: TaskStatus;

  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = "InvalidTaskTransitionError";
    this.from = from;
    this.to = to;
  }
}

// 非法转换直接抛错，由调用方（Task Runtime）兜住
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTaskTransitionError(from, to);
  }
}
