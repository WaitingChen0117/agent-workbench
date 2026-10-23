import type { WorkflowExecution } from "@/lib/agent/workflow/types";

/**
 * 内存 Workflow Execution Store：Map<executionId, WorkflowExecution>
 * Execution 完成后保留，供 Query API 查询。
 */
const globalRef = globalThis as typeof globalThis & {
  __workflowExecutions?: Map<string, WorkflowExecution>;
};

const executions: Map<string, WorkflowExecution> =
  globalRef.__workflowExecutions ??
  (globalRef.__workflowExecutions = new Map());

export function putExecution(execution: WorkflowExecution): void {
  executions.set(execution.executionId, execution);
}

export function getExecution(executionId: string): WorkflowExecution | undefined {
  return executions.get(executionId);
}
