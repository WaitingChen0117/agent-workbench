import type { DatabaseSync } from "node:sqlite";

/**
 * SQLite 可靠性工具（Phase 10.7-D）
 *
 * - 区分「数据库繁忙（可重试）」与其它错误
 * - withBusyRetry：有限次（默认 3）重试 + 退避，绝不无限/长阻塞
 * - tx：BEGIN IMMEDIATE → mutation → COMMIT，失败 ROLLBACK（保证不半写）
 *
 * node:sqlite 为同步 API，故采用同步退避（Atomics.wait），退避时间很短。
 */
export function isBusyError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

export function withBusyRetry<T>(fn: () => T, maxRetries = 3): T {
  let attempt = 0;
  for (;;) {
    try {
      return fn();
    } catch (error) {
      if (isBusyError(error) && attempt < maxRetries) {
        attempt += 1;
        sleepSync(10 * attempt); // 10ms, 20ms, 30ms
        continue;
      }
      throw error;
    }
  }
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  return withBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* rollback best-effort */
      }
      throw error;
    }
  });
}
