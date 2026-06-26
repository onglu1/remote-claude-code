import { describe, expect, it } from 'vitest';
import type { ChatMessage, ContentBlock } from './chatWs';
import { copyableTextFromBlocks, copyableTextFromMessage } from './copyText';

describe('copyableText', () => {
  it('用户消息只复制文本块', () => {
    const message: ChatMessage = {
      uuid: 'u1',
      role: 'user',
      blocks: [
        { type: 'text', text: '  hello  ' },
        { type: 'image', alt: 'screenshot.png' },
        { type: 'text', text: 'world' },
      ],
    };

    expect(copyableTextFromMessage(message)).toBe('hello\n\nworld');
  });

  it('助手回复排除工具调用、工具结果、思考和图片', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: 'internal reasoning' },
      { type: 'text', text: '第一段' },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } },
      { type: 'tool_result', toolUseId: 'b1', content: 'deleted' },
      { type: 'image', alt: 'chart' },
      { type: 'text', text: '第二段' },
    ];

    expect(copyableTextFromBlocks(blocks)).toBe('第一段\n\n第二段');
  });

  it('没有文本块时返回空字符串', () => {
    expect(
      copyableTextFromBlocks([
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } },
        { type: 'image', alt: 'a.png' },
      ]),
    ).toBe('');
  });
});
