/**
 * 统一分页类型/工具（Phase 10.7-C）
 *
 * cursor 为 base64(JSON)，承载稳定排序所需字段。非法 cursor 抛 InvalidCursorError，
 * 由调用方映射成明确错误（而不是静默忽略）。limit 自动 clamp 到 [1, MAX_LIMIT]。
 */
export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface PageResult<T> {
  items: T[];
  nextCursor?: string;
}

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

export class InvalidCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function clampLimit(limit?: number): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export function decodeCursor<T = Record<string, unknown>>(
  cursor?: string,
): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as T;
  } catch {
    throw new InvalidCursorError();
  }
}
