import { retrieveChunks } from "@/lib/rag/retriever";
import type { IndexedChunk } from "@/lib/rag/retriever";

const indexedChunks: IndexedChunk[] = [
    {
        chunk: {
        id: '1',
        content: 'React 使用组件构建用户界面。',
        index: 0,
        start: 0,
        end: 20,
        },
        embedding: [0.9, 0.1, 0.2],
    },
    {
        chunk: {
        id: '2',
        content: 'useState 可以在函数组件中管理状态。',
        index: 1,
        start: 20,
        end: 50,
        },
        embedding: [0.8, 0.2, 0.1],
    },
    {
        chunk: {
        id: '3',
        content: 'CSS Grid 可以实现二维布局。',
        index: 2,
        start: 50,
        end: 80,
        },
        embedding: [-0.8, 0.7, 0.1],
    },
];

const results = retrieveChunks(
    [0.85, 0.15, 0.2],
    indexedChunks,
    2
);

console.log(results);