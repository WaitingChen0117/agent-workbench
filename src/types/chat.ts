import type { UIMessage } from "ai";

export interface ChatSession {
    id: string;
    title: string;
    messages: UIMessage[];
    createdAt: number;
    updatedAt: number;
}