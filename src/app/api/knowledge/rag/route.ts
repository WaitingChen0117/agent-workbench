import { NextResponse } from "next/server";

import { answerWithKnowledge } from "@/lib/rag/rag";

export const runtime = 'nodejs';

type HistoryMessage = {
    role: 'user' | 'assistant';
    content: string;
};

// 过滤掉结构不合法的历史消息，保证传给模型的数据类型安全
function parseHistory(value: unknown): HistoryMessage[] {
    if(!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is HistoryMessage =>
        typeof item === 'object'
        && item !== null
        && (item.role === 'user' || item.role === 'assistant')
        && typeof item.content === 'string'
        && item.content.trim() !== ''
    );
}

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const query = body.query;

        if(typeof query !== 'string' || !query.trim()) {
            return NextResponse.json(
                {error: 'query 不能为空'},
                {status: 400}
            )
        }

        const history = parseHistory(body.history);

        const result = await answerWithKnowledge(query, {history});

        return NextResponse.json({
            answer: result.answer,
            sources: result.sources,
            query: result.originalQuery,
            needRewrite: result.needRewrite,
            rewrittenQuery: result.rewrittenQuery,
        })
    } catch (error) {
        console.error('RAG 生成失败', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : 'RAG 生成失败'},
            {status: 500}
        )
    }
}