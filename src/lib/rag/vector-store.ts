import fs from 'node:fs/promises';
import path from 'node:path';

import type {IndexedChunk} from '@/lib/rag/retriever';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'knowledge.json');

export interface StoredChunk extends IndexedChunk {
    documentId: string;
    fileName: string;
}

interface KnowledgeStore {
    chunks: StoredChunk[];
}

async function ensureStore() {
    await fs.mkdir(DATA_DIR, {recursive: true});

    try {
        await fs.access(STORE_FILE);
    } catch {
        const initialStore: KnowledgeStore = {
            chunks: []
        }

        await fs.writeFile(
            STORE_FILE,
            JSON.stringify(initialStore, null, 2),
            'utf-8',
        )
    }
}

async function readStore(): Promise<KnowledgeStore> {
    await ensureStore();

    const content = await fs.readFile(STORE_FILE, 'utf-8');

    return JSON.parse(content) as KnowledgeStore;
}

async function writeStore(store: KnowledgeStore) {
    await ensureStore();

    await fs.writeFile(
        STORE_FILE,
        JSON.stringify(store, null, 2),
        'utf-8',
    )
}

export async function addDocumentChunks(
    documentId: string,
    fileName: string,
    chunks: IndexedChunk[],
) {
    const store = await readStore();

    const storedChunks: StoredChunk[] = chunks.map(item => ({
        ...item,
        documentId,
        fileName,
    }));

    store.chunks.push(...storedChunks);
    
    await writeStore(store);

    return storedChunks;
}

export async function getAllChunks() {
    const store = await readStore();

    return store.chunks;
}

export async function deleteDocument(documentId: string) {
    const store = await readStore();

    store.chunks = store.chunks.filter(chunk => chunk.documentId !== documentId);

    await writeStore(store);
}