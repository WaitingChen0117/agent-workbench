import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  listFiles,
  readFile,
  writeFile,
  searchFiles,
  PathSecurityError,
} from "@/lib/mcp/filesystem/core";
import { runCommand, CommandSecurityError } from "@/lib/mcp/command/core";

/**
 * filesystem-mcp —— 最小 MCP Server（stdio transport）
 *
 * 作为独立子进程运行：MCP Client 通过 stdio 连接它。
 * workspaceRoot 由环境变量 AGENT_WORKSPACE_ROOT 注入，所有路径都被限制在其内。
 */

const workspaceRoot = process.env.AGENT_WORKSPACE_ROOT ?? process.cwd();

// 每个 Tool 的 name / description / JSON Schema —— 由 Client 通过 listTools 发现
const TOOL_DEFINITIONS = [
  {
    name: "listFiles",
    description:
      "列出 workspace 内指定目录下的文件与子目录。path 相对 workspace 根目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 workspace 根的目录路径，默认当前目录" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "readFile",
    description: "读取 workspace 内指定文件的文本内容。path 相对 workspace 根目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 workspace 根的文件路径" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "searchFiles",
    description:
      "在 workspace 内指定目录下按文本搜索，返回命中的文件、行号与该行内容。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的文本" },
        path: { type: "string", description: "搜索起始目录，相对 workspace 根，默认当前目录" },
      },
      required: ["query", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "writeFile",
    description:
      "写入（创建或覆盖）workspace 内的文本文件。path 相对 workspace 根；" +
      "受安全校验限制，禁止写入 workspace 外或敏感文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 workspace 根的文件路径" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "runCommand",
    description:
      "在 workspace 内执行受控的开发命令（结构化 program + args，不经过 shell）。" +
      "仅允许 allowlist 内命令，如 pnpm lint / pnpm build / npx tsc --noEmit / npx tsx <file>。",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "启动器，仅限 pnpm / npm / npx" },
        args: {
          type: "array",
          items: { type: "string" },
          description: "命令参数数组，例如 ['lint'] 或 ['tsc','--noEmit']",
        },
        cwd: { type: "string", description: "工作目录，相对 workspace 根，默认根目录" },
      },
      required: ["program", "args"],
      additionalProperties: false,
    },
  },
] as const;

const server = new Server(
  { name: "filesystem-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = (args ?? {}) as Record<string, unknown>;

  try {
    let data: unknown;

    switch (name) {
      case "listFiles":
        data = await listFiles(workspaceRoot, String(input.path ?? "."));
        break;
      case "readFile":
        data = await readFile(workspaceRoot, String(input.path ?? ""));
        break;
      case "searchFiles":
        data = await searchFiles(
          workspaceRoot,
          String(input.query ?? ""),
          String(input.path ?? "."),
        );
        break;
      case "writeFile":
        data = await writeFile(
          workspaceRoot,
          String(input.path ?? ""),
          String(input.content ?? ""),
        );
        break;
      case "runCommand":
        data = await runCommand(workspaceRoot, {
          program: String(input.program ?? ""),
          args: Array.isArray(input.args) ? input.args.map(String) : [],
          cwd: input.cwd === undefined ? undefined : String(input.cwd),
        });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  } catch (error) {
    // 安全错误与普通错误都以结构化 isError 返回，交给 Agent/LLM 处理，不崩溃
    const message =
      error instanceof PathSecurityError || error instanceof CommandSecurityError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Tool execution failed";

    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[filesystem-mcp] fatal:", error);
  process.exit(1);
});
