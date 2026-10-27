/**
 * Persistence Metrics（Phase 10.8-F）
 *
 * 进程内轻量计数，仅用于诊断。不持久化、不写 SQLite、不引入 Prometheus/OTel。
 * 挂 globalThis 只为跨 HMR/模块实例共享计数（不是持久化事实来源）。
 */
export type PersistenceMetric =
  | "taskCreates"
  | "taskTransitions"
  | "approvalCreates"
  | "approvalResolves"
  | "sessionWrites"
  | "workflowWrites"
  | "traceEventsAppended"
  | "cleanupDeleted"
  | "cleanupSkipped"
  | "persistenceErrors";

export type PersistenceMetrics = Record<PersistenceMetric, number>;

const METRIC_KEYS: PersistenceMetric[] = [
  "taskCreates",
  "taskTransitions",
  "approvalCreates",
  "approvalResolves",
  "sessionWrites",
  "workflowWrites",
  "traceEventsAppended",
  "cleanupDeleted",
  "cleanupSkipped",
  "persistenceErrors",
];

function emptyMetrics(): PersistenceMetrics {
  return METRIC_KEYS.reduce((acc, k) => {
    acc[k] = 0;
    return acc;
  }, {} as PersistenceMetrics);
}

const globalRef = globalThis as typeof globalThis & {
  __agentPersistenceMetrics?: PersistenceMetrics;
};

function state(): PersistenceMetrics {
  return (
    globalRef.__agentPersistenceMetrics ??
    (globalRef.__agentPersistenceMetrics = emptyMetrics())
  );
}

export function incrementPersistenceMetric(
  metric: PersistenceMetric,
  by = 1,
): void {
  const s = state();
  s[metric] = (s[metric] ?? 0) + by;
}

export function getPersistenceMetrics(): PersistenceMetrics {
  return { ...state() };
}

export function resetPersistenceMetrics(): void {
  globalRef.__agentPersistenceMetrics = emptyMetrics();
}
