import { NextResponse } from 'next/server';
import { embeddingProvider } from '@/lib/rag/embedding';
import { searchVectors } from '@/lib/rag/vector-search';

export const runtime = 'nodejs';


const MIN_SCORE = 0.5;

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const query = body.query;

        const topK = Number(body.topK ?? 3);

        if(typeof query !== 'string' || !query.trim()) {
            return NextResponse.json(
                {error: 'query 不能为空'},
                {status: 400}
            )
        }
        if(!Number.isInteger(topK) || topK <= 0) {
            return NextResponse.json(
                {error: 'topK 必须是正整数'},
                {status: 400}
            )
        }

        const queryEmbedding = await embeddingProvider.embed(query);

        const results = await searchVectors(queryEmbedding.embedding, topK, MIN_SCORE);

        return NextResponse.json({
            success: true,
            query,
            results: results.map(item => ({
                score: item.score,
                documentId: item.chunk.documentId,
                fileName: item.chunk.fileName,
                chunkId: item.chunk.chunk.id,
                content: item.chunk.chunk.content
            }))
        })
    } catch (error) {
        console.error('向量搜索失败', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : '向量搜索失败'},
            {status: 500}
        )
    }
}