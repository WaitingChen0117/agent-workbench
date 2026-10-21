export interface TextChunk {
    id: string;
    content: string;
    index: number;
    start: number;
    end: number;
}

export interface ChunkOptions {
    chunkSize?: number;
    overlap?: number;
}

export function splitText(text: string, options: ChunkOptions = {}): TextChunk[] {
    const chunkSize = options.chunkSize ?? 500;
    const overlap = options.overlap ?? 100;

    if (chunkSize <= 0) {
        throw new Error('chunkSize must be greater than 0');
    }

    if (overlap < 0 || overlap >= chunkSize) {
        throw new Error('overlap must be between 0 and chunkSize');
    }

    const normalizedText = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();

    if (!normalizedText) {
        return [];
    }
    
    const chunks: TextChunk[] = [];
    let start = 0;

    while (start < normalizedText.length) {
        let end = Math.min(start + chunkSize, normalizedText.length);

        if (end < normalizedText.length) {
            const searchStart = start + Math.floor(chunkSize * 0.6);
            const candidate = normalizedText.slice(searchStart, end);

            const paragraphBreak = candidate.lastIndexOf('\n\n');
            const lineBreak = candidate.lastIndexOf('\n');
            const sentenceBreak = Math.max(
                candidate.lastIndexOf('。'),
                candidate.lastIndexOf('！'),
                candidate.lastIndexOf('？'),
                candidate.lastIndexOf('；'),
            )

            let boundary = -1;
            let boundaryLength = 0;

            if (paragraphBreak >= 0) {
                boundary = searchStart + paragraphBreak;
                boundaryLength = 2;
            } else if (sentenceBreak >= 0) {
                boundary = searchStart + sentenceBreak;
                boundaryLength = 1;
            } else if (lineBreak >= 0) {
                boundary = searchStart + lineBreak;
                boundaryLength = 1;
            }

            if (boundary > start) {
                end = boundary + boundaryLength;
            }
        }

        const content = normalizedText.slice(start, end).trim();


        if (content) {
            chunks.push({
                id: crypto.randomUUID(),
                content,
                index: chunks.length,
                start,
                end
            })
        }

        if (end >= normalizedText.length) {
            break;
        }

        start = end - overlap;
    }

    return chunks;
}