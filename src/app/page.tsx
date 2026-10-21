'use client';

import { useState, useEffect, useRef } from "react";
import {useChat} from '@ai-sdk/react';
import {Button, Input, Spin, Typography} from 'antd';
import MarkdownContent from "@/components/MarkdownContent";
import ChatSidebar from "@/components/ChatSidebar";
import { useChatSessions } from "@/hooks/useChatSessions";

const {TextArea} = Input;
const {Text, Paragraph} = Typography;

export default function Home() {
  const [input, setInput] = useState('');

  const {
    sessions,
    activeSession,
    activeSessionId,
    initialized,
    createNewSession,
    switchSession,
    deleteSession,
    updateSessionMessages,
  } = useChatSessions();

  const {messages, setMessages, sendMessage, status, error, regenerate, stop} = useChat();

  const activeSessionIdRef = useRef<string | null>(null);
  const restoringRef = useRef(false);

  const isLoading = status === 'submitted' || status === 'streaming';

  async function handleSubmit() {
    const text = input.trim();
    if(!text || isLoading) {
      return;
    }

    setInput('');
    
    await sendMessage({text});
  }

  // 切换会话时恢复消息
  useEffect(() => {
    if (!initialized) {
      return;
    }

    if(status === 'streaming' || status === 'submitted') {
      return;
    }

    restoringRef.current = true;
    activeSessionIdRef.current = activeSessionId;
    setMessages(activeSession?.messages ?? []);
  }, [
    initialized,
    activeSessionId,
    activeSession,
    setMessages,
    status
  ])

  // 消息变化后保存到当前会话
  useEffect(() => {
    if (!initialized || restoringRef.current) {
      restoringRef.current = false;
      return;
    }

    if(!activeSessionIdRef.current) {
      return;
    }

    updateSessionMessages(activeSessionIdRef.current, messages);
  }, [
    initialized,
    messages,
    updateSessionMessages
  ]);

  const handleCreateSession = () => {
    if(status === 'streaming' || status === 'submitted') {
      stop();
    }

    createNewSession();
  }

  const handleSwitchSession = (sessionId: string) => {
    if(status === 'streaming' || status === 'submitted') {
      stop();
    }

    switchSession(sessionId);
  }

  const handleDeleteSession = (sessionId: string) => {
    deleteSession(sessionId);
  }

  return (

    <div className="chat-layout">
      <ChatSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onCreate={handleCreateSession}
        onSwitch={handleSwitchSession}
        onDelete={handleDeleteSession}
      />

      <main className="chat-main">
        <Typography.Title level={2}>
          Agent Workbench
        </Typography.Title>

        <Paragraph type="secondary">
          多轮对话 · Tool Use · RAG 知识库
        </Paragraph>

        <section
          style={{
            minHeight: 400,
            padding: 16,
            marginBottom: 16,
            border: '1px solid #eee',
            borderRadius: 8,
          }}
        >
          {messages.length === 0 && (
            <Text type="secondary">
              输入一个问题，开始与 AI 对话。
            </Text>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              style={{ marginBottom: 24 }}
            >
              <Text strong>
                {message.role === 'user' ? '你' : 'AI'}
              </Text>

              {message.parts.map((part, index) => {
                if (part.type !== 'text') {
                  return null;
                }

                return (
                  <MarkdownContent
                    key={`${message.id}-${index}`}
                    content={part.text}
                  />
                );
              })}
            </div>
          ))}

          {status === 'submitted' && <Spin />}

          {error && (
            <Text type="danger">
              请求失败：{error.message}
            </Text>
          )}
        </section>

        <TextArea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="请输入你的问题，Enter 发送，Shift + Enter 换行"
          autoSize={{ minRows: 3, maxRows: 8 }}
          disabled={isLoading}
        />

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 12,
          }}
        >

          <Button
            type="primary"
            loading={isLoading}
            disabled={!input.trim() || isLoading}
            onClick={() => void handleSubmit()}
          >
            发送
          </Button>

          {isLoading ? (
            <Button onClick={() => stop()}>
              停止生成
            </Button>
          ) : (
            <Button
              onClick={() => void regenerate()}
              disabled={messages.length === 0}
            >
              重新生成
            </Button>
          )}
        </div>
      </main>
    </div>
  )
}