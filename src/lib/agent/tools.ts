import { jsonSchema, tool } from "ai";

import { aiModel } from "@/lib/ai";
import { retrieveKnowledge } from "@/lib/rag/rag";

/**
 * searchKnowledge Tool
 *
 * 把现有的 RAG 检索能力（embedding + vector search + retrieval）封装成
 * 一个 LLM 可以主动调用的工具。这里不重新实现 RAG，只复用 retrieveKnowledge()。
 */

// Tool 入参：只暴露 LLM 真正需要的 query 字段
export interface SearchKnowledgeInput {
  query: string;
}

// 单条检索结果：只返回 Agent 需要的内容，不暴露底层向量/数据库对象
export interface KnowledgeHit {
  fileName: string;
  score: number;
  content: string;
}

// Tool 执行成功
export interface SearchKnowledgeSuccess {
  success: true;
  results: KnowledgeHit[];
}

// Tool 执行失败：返回给 Agent，而不是让整个 API 崩溃
export interface SearchKnowledgeFailure {
  success: false;
  error: string;
}

export type SearchKnowledgeResult =
  | SearchKnowledgeSuccess
  | SearchKnowledgeFailure;

// 回答生成使用 topK=3（与现有 /api/chat、answerWithKnowledge 保持一致）
const SEARCH_TOP_K = 3;

/**
 * 直接执行一次知识库检索，供 Tool 与测试复用。
 * 失败时返回结构化的 { success:false, error }，不抛出异常。
 */
export async function searchKnowledge(
  input: SearchKnowledgeInput,
): Promise<SearchKnowledgeResult> {
  const query = input.query?.trim();

  console.log("[Tool] searchKnowledge");
  console.log("query:", query);

  if (!query) {
    return { success: false, error: "Knowledge search failed: empty query" };
  }

  try {
    // 复用现有 RAG 检索：内部已包含 Query Rewrite / Embedding / Vector Search。
    // LLM 已经给出独立的 query，这里不传历史，避免二次改写。
    const retrieval = await retrieveKnowledge(query, [], SEARCH_TOP_K, aiModel);

    const results: KnowledgeHit[] = retrieval.sources.map((source) => ({
      fileName: source.fileName,
      score: source.score,
      content: source.content,
    }));

    console.log("[Tool Result]");
    console.log("count:", results.length);

    return { success: true, results };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Knowledge search failed";

    console.error("[Tool] searchKnowledge error:", message);

    return { success: false, error: `Knowledge search failed: ${message}` };
  }
}

/**
 * AI SDK 工具定义。没有引入 zod，使用 jsonSchema 描述入参类型。
 */
export const searchKnowledgeTool = tool({
  description:
    "查询项目知识库（目前包含前端 / React 相关内容）。当用户的问题可能" +
    "依赖知识库中的资料，或需要引用具体文档内容来回答时调用。" +
    "入参 query 应为一句可直接用于检索的完整问题。",
  inputSchema: jsonSchema<SearchKnowledgeInput>({
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "用于知识库检索的完整、独立的问题",
      },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  execute: (input: SearchKnowledgeInput) => searchKnowledge(input),
});

// ===========================================================================
// getCurrentTime Tool
// ===========================================================================

// Tool 入参：IANA 时区字符串，例如 "Asia/Shanghai"
export interface GetCurrentTimeInput {
  timezone: string;
}

// Tool 执行成功
export interface GetCurrentTimeSuccess {
  success: true;
  timezone: string;
  // 带时区偏移的 ISO 字符串，例如 2026-10-21T15:30:00+08:00
  currentTime: string;
}

// Tool 执行失败
export interface GetCurrentTimeFailure {
  success: false;
  error: string;
}

export type GetCurrentTimeResult =
  | GetCurrentTimeSuccess
  | GetCurrentTimeFailure;

// 计算某时区相对 UTC 的偏移，返回 "+08:00" / "-05:00" 形式
function getTimezoneOffset(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });

  const namePart = formatter
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  // UTC / GMT 本身没有偏移数字
  const match = namePart?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);

  if (!match) {
    return "+00:00";
  }

  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = match[3] ?? "00";

  return `${sign}${hours}:${minutes}`;
}

// 把时间格式化成指定时区的本地 ISO 字符串（含偏移）
function formatInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  // 某些实现 24 点会显示为 "24"，归一化成 "00"
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const datePart = `${parts.year}-${parts.month}-${parts.day}`;
  const timePart = `${hour}:${parts.minute}:${parts.second}`;
  const offset = getTimezoneOffset(date, timeZone);

  return `${datePart}T${timePart}${offset}`;
}

/**
 * 获取指定时区当前时间。只使用 Node 原生 Intl，不调用任何外部 API。
 * timezone 不合法时返回结构化错误，不抛出异常。
 */
export function getCurrentTime(
  input: GetCurrentTimeInput,
): GetCurrentTimeResult {
  const timezone = input.timezone?.trim();

  console.log("[Tool] getCurrentTime");
  console.log("timezone:", timezone);

  if (!timezone) {
    return { success: false, error: "Invalid timezone: empty value" };
  }

  try {
    const now = new Date();

    // 非法时区会抛 RangeError，在这里兜住
    const currentTime = formatInTimeZone(now, timezone);

    return { success: true, timezone, currentTime };
  } catch {
    return { success: false, error: `Invalid timezone: ${timezone}` };
  }
}

export const getCurrentTimeTool = tool({
  description:
    "获取指定时区的当前日期和时间。当用户询问现在几点、今天日期，" +
    "或需要基于当前时间进行判断时调用。timezone 使用 IANA 时区名，" +
    "例如 Asia/Shanghai、America/New_York；若用户未指定，默认 Asia/Shanghai。",
  inputSchema: jsonSchema<GetCurrentTimeInput>({
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA 时区名称，例如 Asia/Shanghai",
      },
    },
    required: ["timezone"],
    additionalProperties: false,
  }),
  execute: (input: GetCurrentTimeInput) => getCurrentTime(input),
});
