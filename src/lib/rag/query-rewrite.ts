import {generateText} from 'ai';

export interface RewriteMessage {
    role: 'user' | 'assistant';
    content: string;
}

// 服务端传给 Query Rewrite / LLM 的最大历史消息条数（最近 N 条）
export const MAX_HISTORY_MESSAGES = 10;

// 单条历史消息传给 Query Rewrite 的最大字符数，避免长回答撑爆 Prompt
const MAX_REWRITE_MESSAGE_CHARS = 1500;

/**
 * 只保留最近 N 条历史消息，不修改调用方传入的数组
 */
export function trimHistory<T extends RewriteMessage>(
    history: T[],
    maxMessages = MAX_HISTORY_MESSAGES,
): T[] {
    return history.slice(-maxMessages);
}

const QUERY_REWRITE_SYSTEM_PROMPT = `
你是一个知识库检索的查询改写助手。你只负责改写问题，不负责回答问题。

任务：
根据【历史对话】理解【当前问题】，输出一个可以直接用于知识库检索的独立问题。

步骤：
1. 判断当前问题是否依赖历史上下文。
   依赖历史的典型表达包括：指代词（它、它们、这个、那个、这些、上面、前面、刚才），
   序号引用（第二条、第二种、第三点），省略主语的追问（为什么会这样、还有其他方式吗、怎么解决、具体怎么用）。
2. 如果不依赖历史，原样输出当前问题。
3. 如果依赖历史，结合历史把指代、序号、省略的主语替换成具体对象，改写成完整、独立的问题。

规则：
1. 不要回答用户问题。
2. 不要改变用户的真实意图，不要扩大或缩小提问范围。
3. 不要添加历史对话中没有出现过的信息。
4. 不要把历史回答的大段内容复制到问题中，只提取需要的具体对象名称或一句简短概括。
5. 尽量保留原文中的技术名词，例如 React、useState、useReducer、useEffect、Promise、async/await。
6. 补全被省略的技术上下文，例如追问“依赖数组”时，应写明它属于哪个技术对象。
7. 只输出改写后的一句问题，纯文本，不要 Markdown、不要 JSON、不要引号、不要解释、不要“改写：”之类的前缀。

示例 1：
历史对话：
User: React 怎么管理组件状态？
Assistant: 可以使用 useState 和 useReducer。
当前问题：那它们有什么区别？
输出：useState 和 useReducer 有什么区别？

示例 2：
历史对话：
User: 前端有哪些常见的打包工具？
Assistant: 常见的有 Webpack、Vite 和 Rollup。
当前问题：第二种有什么优点？
输出：Vite 有什么优点？

示例 3：
历史对话：
User: React 怎么管理组件状态？
Assistant: 可以使用 useState 和 useReducer。
当前问题：Vue 的响应式系统是怎么工作的？
输出：Vue 的响应式系统是怎么工作的？
`.trim();

function formatHistory(history: RewriteMessage[]): string {
    return history
        .map(message => {
            const role = message.role === 'user' ? 'User' : 'Assistant';
            const content = message.content.length > MAX_REWRITE_MESSAGE_CHARS
                ? `${message.content.slice(0, MAX_REWRITE_MESSAGE_CHARS)}……`
                : message.content;

            return `${role}: ${content}`;
        })
        .join('\n');
}

/**
 * 清理模型输出：去掉可能出现的前缀、引号和多余行，只保留一句问题
 */
function normalizeRewrite(text: string): string {
    const firstLine = text
        .split('\n')
        .map(line => line.trim())
        .find(Boolean) ?? '';

    return firstLine
        .replace(/^(输出|改写|改写后的问题|Rewritten Query)\s*[:：]\s*/i, '')
        .replace(/^["'“”‘’「」`]+|["'“”‘’「」`]+$/g, '')
        .trim();
}

export async function rewriteQuery(
    query: string,
    history: RewriteMessage[] = [],
    model?: Parameters<typeof generateText>[0]['model']
): Promise<string> {
    // 没有历史或没有模型时无法基于上下文改写，原样返回
    if(!query.trim() || !history.length || !model) {
        return query;
    }

    const recentHistory = trimHistory(history);

    const result = await generateText({
        model,
        system: QUERY_REWRITE_SYSTEM_PROMPT,
        messages: [
            {
                role: 'user',
                content: `历史对话：\n${formatHistory(recentHistory)}\n\n当前问题：${query}`,
            },
        ],
    });

    return normalizeRewrite(result.text) || query;
}
