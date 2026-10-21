import { cosineSimilarity } from '@/lib/rag/similarity';
import {getAllChunks, type StoredChunk} from '@/lib/rag/vector-store';

export interface VectorSearchResult {
    chunk: StoredChunk;
    score: number;
}

export async function searchVectors (
    queryEmbedding: number[], 
    topK = 3,
    minScore = 0,
): Promise<VectorSearchResult[]> {
    const chunks = await getAllChunks();

    if(!chunks.length) {
        return []
    }

    return chunks
    .map(chunk => ({
        chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .filter(item => item.score >= minScore)
    .slice(0, topK);
}