import {buildRagContext} from '@/lib/rag/context';
import type {VectorSearchResult} from '@/lib/rag/vector-search';

export function buildRagPrompt(results: VectorSearchResult[]): string {
    const context = buildRagContext(results);

    return `
        你是一个知识库问答助手。

        请严格遵守一下规则：

        1. 优先根据【知识库内容】回答用户问题。
        2. 如果知识库中没有足够的信息，请明确告诉用户“知识库中没有找到足够的信息”。
        3. 不要为了回答问题而编造知识库中不存在的内容。
        4. 可以结合你的通用知识进行补充，但必须明确区分。
        5. 回答尽量简洁、准确。
        6. 如果使用了知识库内容，请在对应观点后标注来源文件名。

        【知识库内容】

        ${context}
    `.trim();
}