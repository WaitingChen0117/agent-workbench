'use client';

import {Button, Empty, Popconfirm, Typography} from 'antd';
import {DeleteOutlined, PlusOutlined} from '@ant-design/icons';

import type {ChatSession} from '@/types/chat';

interface ChatSidebarProps {
    sessions: ChatSession[];
    activeSessionId: string | null;
    onCreate: () => void;
    onSwitch: (sessionId: string) => void;
    onDelete: (sessionId: string) => void;
}

export default function ChatSidebar({sessions, activeSessionId, onCreate, onSwitch, onDelete}: ChatSidebarProps) {
    return (
        <aside className='chat-sidebar'>
            <Button type="primary" block icon={<PlusOutlined />} onClick={onCreate}>
                新建对话
            </Button>

            <Typography.Title level={5}>历史对话</Typography.Title>

            <div className="chat-session-list">
                {sessions.length === 0 ? (
                    <Empty description="暂无历史对话" />
                ) : (
                    sessions.map((session) => (
                        <div
                            key={session.id}
                            className={`chat-session-item ${
                                session.id === activeSessionId ? 'active' : ''
                            }`}
                        >
                            <button
                                type="button"
                                className="chat-session-title"
                                onClick={() => onSwitch(session.id)}
                                title={session.title}
                            >
                                {session.title}
                            </button>

                            <Popconfirm
                                title="确定删除这个会话吗？"
                                description="删除后无法恢复。"
                                onConfirm={() => onDelete(session.id)}
                                okText="删除"
                                cancelText="取消"
                            >
                                <Button
                                    type="text"
                                    danger
                                    size="small"
                                    icon={<DeleteOutlined />}
                                    aria-label="删除会话"
                                />
                            </Popconfirm>
                        </div>
                    ))
                )}
            </div>
        </aside>
    )
}