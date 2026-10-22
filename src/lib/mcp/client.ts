import path from "node:path";

import { jsonSchema, tool, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * MCP Client（stdio transport）
 *
 * 以子进程方式拉起 filesystem-mcp，通过官方 SDK 的 stdio transport 连接。
 * 不自己实现 MCP 协议。对外暴露 getMcpTools()，把 MCP 的 listTools 结果
 * 包装成 AI SDK 的 ToolSet，交给 Tool Resolver 与本地工具统一合并。
 *
 * ⚠️ 单例连接 + 常驻子进程，仅适合本地/长驻 Node。Serverless 下子进程会被回收。
 */

const WORKSPACE_ROOT = process.cwd();
const SERVER_SCRIPT = path.join(
  WORKSPACE_ROOT,
  "src",
  "lib",
  "mcp",
  "filesystem",
  "server.ts",
);

const globalRef = globalThis as typeof globalThis & {
  __mcpClient?: Promise<Client>;
};

function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  env.AGENT_WORKSPACE_ROOT = WORKSPACE_ROOT;
  return env;
}

// 懒加载 + 单例：同一进程只连接一次 MCP Server
export function getMcpClient(): Promise<Client> {
  if (!globalRef.__mcpClient) {
    globalRef.__mcpClient = (async () => {
      const transport = new StdioClientTransport({
        command: "npx",
        args: ["tsx", SERVER_SCRIPT],
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
  }

  return globalRef.__mcpClient;
}

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpCallResult {
  content?: McpTextContent[];
  isError?: boolean;
}

// 把 MCP callTool 的结果统一成 { success, ... }，与本地工具对齐
function normalizeMcpResult(result: McpCallResult): unknown {
  const text =
    result.content?.find((part) => part.type === "text")?.text ?? "";

  if (result.isError) {
    return { success: false, error: text || "MCP tool failed" };
  }

  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 文本，原样返回
  }

  return { success: true, result: parsed };
}

/**
 * 发现并包装 MCP Server 暴露的工具为 AI SDK ToolSet。
 * 工具的 description / inputSchema 完全来自 MCP listTools，不在此硬编码。
 */
export async function getMcpTools(): Promise<ToolSet> {
  const client = await getMcpClient();
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
