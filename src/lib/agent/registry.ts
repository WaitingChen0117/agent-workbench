import type { ToolSet } from "ai";

import { getCurrentTimeTool, searchKnowledgeTool } from "@/lib/agent/tools";

/**
 * Local Tool Registry
 *
 * 进程内直接实现的本地工具。与 MCP 工具一起，由 Tool Resolver 合并成
 * Agent Loop 看到的统一 ToolSet。
 *
 * - Tool 名称唯一（对象 key）
 * - 每个 Tool 自带 description 与 inputSchema（见 tools.ts）
 * - 执行逻辑封装在各自的 execute 中，与 Loop 解耦
 */
export const localTools = {
  searchKnowledge: searchKnowledgeTool,
  getCurrentTime: getCurrentTimeTool,
} satisfies ToolSet;

// 兼容旧引用：Agent Loop 的默认 tools 仍可用本地工具集
export const toolRegistry = localTools;

export type LocalToolName = keyof typeof localTools;
