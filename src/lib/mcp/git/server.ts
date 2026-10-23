import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  gitStatus,
  gitDiff,
  gitLog,
  gitBranch,
  gitShow,
  gitAdd,
  gitCommit,
  GitSecurityError,
} from "@/lib/mcp/git/core";

/**
 * git-mcp —— 只读 Git MCP Server（stdio transport）
 *
 * 独立于 filesystem-mcp。只暴露 5 个只读工具，不提供通用 runGitCommand，
 * 也不暴露任何写操作（add/commit/push/reset/checkout/...）。
 */

const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();

const TOOL_DEFINITIONS = [
  {
    name: "gitStatus",
    description: "查看当前仓库状态：分支、ahead/behind、staged/unstaged/untracked 文件。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gitDiff",
    description: "查看工作区或暂存区的改动摘要与 diff（有大小/行数上限）。",
    inputSchema: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "是否查看暂存区改动，默认 false" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gitLog",
    description: "查看最近的提交记录。limit 默认 20，最大 50。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "返回的提交数量，1-50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gitBranch",
    description: "查看当前分支与所有本地分支。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "gitShow",
    description: "查看指定 ref（HEAD、HEAD~1、分支名、commit hash）的提交信息与 diff。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "git ref，如 HEAD / HEAD~1 / 分支名 / commit hash" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "gitAdd",
    description:
      "把明确指定的文件加入 Git 暂存区（git add -- <paths>）。不支持 . / -A 批量暂存；" +
      "需要人工审批；敏感文件会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要暂存的文件路径（相对 workspace 根），必须明确列出",
        },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  {
    name: "gitCommit",
    description:
      "提交当前已暂存的改动（git commit -m <message>）。不会自动 add；需要人工审批；" +
      "message 不能为空/含换行，最长 200 字符。",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "提交信息（单行，<=200）" },
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
] as const;

const server = new Server(
  { name: "git-mcp", version: "0.1.0" },
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
      case "gitStatus":
        data = await gitStatus(workspaceRoot);
        break;
      case "gitDiff":
        data = await gitDiff(workspaceRoot, { staged: input.staged === true });
        break;
      case "gitLog":
        data = await gitLog(workspaceRoot, {
          limit: typeof input.limit === "number" ? input.limit : undefined,
        });
        break;
      case "gitBranch":
        data = await gitBranch(workspaceRoot);
        break;
      case "gitShow":
        data = await gitShow(workspaceRoot, { ref: String(input.ref ?? "") });
        break;
      case "gitAdd":
        data = await gitAdd(workspaceRoot, { paths: input.paths });
        break;
      case "gitCommit":
        data = await gitCommit(workspaceRoot, { message: input.message });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    const message =
      error instanceof GitSecurityError
        ? error.message
        : error instanceof Error
          ? error.message
          : "git tool failed";
    return { content: [{ type: "text", text: message }], isError: true };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[git-mcp] fatal:", error);
  process.exit(1);
});
