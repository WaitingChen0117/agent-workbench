import fs from "node:fs/promises";
import path from "node:path";

import { getMcpClient } from "@/lib/mcp/client";

/**
 * Git MCP Evaluation CLI —— 直接通过 git MCP (stdio) 调用只读工具并校验结果。
 * 复用现有 Evaluation 风格，独立于 Agent Runtime。
 */
const ROOT = process.cwd();

type Criterion =
  | { type: "field"; path: string }
  | { type: "arrayNonEmpty" };

interface GitCase {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  successCriteria: Criterion[];
}

interface Normalized {
  success: boolean;
  result: unknown;
  error?: string;
}

function parseResult(raw: unknown): Normalized {
  const r = raw as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) return { success: false, result: undefined, error: text };
  try {
    return { success: true, result: JSON.parse(text) };
  } catch {
    return { success: true, result: text };
  }
}

function check(c: Criterion, n: Normalized): { ok: boolean; label: string } {
  if (!n.success) return { ok: false, label: `tool error: ${n.error}` };
  const data = n.result as Record<string, unknown>;
  if (c.type === "field") {
    return { ok: data != null && c.path in data, label: `has field ${c.path}` };
  }
  return { ok: Array.isArray(n.result) && n.result.length > 0, label: "non-empty array" };
}

async function main() {
  const raw = await fs.readFile(path.join(ROOT, "data/git-evaluation.json"), "utf-8");
  const cases: GitCase[] = JSON.parse(raw).cases;

  const client = await getMcpClient("git");

  console.log("========================================");
  console.log("Git MCP Evaluation");
  console.log("========================================");

  let passed = 0;
  for (const c of cases) {
    const result = parseResult(await client.callTool({ name: c.tool, arguments: c.input }));
    const checks = c.successCriteria.map((cr) => check(cr, result));
    const pass = checks.every((x) => x.ok);
    if (pass) passed += 1;
    console.log(`\nCase: ${c.id}`);
    console.log(`Status: ${pass ? "PASS" : "FAIL"}`);
    for (const chk of checks) console.log(`  [${chk.ok ? "ok" : "XX"}] ${chk.label}`);
  }

  console.log("\n========================================");
  console.log("Summary");
  console.log("========================================");
  console.log(`Total: ${cases.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${cases.length - passed}`);
  console.log(`Success Rate: ${Math.round((passed / cases.length) * 100)}%`);

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
