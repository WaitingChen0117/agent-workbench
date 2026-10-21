import type { VectorSearchResult } from "@/lib/rag/vector-search";

export function buildRagContext(results: VectorSearchResult[]): string {
    if(!results.length) {
        return '知识库中没有找到与当前问题相关的内容。';
    }

    return results.map((result, index) => {
        return [
            `【知识片段 ${index + 1}】`,
            `来源：${result.score.toFixed(4)}`,
            `相关度：${result.score.toFixed(4)}`,
            '',
            result.chunk.chunk.content,
        ].join('\n');
    }).join('\n\n---\n\n');
}