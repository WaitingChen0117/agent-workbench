export function cosineSimilarity(
    a: number[],
    b: number[],
): number {
    if(a.length !== b.length) {
        throw new Error('两个向量的维度必须一致');
    }

    if(a.length === 0) {
        throw new Error('向量不能为空');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for(let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] ** 2;
        normB += b[i] ** 2;
    }

    if(normA === 0 || normB === 0) {
        throw new Error('零向量无法计算余弦相似度');
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}