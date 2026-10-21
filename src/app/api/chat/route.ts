import { convertToModelMessages, streamText, type UIMessage } from "ai";
import {aiModel} from '@/lib/ai';

import { retrieveKnowledge } from "@/lib/rag/rag";
import { getMessageText } from "@/lib/chat/message";

export async function POST(request: Request) {
    try {
        const body = (await request.json()) as {messages: UIMessage[]};

        const {messages} = body;

        if(!Array.isArray(messages) || messages.length === 0) {
            return Response.json(
                {error: 'messages is required'},
                {status: 400},
            )
        }

        // =========================
        // 1. 获取当前用户问题
        // =========================

        const lastUserMessage = messages
            .slice()
            .reverse()
            .find((message: {role: string}) => message.role === 'user');

        const query = lastUserMessage ? getMessageText(lastUserMessage) : '';

         // =========================
        // 2. 历史对话
        // =========================
        const history = messages
            .filter(
            (message: { role: string }) =>
                message.role === 'user' ||
                message.role === 'assistant',
            )
            .slice(0, -1)
            .slice(-6)
            .map((message) => ({
                role: message.role as 'user' | 'assistant',
                content: getMessageText(message),
            }));

        


        // =========================
        // 3. Query Rewrite + RAG 检索
        // =========================

        const ragResult = query 
            ? await retrieveKnowledge(
                query,
                history,
                3,
                aiModel,
            ) 
            : null;

        console.log('========== RAG ==========');

        console.log('用户问题:', query);

        console.log(
            '知识库来源:',
            ragResult?.sources.map(
                (source) => ({
                fileName: source.fileName,
                score: source.score,
                content:
                    source.content.slice(0, 100),
                }),
            ),
        );

        // =========================
        // 4. LLM
        // =========================

        const result = streamText({
            model: aiModel,
            system: ragResult?.prompt,
            messages: await convertToModelMessages(messages),
            // 千帆 Responses 端点不支持 item_reference 输入类型。
            // store 默认为 true 时，多轮对话会把历史 assistant 消息序列化成
            // { type: 'item_reference', id }，导致第二轮 400。
            // 关闭 store，让历史消息以完整 message 内联回传。
            providerOptions: {
                openai: {
                    store: false,
                },
            },
        })

        // =========================
        // 5. 返回流
        // =========================

        return result.toUIMessageStreamResponse();
    } catch (e) {
        console.error("AI chat error:", e);

        return Response.json(
            {error: 'AI request failed'},
            {status: 500},
        )
    }
}