import type { TextChunk } from "@/lib/rag/chunk";
import {embeddingProvider, type EmbeddingProvider} from '@/lib/rag/embedding';

import type { IndexedChunk } from "@/lib/rag/retriever";

export interface IndexOptions {
    batchSize?: number;
}

export async function indexChunks (
    chunks: TextChunk[],
    provider: EmbeddingProvider = embeddingProvider,
    options: IndexOptions = {},
): Promise<IndexedChunk[]> {
    const batchSize = options.batchSize ?? 10;

    if(!chunks.length) {
        return [];
    }

    const result: IndexedChunk[] = [];

    for(let start = 0; start < chunks.length; start += batchSize) {
        const batch = chunks.slice(start, start + batchSize);

        const embeddings = await provider.embedMany(batch.map((chunk) => chunk.content));

        if(embeddings.length !== batch.length) {
            throw new Error(`Embedding 数量异常：期望 ${batch.length}，实际 ${embeddings.length}`)
        }

        for(let i = 0; i<batch.length;i++) {
            result.push({
                chunk: batch[i],
                embedding: embeddings[i].embedding
            })
        }
    }

    return result;
}