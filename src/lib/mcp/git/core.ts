import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * git-mcp 核心：只读 Git 操作。
 *
 * 安全第一：
 *   - 只用 execFile("git", args[], { shell:false })，绝不拼接 shell / exec
 *   - 固定的 5 个只读工具，不提供通用 runGitCommand
 *   - cwd 固定为 workspace root，且仓库必须位于 workspace 内
 *   - ref 经白名单校验，防止 option 注入（如 --upload-pack）
 *   - diff / show 输出有 maxBytes / maxLines 上限
 */

export class GitSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitSecurityError";
  }
}

export interface DiffLimits {
  maxBytes?: number;
  maxLines?: number;
}

const DEFAULT_MAX_BYTES = 100_000;
const DEFAULT_MAX_LINES = 5000;
const MAX_LOG = 50;
const DEFAULT_LOG = 20;
const MAX_FILES = 100;
const US = "\u001f"; // unit separator，用于 pretty-format 字段分隔

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

// 校验：workspace 是 git 仓库，且仓库 toplevel 位于 workspace 内（禁止逃逸到父仓库）
async function assertRepoInWorkspace(workspaceRoot: string): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(workspaceRoot);
  } catch {
    throw new GitSecurityError(`workspace root not found: ${workspaceRoot}`);
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: realRoot, shell: false },
    );
    const top = await fs.realpath(stdout.trim());
    if (!isInside(realRoot, top)) {
      throw new GitSecurityError("git repository is outside the workspace");
    }
    return realRoot;
  } catch (error) {
    if (error instanceof GitSecurityError) throw error;
    throw new GitSecurityError("not a git repository within the workspace");
  }
}

async function runGit(workspaceRoot: string, args: string[]): Promise<string> {
  const cwd = await assertRepoInWorkspace(workspaceRoot);
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    shell: false,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

function truncateDiff(
  text: string,
  limits?: DiffLimits,
): { diff: string; truncated: boolean } {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = limits?.maxLines ?? DEFAULT_MAX_LINES;

  let truncated = false;
  let out = text;

  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(out, "utf-8") > maxBytes) {
    out = out.slice(0, maxBytes);
    truncated = true;
  }
  return { diff: out, truncated };
}

// ref 白名单：禁止 option 注入与 shell 元字符
export function isSafeRef(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (ref.startsWith("-")) return false; // 防 --upload-pack 等
  return /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/.test(ref);
}

// PLACEHOLDER_GIT_CORE
export interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export async function gitStatus(workspaceRoot: string): Promise<GitStatusResult> {
  const out = await runGit(workspaceRoot, ["status", "--porcelain=v1", "--branch"]);
  const result: GitStatusResult = {
    branch: "",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      const info = line.slice(3);
      result.branch = info.split(/\.{3}| /)[0].replace(/^No commits yet on /, "");
      result.ahead = Number(/ahead (\d+)/.exec(info)?.[1] ?? 0);
      result.behind = Number(/behind (\d+)/.exec(info)?.[1] ?? 0);
      continue;
    }
    if (line.startsWith("??")) {
      if (result.untracked.length < MAX_FILES) result.untracked.push(line.slice(3));
      continue;
    }
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);
    if (x !== " " && x !== "?" && result.staged.length < MAX_FILES) result.staged.push(file);
    if (y !== " " && y !== "?" && result.unstaged.length < MAX_FILES) result.unstaged.push(file);
  }
  return result;
}

export interface GitDiffResult {
  diff: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

export async function gitDiff(
  workspaceRoot: string,
  options?: { staged?: boolean },
  limits?: DiffLimits,
): Promise<GitDiffResult> {
  const base = options?.staged ? ["--cached"] : [];
  const numstat = await runGit(workspaceRoot, ["diff", ...base, "--numstat"]);
  const raw = await runGit(workspaceRoot, ["diff", ...base]);

  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    filesChanged += 1;
    const [a, d] = line.split("\t");
    additions += Number.parseInt(a, 10) || 0;
    deletions += Number.parseInt(d, 10) || 0;
  }

  const { diff, truncated } = truncateDiff(raw, limits);
  return { diff, filesChanged, additions, deletions, truncated };
}

export interface GitCommit {
  hash: string;
  author: string;
  message: string;
  timestamp: string;
}

export async function gitLog(
  workspaceRoot: string,
  options?: { limit?: number },
): Promise<GitCommit[]> {
  const requested = Number(options?.limit ?? DEFAULT_LOG);
  const limit = Math.min(Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LOG), MAX_LOG);
  const out = await runGit(workspaceRoot, [
    "log",
    "-n",
    String(limit),
    `--pretty=format:%H${US}%an${US}%s${US}%aI`,
  ]);

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, message, timestamp] = line.split(US);
      return { hash, author, message, timestamp };
    });
}

export interface GitBranchResult {
  current: string;
  branches: string[];
}

export async function gitBranch(workspaceRoot: string): Promise<GitBranchResult> {
  const current = (
    await runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).trim();
  const branches = (
    await runGit(workspaceRoot, ["branch", "--format=%(refname:short)"])
  )
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, MAX_FILES);
  return { current, branches };
}

export interface GitShowResult {
  hash: string;
  author: string;
  message: string;
  timestamp: string;
  diff: string;
  truncated: boolean;
}

export async function gitShow(
  workspaceRoot: string,
  options: { ref: string },
  limits?: DiffLimits,
): Promise<GitShowResult> {
  if (!isSafeRef(options.ref)) {
    throw new GitSecurityError(`unsafe git ref: ${options.ref}`);
  }

  const meta = await runGit(workspaceRoot, [
    "show",
    "-s",
    `--pretty=format:%H${US}%an${US}%s${US}%aI`,
    options.ref,
  ]);
  const [hash, author, message, timestamp] = meta.trim().split(US);

  const raw = await runGit(workspaceRoot, ["show", "--format=", options.ref]);
  const { diff, truncated } = truncateDiff(raw, limits);

  return { hash, author, message, timestamp, diff, truncated };
}

