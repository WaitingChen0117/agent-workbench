/**
 * Agent Permission Policy
 *
 * 所有 Tool 执行前都要经过权限策略，Agent 不能「想执行就执行」。
 * - allow：直接执行
 * - approval_required：进入 Human-in-the-loop 审批，批准后才执行
 *
 * 安全默认：未知工具一律视为需要审批。
 */
export type ToolPermission = "allow" | "approval_required";

const TOOL_POLICY: Record<string, ToolPermission> = {
  // 只读 / 无副作用 → 允许
  listFiles: "allow",
  readFile: "allow",
  searchFiles: "allow",
  searchKnowledge: "allow",
  getCurrentTime: "allow",

  // Git 只读工具 → 允许（无需审批）
  gitStatus: "allow",
  gitDiff: "allow",
  gitLog: "allow",
  gitBranch: "allow",
  gitShow: "allow",

  // 有副作用 → 需要人工审批
  writeFile: "approval_required",
  runCommand: "approval_required",
  // 为未来预留（本阶段未实现）：gitAdd / gitCommit / gitPush 将是 approval_required
};

export function getToolPermission(toolName: string): ToolPermission {
  return TOOL_POLICY[toolName] ?? "approval_required";
}
