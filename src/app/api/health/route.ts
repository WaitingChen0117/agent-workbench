import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/health
 *
 * 健康检查接口，返回当前服务状态与时间戳。
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
