import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveSafePath } from "@/lib/mcp/filesystem/core";

const execFileAsync = promisify(execFile);

/**
 * runCommand 的核心：受控命令执行。
 *
 * 安全第一版：
 *   - 结构化输入 { program, args[] }，不接受整条 shell 字符串
 *   - execFile 不经过 shell，杜绝 shell 注入
 *   - 显式 allowlist：只放行项目开发相关命令
 *   - 再做一层 shell operator / 危险 token 检测，宁可拒绝
 *   - cwd 必须位于 workspace 内
 */

export class CommandSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandSecurityError";
  }
}

export interface RunCommandInput {
  program: string;
  args?: string[];
  cwd?: string;
}

export interface RunCommandResult {
  program: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = 120_000;

// 明确禁止的 token（即使出现在 args 里也拒绝）
const DENIED_TOKENS = new Set([
  "rm",
  "sudo",
  "chmod",
  "chown",
  "curl",
  "wget",
  "ssh",
  "scp",
  "git",
  "kill",
  "mv",
  "dd",
  "mkfs",
]);

// shell 注入结构：出现即拒绝
const SHELL_OPERATOR = /[&|;<>`$()\n\r]|\$\(|\|\|/;

// 本项目实际存在的 npm scripts（来自 package.json）
const KNOWN_PNPM_SCRIPTS = new Set([
  "dev",
  "build",
  "start",
  "lint",
  "rag:evaluate",
  "rag:multiturn",
]);

// pnpm exec / npx 允许调用的可执行文件
const ALLOWED_BINARIES = new Set(["tsc", "eslint", "next", "tsx", "prettier"]);

function containsShellOperator(value: string): boolean {
  return SHELL_OPERATOR.test(value);
}

/**
 * 校验命令是否允许。返回 { allowed, reason }。
 */
export function validateCommand(input: RunCommandInput): {
  allowed: boolean;
  reason?: string;
} {
  const program = (input.program ?? "").trim();
  const args = input.args ?? [];

  if (!program) {
    return { allowed: false, reason: "program is required" };
  }

  // 1. 任何部分含 shell operator → 拒绝
  for (const part of [program, ...args]) {
    if (typeof part !== "string") {
      return { allowed: false, reason: "args must be strings" };
    }
    if (containsShellOperator(part)) {
      return { allowed: false, reason: `shell operator not allowed: ${part}` };
    }
  }

  // 2. 危险 token → 拒绝（program 或任意 arg）
  for (const part of [program, ...args]) {
    if (DENIED_TOKENS.has(part)) {
      return { allowed: false, reason: `denied command/token: ${part}` };
    }
  }

  // 3. program 必须在允许的启动器内
  if (!["pnpm", "npm", "npx"].includes(program)) {
    return { allowed: false, reason: `program not allowed: ${program}` };
  }

  // 4. 子命令校验
  const sub = args[0];

  if (program === "npx") {
    if (!sub || !ALLOWED_BINARIES.has(sub)) {
      return { allowed: false, reason: `npx target not allowed: ${sub ?? ""}` };
    }
    return { allowed: true };
  }

  // pnpm / npm
  if (sub === "lint" || sub === "build" || sub === "test" || sub === "typecheck") {
    return { allowed: true };
  }

  if (sub === "run") {
    const script = args[1];
    if (!script || !KNOWN_PNPM_SCRIPTS.has(script)) {
      return { allowed: false, reason: `unknown script: ${script ?? ""}` };
    }
    return { allowed: true };
  }

  if (sub === "exec") {
    const bin = args[1];
    if (!bin || !ALLOWED_BINARIES.has(bin)) {
      return { allowed: false, reason: `exec target not allowed: ${bin ?? ""}` };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `subcommand not allowed: ${sub ?? ""}` };
}

export async function runCommand(
  workspaceRoot: string,
  input: RunCommandInput,
): Promise<RunCommandResult> {
  const check = validateCommand(input);
  if (!check.allowed) {
    throw new CommandSecurityError(check.reason ?? "command not allowed");
  }

  const args = input.args ?? [];
  // cwd 必须在 workspace 内
  const safeCwd = await resolveSafePath(workspaceRoot, input.cwd || ".");

  try {
    const { stdout, stderr } = await execFileAsync(input.program, args, {
      cwd: safeCwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      shell: false, // 关键：不经过 shell
    });

    return {
      program: input.program,
      args,
      exitCode: 0,
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(0, MAX_OUTPUT),
    };
  } catch (error) {
    // execFile 在非零退出码时 reject，这里归一化为结构化结果
    const e = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    return {
      program: input.program,
      args,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: (e.stdout ?? "").slice(0, MAX_OUTPUT),
      stderr: (e.stderr ?? e.message ?? "").slice(0, MAX_OUTPUT),
    };
  }
}
