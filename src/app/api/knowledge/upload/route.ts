import { NextResponse } from "next/server";

import { parseDocument } from "@/lib/rag/document-parser";

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const formData = await req.formData();
        const file = formData.get('file');

        if(!(file instanceof File)) {
            return NextResponse.json({error: '请选择要上传的文件'}, {status: 400});
        }

        const chunkSizeValue = formData.get('chunkSize');
        const overlapValue = formData.get('overlap');

        const chunkSize = chunkSizeValue === null ? 500 : Number(chunkSizeValue);

        const overlap = overlapValue === null ? 100 : Number(overlapValue);

        if(!Number.isInteger(chunkSize) || !Number.isInteger(overlap) || chunkSize <= 0 || overlap < 0 || overlap >= chunkSize) {
            return NextResponse.json(
                {error: '文本切分参数不合法'},
                {status: 400}
            )
        }
        const document = await parseDocument(file, {chunkSize, overlap});

        return NextResponse.json({
            success: true,
            document: {
                fileName: document.fileName,
                fileType: document.fileType,
                fileSize: document.fileSize,
                characterCount: document.content.length,
                chunkCount: document.chunks.length,
            },
            chunks: document.chunks,
        })
    } catch (error) {
        console.error('文档解析失败：', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : '文档解析失败，请稍后重试'},
            {status: 500}
        );
    }
}