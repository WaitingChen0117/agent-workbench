import { NextResponse } from "next/server";

import { getDocuments } from "@/lib/rag/document-store";

export const runtime = 'nodejs';

export async function GET() {
    try {
        const documents = await getDocuments();

        return NextResponse.json({
            success: true,
            documents,
        })
    } catch (error) {
        console.error('获取知识库失败：', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : '获取知识库失败'},
            {status: 500}
        )
    }
}