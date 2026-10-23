import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  githubRepo,
  githubIssues,
  githubIssue,
  githubPullRequests,
  githubPullRequest,
} from "@/lib/mcp/github/core";

/**
 * github-mcp —— 只读 GitHub MCP Server（stdio transport）
 *
 * 远程 GitHub API 客户端，不使用 workspaceRoot。只暴露 5 个只读工具，无写操作。
 * GITHUB_TOKEN 仅在 core 内用于请求头，绝不进入工具返回值。
 */

const stateSchema = {
  type: "string",
  enum: ["open", "closed", "all"],
  description: "过滤状态，默认 open",
};

const TOOL_DEFINITIONS = [
  {
    name: "githubRepo",
    description: "查询已配置仓库（GITHUB_OWNER/REPO）的基础信息。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "githubIssues",
    description: "列出仓库 Issue（已过滤 Pull Request）。limit 默认 20，最大 50。",
    inputSchema: {
      type: "object",
      properties: {
        state: stateSchema,
        limit: { type: "number", description: "返回数量，1-50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "githubIssue",
    description: "查询单个 Issue 详情（含 body，超长截断）。",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "Issue 编号" } },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "githubPullRequests",
    description: "列出仓库 Pull Request。limit 默认 20，最大 50。",
    inputSchema: {
      type: "object",
      properties: {
        state: stateSchema,
        limit: { type: "number", description: "返回数量，1-50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "githubPullRequest",
    description: "查询单个 Pull Request 详情（含 body、增删行、变更文件数）。",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "PR 编号" } },
      required: ["number"],
      additionalProperties: false,
    },
  },
] as const;

const server = new Server(
  { name: "github-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = (args ?? {}) as Record<string, unknown>;

  try {
    let data: unknown;
    switch (name) {
      case "githubRepo":
        data = await githubRepo();
        break;
      case "githubIssues":
        data = await githubIssues({ state: input.state, limit: input.limit });
        break;
      case "githubIssue":
        data = await githubIssue({ number: input.number });
        break;
      case "githubPullRequests":
        data = await githubPullRequests({ state: input.state, limit: input.limit });
        break;
      case "githubPullRequest":
        data = await githubPullRequest({ number: input.number });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    return {
      content: [
        { type: "text", text: error instanceof Error ? error.message : "github tool failed" },
      ],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[github-mcp] fatal:", error);
  process.exit(1);
});
