import fs from 'node:fs/promises';
import path from 'node:path';

export interface KnowledgeDocument {
    id: string;
    fileName: string;
    fileSize: number;
    characterCount: number;
    chunkCount: number;
    createdAt: string;
    updatedAt: string;
}

interface DocumentStore {
    documents: KnowledgeDocument[];
}

const DATA_DIR = path.join(process.cwd(), 'data');

const STORE_FILE = path.join(DATA_DIR, 'document.json');

async function ensureStore() {
    await fs.mkdir(DATA_DIR, {recursive: true});

    try {
        await fs.access(STORE_FILE);
    } catch {
        await fs.writeFile(
            STORE_FILE,
            JSON.stringify({documents: []}, null, 2),
            'utf-8',
        );
    }
}

async function readStore(): Promise<DocumentStore> {
    await ensureStore();

    const content = await fs.readFile(STORE_FILE, 'utf-8');

    return JSON.parse(content) as DocumentStore;
} 

async function writeStore(store: DocumentStore) {
    await ensureStore();

    await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

export async function addDocument(document: KnowledgeDocument) {
    const store = await readStore();

    store.documents.push(document);

    await writeStore(store);

    return document;
}

export async function getDocuments() {
    const store = await readStore();

    return store.documents;
}

export async function getDocument(documentId: string) {
    const documents = await getDocuments();

    return documents.find(d => d.id === documentId);
}

export async function deleteDocument(documentId: string) {
    const store = await readStore();

    store.documents = store.documents.filter(d => d.id !== documentId);

    await writeStore(store);
}