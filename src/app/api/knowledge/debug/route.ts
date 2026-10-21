import { NextResponse } from "next/server";
import { retrieveKnowledge } from '@/lib/rag/rag';

import {aiModel} from '@/lib/ai';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const {query, history = []} = body;

        if(typeof query !== 'string' || !query.trim()) {
            return NextResponse.json(
                {error: 'query 不能为空'},
                {status: 400}
            )
        }

        const model = aiModel;

        const ragResult = await retrieveKnowledge(query, history, 5, model);

        const topScore = ragResult.sources[0]?.score ?? 0;

        const historyText = Array.isArray(history)
            ? history
                .map((message: {role: string; content: string}) =>
                    `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
                .join('\n')
            : '';

        const sourcesText = ragResult.sources
            .map((source, index) =>
                `[${index + 1}] ${source.fileName} (${source.score.toFixed(4)}) ${source.content.slice(0, 80).replace(/\n/g, ' ')}`)
            .join('\n');

        console.log([
            '========== Multi-turn RAG ==========',
            `Original Query:\n${ragResult.originalQuery}`,
            `History:\n${historyText || '（无）'}`,
            '========== Query Rewrite ==========',
            `Need Rewrite: ${ragResult.needRewrite}`,
            `Rewritten Query:\n${ragResult.rewrittenQuery}`,
            '========== Retrieval ==========',
            `Retrieved: ${ragResult.sources.length}`,
            `Top Score: ${topScore.toFixed(4)}`,
            '========== Sources ==========',
            sourcesText || '（无）',
        ].join('\n\n'));

        return NextResponse.json({
            success: true,
            originalQuery: ragResult.originalQuery,
            history,
            needRewrite: ragResult.needRewrite,
            rewrittenQuery: ragResult.rewrittenQuery,
            retrievedCount: ragResult.sources.length,
            topScore,
            sources: ragResult.sources.map(source => ({
                fileName: source.fileName,
                score: source.score,
            })),
            retrieval: ragResult.sources,
            context: ragResult.prompt
        })
    } catch (error) {
        console.log('RAG Debug error', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : 'Debug failed'},
            {status: 500}
        )
    }
}
