import type {UIMessage} from 'ai';

export function getMessageText(message: UIMessage): string {
    return message.parts
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('');
}