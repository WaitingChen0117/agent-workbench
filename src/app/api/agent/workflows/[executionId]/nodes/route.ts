import { NextResponse } from "next/server";

import { getWorkflowExecutionStore } from "@/lib/agent/workflow/execution-store";

export const runtime = "nodejs";

// GET /api/agent/workflows/:executionId/nodes —— 查询各节点的执行态（持久化）
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;

  const store = getWorkflowExecutionStore();
  const execution = await store.get(executionId);
  if (!execution) {
    return NextResponse.json(
      { error: "Execution not found", executionId },
      { status: 404 },
    );
  }

  const nodes = (await store.listNodes(executionId)).map((n) => ({
    nodeId: n.nodeId,
    nodeType: n.nodeType,
    status: n.status,
    startedAt: n.startedAt,
    endedAt: n.endedAt,
    result: n.result,
    error: n.error,
    attempt: n.attempt,
  }));

  return NextResponse.json({ executionId, nodes });
}
