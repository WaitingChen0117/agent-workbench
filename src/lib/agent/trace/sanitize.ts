/**
 * Trace / Event 数据脱敏
 *
 * Trace（以及对外事件）不得原样保存所有 Tool Input/Output。
 * - writeFile：只留 path + 长度，绝不留完整 content
 * - runCommand：留 program/args/cwd/exitCode，输出截断为有限预览
 * - 其他：递归 redact 明显的 secret 字段；超长字符串截断
 */

const SECRET_KEY = /(api[-_]?key|token|authorization|cookie|password|secret)/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

function truncateString(value: string): unknown {
  return value.length > MAX_STRING
    ? { preview: value.slice(0, MAX_STRING), length: value.length }
    : value;
}

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncateString(value);
  }

  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSecrets(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key)
      ? "[REDACTED]"
      : redactSecrets(val, depth + 1);
  }
  return out;
}

export function sanitizeToolInput(toolName: string, input: unknown): unknown {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (toolName === "writeFile") {
    return {
      path: obj.path,
      contentLength:
        typeof obj.content === "string" ? obj.content.length : undefined,
    };
  }

  if (toolName === "runCommand") {
    return { program: obj.program, args: obj.args, cwd: obj.cwd };
  }

  return redactSecrets(input);
}

export function sanitizeToolOutput(toolName: string, output: unknown): unknown {
  const obj = (output ?? {}) as Record<string, unknown>;

  if (toolName === "writeFile") {
    // core.writeFile 返回 { path, bytesWritten }
    const result = (obj.result ?? obj) as Record<string, unknown>;
    return { path: result.path, bytesWritten: result.bytesWritten };
  }

  if (toolName === "runCommand") {
    const result = (obj.result ?? obj) as Record<string, unknown>;
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    return {
      program: result.program,
      args: result.args,
      cwd: result.cwd,
      exitCode: result.exitCode,
      stdoutPreview: stdout.slice(0, MAX_STRING),
      stderrPreview: stderr.slice(0, MAX_STRING),
    };
  }

  // readFile 等可能返回长字符串 / 大数组 → 截断
  if (typeof output === "string") {
    return truncateString(output);
  }
  if (Array.isArray(output)) {
    return { count: output.length, sample: output.slice(0, 5) };
  }

  return redactSecrets(output);
}
