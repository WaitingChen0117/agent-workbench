import { NextResponse } from "next/server";

import { getPersistenceHealth } from "@/lib/agent/persistence/health";

export const runtime = "nodejs";

// GET /api/agent/persistence/health —— 只读持久化诊断（不暴露敏感信息、不修改数据）
export async function GET() {
  const health = await getPersistenceHealth();
  return NextResponse.json(health);
}
