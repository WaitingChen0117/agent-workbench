import {splitText, type TextChunk} from '@/lib/rag/chunk';

export type SupportedFileType = 'text/plain' | 'text/markdown';

export interface ParsedDocument {
    fileName: string;
    fileType: SupportedFileType;
    fileSize: number;
    content: string;
    chunks: TextChunk[];
}

export interface ParseOptions {
    chunkSize?: number;
    overlap?: number;
}

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = ['.txt', '.md'];

function getExtension(fileName: string): string {
    const index = fileName.lastIndexOf('.');
    return index >= 0 ? fileName.slice(index).toLowerCase() : '';
}

export async function parseDocument(file: File, options: ParseOptions): Promise<ParsedDocument> {
    if(!(file instanceof File)) {
        throw new Error('请上传有效文件');
    }

    if(file.size === 0) {
        throw new Error('文件内容不能为空');
    }

    if(file.size > MAX_FILE_SIZE) {
        throw new Error('文件不能超过 5MB');
    }

    const extension = getExtension(file.name);

    if(!SUPPORTED_EXTENSIONS.includes(extension)) {
        throw new Error('目前只支持 .txt 和 .md 格式的文件');
    }

    const content = (await file.text()).trim();

    if(!content) {
        throw new Error('文件中没有可读取的文本内容');
    }

    const fileType: SupportedFileType = extension === '.md' ? 'text/markdown': 'text/plain';

    const chunks = splitText(content, options);

    return {
        fileName: file.name,
        fileType,
        fileSize: file.size,
        content,
        chunks,
    }
}