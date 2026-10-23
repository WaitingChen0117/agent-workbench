import { getTaskStore } from "@/lib/agent/task/task-store";
import * as eventBus from "@/lib/agent/task/event-bus";
import type { AgentTaskEvent, AgentTaskEventType } from "@/lib/agent/task/types";

export const runtime = "nodejs";

const HEARTBEAT_INTERVAL_MS = 15_000;

const TERMINAL_EVENT_TYPES: ReadonlySet<AgentTaskEventType> = new Set([
  "task.completed",
  "task.failed",
  "task.cancelled",
]);

const encoder = new TextEncoder();

// 标准 SSE 帧：id / event / data
function frame(id: string, event: string, data: unknown): Uint8Array {
  return encoder.encode(
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

// 只把必要字段发给客户端，绝不把整个 Task 对象塞进去
function toPayload(event: AgentTaskEvent): Record<string, unknown> {
  const base = { taskId: event.taskId, timestamp: event.timestamp };

  if (event.data && typeof event.data === "object") {
    return { ...base, ...(event.data as Record<string, unknown>) };
  }

  return base;
}

/**
 * GET /api/agent/tasks/:taskId/stream
 *
 * 建立 SSE 连接，按 taskId 订阅 Event Bus 并实时下发事件。
 * 处理若干生命周期：任务不存在(404) / 运行中 / 已结束后才连接 / 客户端断开。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await params;

  const task = await getTaskStore().get(taskId);

  if (!task) {
    return new Response(JSON.stringify({ error: "Task not found", taskId }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sentIds = new Set<string>();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(chunk);
        } catch {
          // 控制器已关闭，忽略
        }
      };

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        unsubscribe?.(); // 关键：断开时取消订阅，避免 Listener 泄漏
        try {
          controller.close();
        } catch {
          // 已关闭，忽略
        }
      };

      // 写出一个事件（去重），并在收到终态事件后收尾关闭
      const writeEvent = (event: AgentTaskEvent): void => {
        if (sentIds.has(event.id)) {
          return;
        }
        sentIds.add(event.id);
        safeEnqueue(frame(event.id, event.type, toPayload(event)));

        if (TERMINAL_EVENT_TYPES.has(event.type)) {
          cleanup();
        }
      };

      // 回放期间先缓冲实时事件，回放后统一刷出，保证顺序且不丢事件
      let replaying = true;
      const buffer: AgentTaskEvent[] = [];

      const liveListener = (event: AgentTaskEvent): void => {
        if (replaying) {
          buffer.push(event);
        } else {
          writeEvent(event);
        }
      };

      // 1. 先订阅（此刻起的实时事件不会漏，先进 buffer）
      unsubscribe = eventBus.subscribe(taskId, liveListener);

      // 2. 先发一个轻量快照，让客户端立即知道当前状态
      const current = await getTaskStore().get(taskId);
      safeEnqueue(
        frame(`snapshot-${taskId}`, "task.snapshot", {
          taskId,
          status: current?.status,
          currentStep: current?.currentStep,
          maxSteps: current?.maxSteps,
        }),
      );

      // 3. 回放已记录的历史事件（late join 也能看到已发生的事）
      for (const event of await getTaskStore().getEvents(taskId)) {
        writeEvent(event);
      }

      // 4. 结束回放，刷出缓冲的实时事件
      replaying = false;
      for (const event of buffer) {
        writeEvent(event);
      }

      // 5. 若任务在连接时已是终态：回放里已含终态事件并触发了 cleanup；
      //    这里兜底，防止终态事件因故未记录导致连接悬挂。
      if (current && TERMINAL_EVENT_TYPES.has(statusToTerminalEvent(current.status))) {
        cleanup();
        return;
      }

      // 6. 心跳：长时间无事件时保活
      heartbeat = setInterval(() => {
        safeEnqueue(
          frame(`hb-${Date.now()}`, "heartbeat", {
            timestamp: new Date().toISOString(),
          }),
        );
      }, HEARTBEAT_INTERVAL_MS);

      // 7. 客户端断开：清理订阅与心跳
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

// 把终态 status 映射成对应的终态事件类型（用于兜底判断）
function statusToTerminalEvent(status: string): AgentTaskEventType {
  switch (status) {
    case "completed":
      return "task.completed";
    case "failed":
      return "task.failed";
    case "cancelled":
      return "task.cancelled";
    default:
      // 非终态返回一个非终态事件类型，使 TERMINAL_EVENT_TYPES.has 为 false
      return "task.started";
  }
}
