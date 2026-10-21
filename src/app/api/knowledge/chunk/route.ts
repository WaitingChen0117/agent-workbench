import {NextResponse} from 'next/server';

import {splitText} from '@/lib/rag/chunk';

export async function POST(req: Request) {
    try {
        const body = await req.json();

        const text = body.text;
        const chunkSize = body.chunkSize ?? 500;
        const overlap = body.overlap ?? 100;

        if(typeof text !== 'string' || !text.trim()) {
            return NextResponse.json(
                {error: "请输入有效文本内容"},
                {status: 400}
            );
        }

        const chunks = splitText(text, {chunkSize, overlap});

        return NextResponse.json({
            total: chunks.length,
            chunks,
        })
    } catch (error) {
        console.error('文本切分失败：', error);

        return NextResponse.json(
            {
                error:
                error instanceof Error
                    ? error.message
                    : '文本切分失败',
            },
            { status: 500 },
        );
    }
}