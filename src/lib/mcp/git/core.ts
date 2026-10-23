import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  resolveSafePath,
  isSensitivePath,
  PathSecurityError,
} from "@/lib/mcp/filesystem/core";

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

// ===========================================================================
// Git Write（Phase 9.2）—— gitAdd / gitCommit，均为固定语义、结构化参数。
// ===========================================================================

const MAX_ADD_PATHS = 100;
const MAX_COMMIT_MESSAGE = 200;

export interface AddValidation {
  ok: boolean;
  error?: string;
  safePaths?: string[];
}

/**
 * 校验 gitAdd 的 paths：非空、数量/格式、workspace 内、非敏感、禁 bulk。
 * 供 gitAdd 与 pre-approval guard 共用（敏感/越界必须在审批之前就被拒）。
 */
export async function validateAddPaths(
  workspaceRoot: string,
  paths: unknown,
): Promise<AddValidation> {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: "paths must be a non-empty array" };
  }
  if (paths.length > MAX_ADD_PATHS) {
    return { ok: false, error: `too many paths (> ${MAX_ADD_PATHS})` };
  }

  const realRoot = await fs.realpath(workspaceRoot);
  const safePaths: string[] = [];

  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) {
      return { ok: false, error: "each path must be a non-empty string" };
    }
    if (p.startsWith("-")) {
      return { ok: false, error: `path cannot start with '-': ${p}` };
    }
    if ([".", "*", "-A", "--all", ":/"].includes(p.trim())) {
      return { ok: false, error: "bulk add (., *, -A) is not allowed" };
    }

    let resolved: string;
    try {
      resolved = await resolveSafePath(workspaceRoot, p);
    } catch (error) {
      if (error instanceof PathSecurityError) {
        return { ok: false, error: error.message };
      }
      return { ok: false, error: `invalid path: ${p}` };
    }

    const rel = path.relative(realRoot, resolved);
    if (isSensitivePath(rel)) {
      return { ok: false, error: `sensitive file cannot be staged: ${rel}` };
    }
    safePaths.push(rel);
  }

  return { ok: true, safePaths };
}

export interface GitWriteResult {
  success: boolean;
  paths?: string[];
  error?: string;
}

export async function gitAdd(
  workspaceRoot: string,
  options: { paths: unknown },
): Promise<GitWriteResult> {
  const v = await validateAddPaths(workspaceRoot, options.paths);
  if (!v.ok || !v.safePaths) {
    return { success: false, error: v.error };
  }

  try {
    // 固定语义：git add -- <path...>，结构化参数，不经 shell
    await runGit(workspaceRoot, ["add", "--", ...v.safePaths]);
    return { success: true, paths: v.safePaths };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "git add failed",
    };
  }
}

export interface MessageValidation {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * 校验 commit message：非空、<=200、trim、禁换行。
 * 注意 --author 等注入在 execFile 固定参数下天然失效（只会作为 -m 的值）。
 */
export function validateCommitMessage(message: unknown): MessageValidation {
  if (typeof message !== "string") {
    return { ok: false, error: "message must be a string" };
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, error: "message must not be empty" };
  }
  if (trimmed.length > MAX_COMMIT_MESSAGE) {
    return { ok: false, error: `message too long (> ${MAX_COMMIT_MESSAGE})` };
  }
  if (/[\n\r]/.test(message)) {
    return { ok: false, error: "message must not contain newlines" };
  }
  return { ok: true, message: trimmed };
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  message?: string;
  error?: string;
}

export async function gitCommit(
  workspaceRoot: string,
  options: { message: unknown },
): Promise<GitCommitResult> {
  const v = validateCommitMessage(options.message);
  if (!v.ok || !v.message) {
    return { success: false, error: v.error };
  }

  try {
    // 固定语义：git commit -m <message>，不自动 add，不接受其它参数
    await runGit(workspaceRoot, ["commit", "-m", v.message]);
    const hash = (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    return { success: true, hash, message: v.message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "git commit failed",
    };
  }
}

// ===========================================================================
// Git Push（Phase 9.4）—— 仅 `git push origin <branch>`，固定语义 + 人工审批。
// ===========================================================================

const ALLOWED_REMOTE = "origin";
const MAX_PUSH_OUTPUT = 5000;
// 禁止空白 / 控制字符 / shell 元字符
const UNSAFE_BRANCH = /[\s;&|<>$()`\\]/;

export interface PushValidation {
  ok: boolean;
  error?: string;
  remote?: string;
  branch?: string;
}

/**
 * 校验 gitPush 输入：remote 只能 origin；branch 合法且真实存在于本地。
 * 供 gitPush 与 pre-approval guard 共用（非法 remote/branch 必须在审批前被拒）。
 */
export async function validatePushInput(
  workspaceRoot: string,
  input: { remote?: unknown; branch?: unknown },
): Promise<PushValidation> {
  const remote = input.remote === undefined ? ALLOWED_REMOTE : input.remote;
  if (remote !== ALLOWED_REMOTE) {
    return { ok: false, error: `only '${ALLOWED_REMOTE}' remote is allowed` };
  }

  let branches: string[];
  let current: string;
  try {
    const info = await gitBranch(workspaceRoot);
    branches = info.branches;
    current = info.current;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "not a git repository",
    };
  }

  let branch: string;
  if (input.branch === undefined || input.branch === null || input.branch === "") {
    branch = current; // 默认当前分支
  } else {
    if (typeof input.branch !== "string") {
      return { ok: false, error: "branch must be a string" };
    }
    branch = input.branch;
  }

  if (!branch || branch.length > 200) {
    return { ok: false, error: "invalid branch name" };
  }
  if (branch.startsWith("-")) {
    return { ok: false, error: `branch cannot start with '-': ${branch}` };
  }
  if (UNSAFE_BRANCH.test(branch)) {
    return { ok: false, error: `branch contains unsafe characters: ${branch}` };
  }
  if (!branches.includes(branch)) {
    return { ok: false, error: `branch does not exist locally: ${branch}` };
  }

  return { ok: true, remote: ALLOWED_REMOTE, branch };
}

export interface GitPushResult {
  success: boolean;
  remote: string;
  branch?: string;
  output?: string;
  error?: string;
}

export async function gitPush(
  workspaceRoot: string,
  input: { remote?: unknown; branch?: unknown },
): Promise<GitPushResult> {
  const v = await validatePushInput(workspaceRoot, input);
  if (!v.ok || !v.branch) {
    return { success: false, remote: ALLOWED_REMOTE, error: v.error };
  }

  // 测试用 mock executor：验证/审批流程全部真实，仅跳过真实网络 push（不伪造真实成功）
  if (process.env.AGENT_GIT_PUSH_MODE === "mock") {
    return {
      success: true,
      remote: ALLOWED_REMOTE,
      branch: v.branch,
      output: "[mock push — not executed]",
    };
  }

  try {
    // 固定语义：git push origin <branch>，无 --force / -u / --delete 等任何额外参数
    const cwd = await assertRepoInWorkspace(workspaceRoot);
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["push", ALLOWED_REMOTE, v.branch],
      { cwd, shell: false, maxBuffer: 10 * 1024 * 1024 },
    );
    const output = `${stdout}${stderr}`.slice(0, MAX_PUSH_OUTPUT);
    return { success: true, remote: ALLOWED_REMOTE, branch: v.branch, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const msg = (e.stderr ?? e.message ?? "git push failed").slice(0, MAX_PUSH_OUTPUT);
    return { success: false, remote: ALLOWED_REMOTE, branch: v.branch, error: msg };
  }
}

