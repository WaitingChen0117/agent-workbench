import type { ToolSet } from "ai";

import { localTools } from "@/lib/agent/registry";
import { getMcpTools } from "@/lib/mcp/client";

/**
 * Tool Resolver
 *
 * 把 Local Tools 与 MCP Tools 合并成 Agent Loop 看到的统一 ToolSet。
 * Agent 不关心某个工具是本地实现还是来自 MCP —— 接口完全一致。
 *
 *   Agent Runtime → Tool Resolver → { Local Tools, MCP Client → MCP Server }
 *
 * MCP 不可用时优雅降级为仅本地工具，保证 /api/agent 永远可用。
 */
export async function resolveTools(): Promise<ToolSet> {
  let mcpTools: ToolSet = {};

  try {
    mcpTools = await getMcpTools();
  } catch (error) {
    console.warn(
      "[ToolResolver] MCP tools unavailable, falling back to local tools:",
      error instanceof Error ? error.message : error,
    );
  }

  // 本地工具在后，避免 MCP 覆盖同名本地工具
  return { ...mcpTools, ...localTools };
}
