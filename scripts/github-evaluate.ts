import fs from "node:fs/promises";
import path from "node:path";

import {
  clampLimit,
  isPullRequest,
  truncateBody,
  mapIssueListItem,
  githubRepo,
} from "@/lib/mcp/github/core";
import { sanitizeToolOutput } from "@/lib/agent/trace/sanitize";
import { getMcpClient } from "@/lib/mcp/client";
import { createAndStartTask } from "@/lib/agent/task/runtime";
import * as eventBus from "@/lib/agent/task/event-bus";
import { getTask } from "@/lib/agent/task/store";

const ROOT = process.cwd();
const CONFIGURED = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO);

type Outcome = "PASS" | "FAIL" | "SKIP";

interface GhCase {
  id: string;
  kind: string;
  tool?: string;
  input?: Record<string, unknown>;
  field?: string;
  arrayKey?: string;
  numberEnv?: string;
}

function parse(raw: unknown): { success?: boolean; result?: unknown } {
  const r = raw as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  try { return { success: true, result: JSON.parse(text) }; } catch { return { success: true, result: text }; }
}

async function runCase(c: GhCase): Promise<{ outcome: Outcome; note: string }> {
  switch (c.kind) {
    case "clamp": {
      const ok = clampLimit(100) === 50 && clampLimit(5) === 5 && clampLimit(0) === 1;
      return { outcome: ok ? "PASS" : "FAIL", note: `clampLimit(100)=${clampLimit(100)}` };
    }
    case "filter-pr": {
      const sample = [
        { number: 1, title: "issue", user: { login: "a" } },
        { number: 2, title: "pr", pull_request: { url: "x" }, user: { login: "b" } },
      ];
      const filtered = sample.filter((i) => !isPullRequest(i)).map(mapIssueListItem);
      const ok = filtered.length === 1 && filtered[0].number === 1;
      return { outcome: ok ? "PASS" : "FAIL", note: `kept ${filtered.length}/2 (pull_request filtered)` };
    }
    case "truncate": {
      const r = truncateBody("x".repeat(25000));
      const ok = r.truncated === true && r.body.length === 20000;
      return { outcome: ok ? "PASS" : "FAIL", note: `truncated=${r.truncated}, len=${r.body.length}` };
    }
    case "sanitize": {
      const out = sanitizeToolOutput("githubRepo", {
        success: true,
        result: { api_key: "x", authorization: "Bearer y", token: "z", password: "p", name: "ok" },
      });
      const s = JSON.stringify(out);
      const ok = !s.includes("Bearer y") && !/"token":"z"/.test(s) && (s.match(/\[REDACTED\]/g)?.length ?? 0) >= 3;
      return { outcome: ok ? "PASS" : "FAIL", note: s.slice(0, 140) };
    }
    case "no-token": {
      const saved = process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      const r = await githubRepo();
      if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
      const ok = r.success === false && String(r.error).includes("GITHUB_TOKEN");
      return { outcome: ok ? "PASS" : "FAIL", note: String(r.error) };
    }
    case "live-call": {
      if (!CONFIGURED) return { outcome: "SKIP", note: "GITHUB_TOKEN/OWNER/REPO not configured" };
      const client = await getMcpClient("github");
      const res = parse(await client.callTool({ name: c.tool as string, arguments: c.input ?? {} }));
      const data = res.result as Record<string, unknown>;
      if (data?.success === false) return { outcome: "FAIL", note: String(data.error) };
      const ok = c.arrayKey ? Array.isArray(data?.[c.arrayKey]) : c.field ? c.field in (data ?? {}) : true;
      return { outcome: ok ? "PASS" : "FAIL", note: JSON.stringify(data).slice(0, 120) };
    }
    case "live-number": {
      if (!CONFIGURED) return { outcome: "SKIP", note: "not configured" };
      const num = Number(process.env[c.numberEnv as string]);
      if (!Number.isInteger(num) || num <= 0) return { outcome: "SKIP", note: `${c.numberEnv} not set` };
      const client = await getMcpClient("github");
      const res = parse(await client.callTool({ name: c.tool as string, arguments: { number: num } }));
      const data = res.result as Record<string, unknown>;
      const ok = data?.success !== false && !!(c.field && c.field in (data ?? {}));
      return { outcome: ok ? "PASS" : "FAIL", note: JSON.stringify(data).slice(0, 120) };
    }
    case "agent": {
      if (!CONFIGURED) return { outcome: "SKIP", note: "not configured" };
      const task = createAndStartTask({
        messages: [{ role: "user", content: "查看这个 GitHub 仓库最近有哪些 Open Issues 和 Pull Requests，并总结。" }],
        maxSteps: 8,
      });
      const tools: string[] = [];
      await new Promise<void>((resolve) => {
        const unsub = eventBus.subscribe(task.id, (e) => {
          if (e.type === "tool.started") tools.push((e.data as { tool: string }).tool);
          if (e.type === "task.completed" || e.type === "task.failed" || e.type === "task.cancelled") { unsub(); resolve(); }
        });
      });
      const ok = getTask(task.id)?.status === "completed" && tools.includes("githubIssues") && tools.includes("githubPullRequests");
      return { outcome: ok ? "PASS" : "FAIL", note: `tools=${tools.join(",")}` };
    }
    default:
      return { outcome: "FAIL", note: "unknown kind" };
  }
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/github-evaluation.json"), "utf-8");
  const cases: GhCase[] = JSON.parse(raw).cases;

  console.log("========================================");
  console.log("GitHub MCP Evaluation");
  console.log("========================================");
  if (!CONFIGURED) console.log("(GITHUB_TOKEN/OWNER/REPO not set → live cases SKIPPED)\n");

  let passed = 0, failed = 0, skipped = 0;
  for (const c of cases) {
    const r = await runCase(c);
    if (r.outcome === "PASS") passed += 1;
    else if (r.outcome === "SKIP") skipped += 1;
    else failed += 1;
    console.log(`Case: ${c.id.padEnd(26)} ${r.outcome}  (${r.note})`);
  }

  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  const denom = passed + failed;
  console.log(`Success Rate: ${denom === 0 ? 100 : Math.round((passed / denom) * 100)}% (of ${denom} run)`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
