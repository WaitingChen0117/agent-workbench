import {
  validateAddPaths,
  validateCommitMessage,
} from "@/lib/mcp/git/core";

/**
 * Pre-approval Guard
 *
 * 某些安全约束必须在「进入审批之前」就拦截 —— Permission Approval ≠ Security Bypass。
 * 例如 gitAdd 敏感文件 / 路径穿越、gitCommit 非法 message：即使人工批准也不应放行，
 * 因此在创建 Approval 之前先做一次确定性校验，不通过直接 DENIED。
 */
export interface GuardResult {
  ok: boolean;
  error?: string;
}

export async function preApprovalGuard(
  toolName: string,
  input: unknown,
  workspaceRoot: string,
): Promise<GuardResult> {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (toolName === "gitAdd") {
    const v = await validateAddPaths(workspaceRoot, obj.paths);
    return v.ok ? { ok: true } : { ok: false, error: v.error };
  }

  if (toolName === "gitCommit") {
    const v = validateCommitMessage(obj.message);
    return v.ok ? { ok: true } : { ok: false, error: v.error };
  }

  return { ok: true };
}
