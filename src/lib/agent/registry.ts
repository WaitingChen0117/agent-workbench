import type { ToolSet } from "ai";

import { getCurrentTimeTool, searchKnowledgeTool } from "@/lib/agent/tools";

/**
 * Tool Registry
 *
 * Agent Loop 只认识这张表，不关心每个 Tool 的具体业务实现。
 * 新增 Tool 时只需在 tools.ts 定义后，在这里登记一个唯一名称即可。
 *
 * - Tool 名称唯一（对象 key）
 * - 每个 Tool 自带 description 与 inputSchema（见 tools.ts）
 * - 执行逻辑封装在各自的 execute 中，与 Loop 解耦
 */
export const toolRegistry = {
  searchKnowledge: searchKnowledgeTool,
  getCurrentTime: getCurrentTimeTool,
} satisfies ToolSet;

export type ToolName = keyof typeof toolRegistry;
