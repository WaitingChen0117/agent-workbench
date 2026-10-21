"use client";

import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";

import type { ChatSession } from "@/types/chat";

const STORAGE_KEY = "agent-workbench-sessions";

function createSession(): ChatSession {
  const now = Date.now();

  return {
    id: crypto.randomUUID(),
    title: "新对话",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function useChatSessions() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);

      if (raw) {
        const parsed = JSON.parse(raw) as ChatSession[];

        if (Array.isArray(parsed)) {
          // 从 localStorage 恢复状态只能在 effect 内进行（SSR 安全，
          // 惰性初始化会在服务端崩溃或导致 hydration 不一致），
          // 这里的同步 setState 是必要且一次性的。
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setSessions(parsed);

          // 恢复到最近更新的会话
          if (parsed.length > 0) {
            const latest = [...parsed].sort(
              (a, b) => b.updatedAt - a.updatedAt,
            )[0];
            setActiveSessionId(latest.id);
          }
        }
      }
    } catch (error) {
      console.error("读取聊天记录失败：", error);
    } finally {
      setInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (!initialized) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions, initialized]);

  const createNewSession = useCallback(() => {
    const session = createSession();

    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
  }, []);

  const switchSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));

    setActiveSessionId((currentId) =>
      currentId === sessionId ? null : currentId,
    );
  }, []);

  const updateSessionMessages = useCallback(
    (sessionId: string, messages: UIMessage[]) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const firstUserMessage = messages.find((msg) => msg.role === "user");

          const firstTextPart = firstUserMessage?.parts.find(
            (part) => part.type === "text",
          );

          const title =
            session.title === "新对话" && firstTextPart?.type === "text"
              ? firstTextPart.text.slice(0, 24)
              : session.title;

          return {
            ...session,
            title,
            messages,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;

  return {
    sessions,
    activeSession,
    activeSessionId,
    initialized,
    createNewSession,
    switchSession,
    deleteSession,
    updateSessionMessages,
  };
}
