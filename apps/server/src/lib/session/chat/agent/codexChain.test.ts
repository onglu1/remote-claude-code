import { describe, it, expect } from 'vitest';
import { parseCodexChain } from './codexTranscript';

describe('parseCodexChain', () => {
  it('从 response_item message 解出 user/assistant 文本', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-06-29T00:00:01Z', type: 'session_meta', payload: {} }),
      JSON.stringify({
        timestamp: '2026-06-29T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '你好' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-29T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '在' }],
        },
      }),
      // event_msg / agent_message 是 response_item 镜像,不应再出现
      JSON.stringify({
        timestamp: '2026-06-29T00:00:04Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: '在' },
      }),
    ].join('\n');
    const chain = parseCodexChain(text);
    expect(chain).toEqual([
      { role: 'user', ts: '2026-06-29T00:00:02Z', content: '你好' },
      { role: 'assistant', ts: '2026-06-29T00:00:03Z', content: '在' },
    ]);
  });

  it('function_call/function_call_output 不出现在结果里(只要主线文本)', () => {
    const text = [
      JSON.stringify({
        timestamp: '2026-06-29T00:00:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
      }),
      JSON.stringify({
        timestamp: '2026-06-29T00:00:02Z',
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
      }),
      JSON.stringify({
        timestamp: '2026-06-29T00:00:03Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'README.md' },
      }),
    ].join('\n');
    const chain = parseCodexChain(text);
    expect(chain).toEqual([{ role: 'user', ts: '2026-06-29T00:00:01Z', content: 'run ls' }]);
  });

  it('developer/system 角色不出现(只要 user/assistant)', () => {
    const text = [
      JSON.stringify({
        timestamp: 't', type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '内部指令' }] },
      }),
      JSON.stringify({
        timestamp: 't', type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      }),
    ].join('\n');
    expect(parseCodexChain(text)).toEqual([{ role: 'user', ts: 't', content: 'hi' }]);
  });

  it('空文本 / 坏 JSON → 空数组', () => {
    expect(parseCodexChain('')).toEqual([]);
    expect(parseCodexChain('{bad\n{not json\n')).toEqual([]);
  });
});
