/**
 * github-mcp 核心：只读 GitHub REST API 客户端。
 *
 * 安全要点：
 *   - GITHUB_TOKEN 只用于 Authorization 请求头，绝不进入返回值 / 错误 / 日志
 *   - 只访问 https://api.github.com，路径由 owner/repo/number 结构化拼接（encodeURIComponent）
 *   - 不提供通用 fetchUrl；全部只读；body 有长度上限
 *   - 缺少 token / owner / repo 时优雅返回 { success:false, error }
 */

const API_BASE = "https://api.github.com";
const MAX_BODY = 20_000;

interface GitHubConfig {
  token?: string;
  owner?: string;
  repo?: string;
}

function readConfig(): GitHubConfig {
  return {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
  };
}

export function clampLimit(limit: unknown, def = 20, max = 50): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

export function truncateBody(body: unknown): { body: string; truncated: boolean } {
  const text = typeof body === "string" ? body : "";
  if (text.length > MAX_BODY) {
    return { body: text.slice(0, MAX_BODY), truncated: true };
  }
  return { body: text, truncated: false };
}

export function isPullRequest(item: Record<string, unknown>): boolean {
  return item.pull_request !== undefined && item.pull_request !== null;
}

type Json = Record<string, unknown>;

export function mapRepo(json: Json): Record<string, unknown> {
  return {
    id: json.id,
    name: json.name,
    fullName: json.full_name,
    private: json.private,
    defaultBranch: json.default_branch,
    description: json.description,
    htmlUrl: json.html_url,
    language: json.language,
    stargazersCount: json.stargazers_count,
    forksCount: json.forks_count,
    openIssuesCount: json.open_issues_count,
  };
}

export function mapIssueListItem(json: Json): Record<string, unknown> {
  return {
    number: json.number,
    title: json.title,
    state: json.state,
    author: (json.user as Json | undefined)?.login,
    createdAt: json.created_at,
    updatedAt: json.updated_at,
    htmlUrl: json.html_url,
    labels: Array.isArray(json.labels)
      ? (json.labels as Json[]).map((l) => (typeof l === "string" ? l : l.name))
      : [],
  };
}

export function mapIssueDetail(json: Json): Record<string, unknown> {
  const { body, truncated } = truncateBody(json.body);
  return { ...mapIssueListItem(json), body, truncated };
}

export function mapPrListItem(json: Json): Record<string, unknown> {
  return {
    number: json.number,
    title: json.title,
    state: json.state,
    draft: json.draft,
    author: (json.user as Json | undefined)?.login,
    sourceBranch: (json.head as Json | undefined)?.ref,
    targetBranch: (json.base as Json | undefined)?.ref,
    createdAt: json.created_at,
    updatedAt: json.updated_at,
    htmlUrl: json.html_url,
  };
}

export function mapPrDetail(json: Json): Record<string, unknown> {
  const { body, truncated } = truncateBody(json.body);
  return {
    ...mapPrListItem(json),
    body,
    truncated,
    additions: json.additions,
    deletions: json.deletions,
    changedFiles: json.changed_files,
  };
}

// PLACEHOLDER_GITHUB_CORE
type ApiResult =
  | { ok: true; data: Json | Json[] }
  | { ok: false; error: string };

// 只访问 api.github.com；token 仅用于请求头，绝不出现在返回/错误里
async function apiGet(
  subPath: string[],
  query?: Record<string, string | number>,
): Promise<ApiResult> {
  const cfg = readConfig();
  if (!cfg.token) return { ok: false, error: "GITHUB_TOKEN is not configured" };
  if (!cfg.owner || !cfg.repo) {
    return { ok: false, error: "GITHUB_OWNER/GITHUB_REPO is not configured" };
  }

  const segments = ["repos", cfg.owner, cfg.repo, ...subPath].map((s) =>
    encodeURIComponent(s),
  );
  const url = new URL(`${API_BASE}/${segments.join("/")}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v));
    }
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      // 不回传响应体，避免潜在敏感信息
      return { ok: false, error: `GitHub API error: ${res.status}` };
    }
    return { ok: true, data: (await res.json()) as Json | Json[] };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "GitHub request failed",
    };
  }
}

function validNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

type State = "open" | "closed" | "all";
function normalizeState(s: unknown): State {
  return s === "closed" || s === "all" ? s : "open";
}

export async function githubRepo(): Promise<Record<string, unknown>> {
  const r = await apiGet([]);
  if (!r.ok) return { success: false, error: r.error };
  return { success: true, repo: mapRepo(r.data as Json) };
}

export async function githubIssues(options?: {
  state?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const r = await apiGet(["issues"], {
    state: normalizeState(options?.state),
    per_page: clampLimit(options?.limit),
  });
  if (!r.ok) return { success: false, error: r.error };
  const items = (r.data as Json[]).filter((i) => !isPullRequest(i));
  return { success: true, issues: items.map(mapIssueListItem) };
}

export async function githubIssue(options: {
  number: unknown;
}): Promise<Record<string, unknown>> {
  if (!validNumber(options.number)) {
    return { success: false, error: "invalid issue number" };
  }
  const r = await apiGet(["issues", String(options.number)]);
  if (!r.ok) return { success: false, error: r.error };
  return { success: true, issue: mapIssueDetail(r.data as Json) };
}

export async function githubPullRequests(options?: {
  state?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const r = await apiGet(["pulls"], {
    state: normalizeState(options?.state),
    per_page: clampLimit(options?.limit),
  });
  if (!r.ok) return { success: false, error: r.error };
  return { success: true, pullRequests: (r.data as Json[]).map(mapPrListItem) };
}

export async function githubPullRequest(options: {
  number: unknown;
}): Promise<Record<string, unknown>> {
  if (!validNumber(options.number)) {
    return { success: false, error: "invalid pull request number" };
  }
  const r = await apiGet(["pulls", String(options.number)]);
  if (!r.ok) return { success: false, error: r.error };
  return { success: true, pullRequest: mapPrDetail(r.data as Json) };
}

