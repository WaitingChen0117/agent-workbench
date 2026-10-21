import {cosineSimilarity} from '@/lib/rag/similarity';
import type { TextChunk } from '@/lib/rag/chunk';

export interface IndexedChunk {
    chunk: TextChunk;
    embedding: number[];
}

export interface SearchResult {
    chunk: TextChunk;
    score: number;
}

export function retrieveChunks (
    queryEmbedding: number[],
    indexedChunks: IndexedChunk[],
    topK = 3,
): SearchResult[] {
    if(!Number.isInteger(topK) || topK <= 0) {
        throw new Error('topK 必须是正整数');
    }

    return indexedChunks
    .map(({chunk, embedding}) => ({
        chunk,
        score: cosineSimilarity(queryEmbedding, embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}