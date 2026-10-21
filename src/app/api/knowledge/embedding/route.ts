import { NextResponse } from "next/server";
import {embeddingProvider} from '@/lib/rag/embedding';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        if(typeof body.text !== 'string' || !body.text.trim()) {
            return NextResponse.json(
                {error: 'text 不能为空'},
                {status: 400}
            )
        }

        const result = await embeddingProvider.embed(body.text);

        return NextResponse.json({
            success: true,
            dimensions: result.dimensions,
            embedding: result.embedding
        })
    } catch (error) {
        console.error('Embedding 失败：', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : 'Embedding 请求失败'},
            {status: 500}
        )
    }
}