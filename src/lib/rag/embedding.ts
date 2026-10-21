export interface EmbeddingResult {
    embedding: number[];
    dimensions: number;
}

export interface EmbeddingProvider {
    embed(text: string): Promise<EmbeddingResult>;
    embedMany(texts: string[]): Promise<EmbeddingResult[]>;
}

interface EmbeddingResponse {
    data?: Array<{
        embedding: number[],
        index?: number;
    }>;
    error?: {
        message?: string;
        code?: string;
    }
}

const API_KEY = process.env.COMMON_API_KEY;

const EMBEDDING_URL = 'https://qianfan.baidubce.com/v2/embeddings';

export class AiEmbeddingProvider implements EmbeddingProvider {
    private apiKey: string;

    constructor(apiKey = API_KEY) {
        if(!apiKey) {
            throw new Error('缺少 API_KEY，请检查 .env.local');
        }

        this.apiKey = apiKey;
    }

    async embed(text: string): Promise<EmbeddingResult> {
        const results = await this.embedMany([text]);

        return results[0];
    }

    async embedMany(texts: string[]): Promise<EmbeddingResult[]> {
        if(!texts.length) {
            return [];
        }

        const response = await fetch(EMBEDDING_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: process.env.EMBEDDING_MODEL,
                input: texts,
            })
        })

        const data = (await response.json()) as EmbeddingResponse;

        if(!response.ok) {
            throw new Error(data.error?.message || `Embedding 请求失败：HTTP ${response.status}`)
        }

        if(!data.data?.length) {
            throw new Error('Embedding API 没有返回向量数据');
        }

        const sorted = [...data.data].sort((a,b) => (a.index ?? 0) - (b.index ?? 0));

        return sorted.map((item) => {
            if(!item.embedding?.length) {
                throw new Error('Embedding 返回了空向量')
            }
            return {
                embedding: item.embedding,
                dimensions: item.embedding.length
            }
        })
    }
}

export const embeddingProvider = new AiEmbeddingProvider();