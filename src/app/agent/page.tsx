"use client";

import { useRef, useState } from "react";

// 第四阶段最小验证页：输入问题 → POST /api/agent → 建立 SSE → 实时显示 Event。
// 重点验证 Event Stream，UI 从简。

interface LogLine {
  type: string;
  text: string;
}

const ALL_EVENT_TYPES = [
  "task.snapshot",
  "task.created",
  "task.started",
  "agent.step.started",
  "llm.requested",
  "message.started",
  "message.delta",
  "message.completed",
  "tool.started",
  "tool.completed",
  "agent.step.completed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "heartbeat",
];

export default function AgentPage() {
  const [input, setInput] = useState("React 中 useReducer 和 useState 有什么区别？");
  const [running, setRunning] = useState(false);
  const [taskId, setTaskId] = useState<string>("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [answer, setAnswer] = useState("");
  const esRef = useRef<EventSource | null>(null);

  const appendLog = (type: string, text: string) => {
    setLogs((prev) => [...prev, { type, text }]);
  };

  const run = async () => {
    if (!input.trim() || running) {
      return;
    }

    // 清理上一次连接
    esRef.current?.close();
    setLogs([]);
    setAnswer("");
    setTaskId("");
    setRunning(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: input }],
        }),
      });

      const data = (await res.json()) as { taskId?: string; error?: string };

      if (!data.taskId) {
        appendLog("error", data.error ?? "创建任务失败");
        setRunning(false);
        return;
      }

      setTaskId(data.taskId);

      const es = new EventSource(`/api/agent/tasks/${data.taskId}/stream`);
      esRef.current = es;

      for (const type of ALL_EVENT_TYPES) {
        es.addEventListener(type, (ev) => {
          const payload = (ev as MessageEvent).data as string;

          if (type === "heartbeat") {
            return; // 心跳不刷屏
          }

          if (type === "message.delta") {
            try {
              const parsed = JSON.parse(payload) as { content?: string };
              if (parsed.content) {
                setAnswer((prev) => prev + parsed.content);
              }
            } catch {
              /* ignore */
            }
            return;
          }

          appendLog(type, payload);

          if (
            type === "task.completed" ||
            type === "task.failed" ||
            type === "task.cancelled"
          ) {
            es.close();
            esRef.current = null;
            setRunning(false);
          }
        });
      }

      es.onerror = () => {
        appendLog("sse.error", "SSE 连接中断");
        es.close();
        esRef.current = null;
        setRunning(false);
      };
    } catch (error) {
      appendLog("error", error instanceof Error ? error.message : String(error));
      setRunning(false);
    }
  };

  return (
    <div style={{ maxWidth: 820, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>Agent Stream 测试</h1>

      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        style={{ width: "100%", padding: 8, fontSize: 14 }}
      />

      <div style={{ margin: "12px 0" }}>
        <button onClick={run} disabled={running} style={{ padding: "6px 18px" }}>
          {running ? "Running..." : "Run"}
        </button>
        {taskId && (
          <span style={{ marginLeft: 12, color: "#888", fontSize: 12 }}>
            taskId: {taskId}
          </span>
        )}
      </div>

      {answer && (
        <div
          style={{
            whiteSpace: "pre-wrap",
            background: "#f6f8fa",
            padding: 12,
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          <strong>Answer（流式）：</strong>
          <div>{answer}</div>
        </div>
      )}

      <div style={{ fontFamily: "monospace", fontSize: 13 }}>
        {logs.map((line, index) => (
          <div key={index} style={{ padding: "2px 0" }}>
            <span style={{ color: "#0969da" }}>[{line.type}]</span> {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
