/**
 * 跨进程 Trace 验证子进程：把一条 Trace 写入共享 SQLite，然后退出。
 * 用法：tsx scripts/trace-child.ts write <traceB64>
 * 依赖 env：AGENT_TRACE_STORE=sqlite, AGENT_TASK_DB_PATH。
 */
import { getTraceStore } from "@/lib/agent/trace/trace-store";
import type { AgentTrace } from "@/lib/agent/trace/types";

function main(): void {
  const mode = process.argv[2];
  if (mode === "write") {
    const trace = JSON.parse(
      Buffer.from(process.argv[3], "base64").toString("utf-8"),
    ) as AgentTrace;
    getTraceStore().putTrace(trace);
    console.log(JSON.stringify({ ok: true, taskId: trace.taskId }));
    process.exit(0);
  }
  if (mode === "append-events") {
    // append-events <traceId> <count>
    const traceId = process.argv[3];
    const count = Number(process.argv[4] ?? 3);
    const store = getTraceStore();
    for (let i = 0; i < count; i += 1) {
      store.appendTraceEvent(traceId, {
        traceId,
        sequence: 0,
        eventId: `child-ev-${i}`,
        timestamp: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 1000).toISOString(),
        type: "tool.started",
        payload: { i },
      });
    }
    console.log(JSON.stringify({ ok: true, traceId, count }));
    process.exit(0);
  }
  console.error("unknown mode");
  process.exit(2);
}

main();
