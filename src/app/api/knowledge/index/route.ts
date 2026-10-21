import {NextResponse} from 'next/server';

import {parseDocument} from '@/lib/rag/document-parser';
import {indexChunks} from '@/lib/rag/indexer';
import { addDocumentChunks } from '@/lib/rag/vector-store';
import { addDocument } from '@/lib/rag/document-store';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    try {
        const formData = await req.formData();

        const file = formData.get('file');

        if(!(file instanceof File)) {
            return NextResponse.json(
                {error: '请上传文件'},
                {status: 400}
            )
        }
        
        const document = await parseDocument(file, {
            chunkSize: 500,
            overlap: 100,
        })

        const documentId = crypto.randomUUID();

        console.log(`开始生成 Embedding，共 ${document.chunks.length} 个 Chunk`);

        const indexedChunks = await indexChunks(document.chunks, undefined, {batchSize: 10});

        const storedChunks = await addDocumentChunks(documentId, document.fileName, indexedChunks);

        const now = new Date().toISOString();

        await addDocument({
            id: documentId,
            fileName: document.fileName,
            fileSize: document.fileSize,
            characterCount: document.content.length,
            chunkCount: storedChunks.length,
            createdAt: now,
            updatedAt: now,
        })

        return NextResponse.json({
            success: true,
            document: {
                fileName: document.fileName,
                fileSize: document.fileSize,
                characterCount: document.content.length,
                chunkCount: storedChunks.length,
            },
            chunks: storedChunks.map((item) => ({
                id: item.chunk.id,
                index: item.chunk.index,
                content: item.chunk.content,
                embeddingDimensions: item.embedding.length,
            }))
        })
    } catch (error) {
        console.error('文档向量化失败：', error);

        return NextResponse.json(
            {error: error instanceof Error ? error.message : '文档向量化失败'},
            {status: 500}
        )
    }
}
