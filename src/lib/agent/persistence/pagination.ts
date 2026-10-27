import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 统一分页类型/工具（Phase 10.7-C + 10.8-C 签名加固）
 *
 * cursor = base64url(payload).base64url(hmacSha256(payload))。
 * payload 含 version + resource + data；解码时校验签名、version、resource。
 * 任何不一致（签名错误/篡改/资源不匹配/版本不支持/格式错误）均抛 InvalidCursorError，
 * 绝不 fallback 到全量或第一页。
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
const CURSOR_VERSION = 1;

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

// cursor 签名密钥：优先 env；缺失时使用稳定本地 fallback（仅本地开发）。
// 绝不写入 DB / Trace / 日志 / API / error。
const LOCAL_FALLBACK_SECRET = "agent-workbench-local-cursor-fallback-v1";

function cursorSecret(): string {
  return process.env.AGENT_PERSISTENCE_CURSOR_SECRET || LOCAL_FALLBACK_SECRET;
}

export function isCursorSigningConfigured(): boolean {
  return !!process.env.AGENT_PERSISTENCE_CURSOR_SECRET;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", cursorSecret()).update(payloadB64).digest("base64url");
}

interface CursorPayload<T> {
  v: number;
  r: string;
  d: T;
}

export function encodeCursor(
  resource: string,
  data: Record<string, unknown>,
): string {
  const payload: CursorPayload<Record<string, unknown>> = {
    v: CURSOR_VERSION,
    r: resource,
    d: data,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function decodeCursor<T = Record<string, unknown>>(
  resource: string,
  cursor?: string,
): T | null {
  if (!cursor) return null;
  const parts = cursor.split(".");
  if (parts.length !== 2) throw new InvalidCursorError("malformed cursor");
  const [payloadB64, sig] = parts;

  // 常数时间比较签名，防篡改
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidCursorError("cursor signature mismatch");
  }

  let payload: CursorPayload<T>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    throw new InvalidCursorError("malformed cursor payload");
  }
  if (payload.v !== CURSOR_VERSION) {
    throw new InvalidCursorError(`unsupported cursor version: ${payload.v}`);
  }
  if (payload.r !== resource) {
    throw new InvalidCursorError(`cursor resource mismatch: ${payload.r} != ${resource}`);
  }
  return payload.d;
}
