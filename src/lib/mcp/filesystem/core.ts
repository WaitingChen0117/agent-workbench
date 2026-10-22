import fs from "node:fs/promises";
import path from "node:path";

/**
 * filesystem-mcp 的核心逻辑（纯函数，便于单元测试）。
 *
 * 所有对外暴露的路径操作都必须先经过 resolveSafePath()，
 * 保证最终真实路径位于 workspaceRoot 之内，杜绝：
 *   - path traversal（../../../）
 *   - 绝对路径逃逸（/etc/passwd）
 *   - symlink escape（指向 root 外的软链）
 */

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
}

export interface SearchMatch {
  file: string; // 相对 workspaceRoot 的路径
  line: number;
  text: string;
}

// 跳过的大目录，避免搜索时扫描无关内容
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
]);

const MAX_READ_BYTES = 200_000; // readFile 上限，避免超大文件
const MAX_SEARCH_MATCHES = 50;

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

// 允许目标暂不存在：退回到最近的存在祖先做 realpath，再拼回
async function realpathAllowingMissing(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) {
      return target;
    }
    const realParent = await realpathAllowingMissing(parent);
    return path.join(realParent, path.basename(target));
  }
}

/**
 * 把用户传入的 path 解析为 workspaceRoot 内的安全绝对路径。
 * 两道校验：词法 resolve 后的前缀校验 + realpath 后的前缀校验（防软链逃逸）。
 */
export async function resolveSafePath(
  workspaceRoot: string,
  userPath: string,
): Promise<string> {
  const realRoot = await fs.realpath(workspaceRoot);

  // path.resolve 会把绝对路径原样采用 → 随后前缀校验会拦下逃逸
  const resolved = path.resolve(realRoot, userPath ?? "");

  if (!isInside(realRoot, resolved)) {
    throw new PathSecurityError(
      `Access denied: path escapes workspace root (${userPath})`,
    );
  }

  const real = await realpathAllowingMissing(resolved);

  if (!isInside(realRoot, real)) {
    throw new PathSecurityError(
      `Access denied: symlink escapes workspace root (${userPath})`,
    );
  }

  return resolved;
}

export async function listFiles(
  workspaceRoot: string,
  userPath: string,
): Promise<FileEntry[]> {
  const safe = await resolveSafePath(workspaceRoot, userPath || ".");
  const dirents = await fs.readdir(safe, { withFileTypes: true });

  return dirents
    .map((dirent) => ({
      name: dirent.name,
      type: dirent.isDirectory()
        ? ("directory" as const)
        : dirent.isFile()
          ? ("file" as const)
          : ("other" as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFile(
  workspaceRoot: string,
  userPath: string,
): Promise<string> {
  const safe = await resolveSafePath(workspaceRoot, userPath);
  const content = await fs.readFile(safe, "utf-8");

  return content.length > MAX_READ_BYTES
    ? content.slice(0, MAX_READ_BYTES) + "\n…（内容已截断）"
    : content;
}

export async function searchFiles(
  workspaceRoot: string,
  query: string,
  userPath: string,
): Promise<SearchMatch[]> {
  if (!query.trim()) {
    return [];
  }

  const base = await resolveSafePath(workspaceRoot, userPath || ".");
  const realRoot = await fs.realpath(workspaceRoot);
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= MAX_SEARCH_MATCHES) {
      return;
    }

    const dirents = await fs.readdir(dir, { withFileTypes: true });

    for (const dirent of dirents) {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        return;
      }

      const full = path.join(dir, dirent.name);

      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name)) {
          continue;
        }
        await walk(full);
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      let content: string;
      try {
        content = await fs.readFile(full, "utf-8");
      } catch {
        continue; // 二进制 / 无法读取的文件跳过
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({
            file: path.relative(realRoot, full),
            line: i + 1,
            text: lines[i].trim().slice(0, 200),
          });
          if (matches.length >= MAX_SEARCH_MATCHES) {
            break;
          }
        }
      }
    }
  }

  await walk(base);
  return matches;
}
