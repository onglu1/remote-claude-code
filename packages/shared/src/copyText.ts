import type { ChatMessage, ContentBlock } from './chatWs';

function joinText(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function copyableTextFromBlocks(blocks: ContentBlock[]): string {
  return joinText(blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])));
}

export function copyableTextFromMessage(message: ChatMessage): string {
  return copyableTextFromBlocks(message.blocks);
}
