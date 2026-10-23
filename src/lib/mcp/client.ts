import path from "node:path";

import { jsonSchema, tool, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP Client（stdio transport，多 Server）
 *
 * 以子进程方式拉起各 MCP Server（filesystem-mcp、git-mcp），通过官方 SDK 的
 * stdio transport 连接，把每个 Server 的 listTools 结果包装成 AI SDK ToolSet，
 * 交给 Tool Resolver 与本地工具统一合并。不自己实现 MCP 协议。
 *
 * ⚠️ 单例连接 + 常驻子进程，仅适合本地/长驻 Node。Serverless 下子进程会被回收。
 */

const WORKSPACE_ROOT = process.cwd();

// 已注册的 MCP Server（新增 Server 只需在此登记）
const MCP_SERVERS: Array<{ name: string; script: string }> = [
  { name: "filesystem", script: path.join("src", "lib", "mcp", "filesystem", "server.ts") },
  { name: "git", script: path.join("src", "lib", "mcp", "git", "server.ts") },
];

const globalRef = globalThis as typeof globalThis & {
  __mcpClients?: Map<string, Promise<Client>>;
};

const clients: Map<string, Promise<Client>> =
  globalRef.__mcpClients ?? (globalRef.__mcpClients = new Map());

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.AGENT_WORKSPACE_ROOT = WORKSPACE_ROOT;
  return env;
}

// 懒加载 + 单例：同一进程每个 Server 只连接一次
export function getMcpClient(serverName: string): Promise<Client> {
  const existing = clients.get(serverName);
  if (existing) return existing;

  const config = MCP_SERVERS.find((s) => s.name === serverName);
  if (!config) {
    return Promise.reject(new Error(`unknown MCP server: ${serverName}`));
  }

  const promise = (async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(WORKSPACE_ROOT, config.script)],
      env: buildChildEnv(),
      cwd: WORKSPACE_ROOT,
    });
    const client = new Client(
      { name: "agent-workbench", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  })();

  clients.set(serverName, promise);
  return promise;
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// 把 MCP callTool 的结果统一成 { success, ... }，与本地工具对齐
function normalizeMcpResult(result: McpCallResult): unknown {
  const text = result.content?.find((p) => p.type === "text")?.text ?? "";
  if (result.isError) {
    return { success: false, error: text || "MCP tool failed" };
  }
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON，原样返回
  }
  return { success: true, result: parsed };
}

async function getToolsFromServer(serverName: string): Promise<ToolSet> {
  const client = await getMcpClient(serverName);
  const { tools } = await client.listTools();

  const toolSet: ToolSet = {};
  for (const mcpTool of tools) {
    toolSet[mcpTool.name] = tool({
      description: mcpTool.description ?? mcpTool.name,
      inputSchema: jsonSchema(
        mcpTool.inputSchema as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (input: unknown) => {
        const result = (await client.callTool({
          name: mcpTool.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        })) as McpCallResult;
        return normalizeMcpResult(result);
      },
    });
  }
  return toolSet;
}

/**
 * 发现并合并所有 MCP Server 的工具为统一 ToolSet。
 * 单个 Server 不可用时跳过它，不影响其他 Server（优雅降级）。
 */
export async function getMcpTools(): Promise<ToolSet> {
  const merged: ToolSet = {};
  for (const server of MCP_SERVERS) {
    try {
      Object.assign(merged, await getToolsFromServer(server.name));
    } catch (error) {
      console.warn(
        `[MCP] server "${server.name}" unavailable:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return merged;
}
