/**
 * 持久化故障注入 seam（Phase 10.8，仅测试用）
 *
 * 默认关闭：AGENT_PERSISTENCE_TEST_FAILURE 未设置时恒为 no-op。
 * 设置后为逗号分隔的注入点列表，命中则抛错，用于确定性验证 rollback / 错误处理。
 * 生产不会因误设而产生危险行为——它只会让对应写入抛错并回滚（安全失败），不会伪造成功。
 */
export function shouldInjectFailure(point: string): boolean {
  const raw = process.env.AGENT_PERSISTENCE_TEST_FAILURE;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .includes(point);
}

export function maybeThrowInjectedFailure(point: string): void {
  if (shouldInjectFailure(point)) {
    throw new Error(`injected persistence failure at: ${point}`);
  }
}
