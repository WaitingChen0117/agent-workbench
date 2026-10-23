import type { WorkflowDefinition } from "@/lib/agent/workflow/types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  startNodeId?: string;
}

/**
 * Workflow 执行前的静态校验。第一版不允许环（必须是 DAG），不执行任何 JS。
 */
export function validateWorkflow(def: WorkflowDefinition): ValidationResult {
  const errors: string[] = [];

  if (!def.id || typeof def.id !== "string") {
    errors.push("workflow.id is required");
  }
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push("workflow.nodes must be a non-empty array");
    return { valid: false, errors };
  }
  if (!Array.isArray(def.edges)) {
    errors.push("workflow.edges must be an array");
    return { valid: false, errors };
  }

  // node id 唯一
  const ids = new Set<string>();
  for (const node of def.nodes) {
    if (!node.id) {
      errors.push("every node must have an id");
      continue;
    }
    if (ids.has(node.id)) {
      errors.push(`duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
  }

  // edge source/target 必须存在
  const inDegree = new Map<string, number>();
  for (const id of ids) {
    inDegree.set(id, 0);
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of def.edges) {
    if (!ids.has(edge.source)) {
      errors.push(`edge source not found: ${edge.source}`);
    }
    if (!ids.has(edge.target)) {
      errors.push(`edge target not found: ${edge.target}`);
    }
    if (ids.has(edge.source) && ids.has(edge.target)) {
      adjacency.set(edge.source, [
        ...(adjacency.get(edge.source) ?? []),
        edge.target,
      ]);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
  }

  // 唯一 start node（入度 0）
  const startNodes = [...ids].filter((id) => (inDegree.get(id) ?? 0) === 0);
  if (startNodes.length === 0) {
    errors.push("no start node (every node has an incoming edge → cycle?)");
  } else if (startNodes.length > 1) {
    errors.push(`multiple start nodes: ${startNodes.join(", ")}`);
  }
  const startNodeId = startNodes.length === 1 ? startNodes[0] : undefined;

  // 必须存在 end node
  if (!def.nodes.some((n) => n.type === "end")) {
    errors.push("no end node");
  }

  // DAG：拓扑排序检测环
  if (hasCycle(ids, adjacency)) {
    errors.push("workflow must be a DAG (cycle detected)");
  }

  // 可达性：所有节点必须从 start 可达
  if (startNodeId) {
    const reachable = new Set<string>();
    const queue = [startNodeId];
    while (queue.length) {
      const cur = queue.shift() as string;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const next of adjacency.get(cur) ?? []) queue.push(next);
    }
    for (const id of ids) {
      if (!reachable.has(id)) {
        errors.push(`node not reachable from start: ${id}`);
      }
    }
  }

  if (def.maxSteps !== undefined && (!Number.isInteger(def.maxSteps) || def.maxSteps <= 0)) {
    errors.push("maxSteps must be a positive integer");
  }

  return { valid: errors.length === 0, errors, startNodeId };
}

function hasCycle(
  ids: Set<string>,
  adjacency: Map<string, string[]>,
): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  const dfs = (node: string): boolean => {
    color.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const c = color.get(next);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const id of ids) {
    if (color.get(id) === WHITE && dfs(id)) return true;
  }
  return false;
}
