import { createOpenAI } from "@ai-sdk/openai";

const apiKey = process.env.AI_API_KEY;
const baseURL = process.env.AI_BASE_URL;
const modelName = process.env.AI_MODEL;

if(!apiKey) {
    throw new Error('Missing AI_API_KEY');
}

if (!baseURL) {
    throw new Error('Missing AI_BASE_URL');
}

if (!modelName) {
    throw new Error('Missing AI_MODEL');
}

export const aiProvider = createOpenAI({
    apiKey,
    baseURL,
});

export const aiModel = aiProvider.chat(
    modelName || '请替换为实际模型名称'
)