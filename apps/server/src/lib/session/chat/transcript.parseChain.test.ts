import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeChain } from './transcript';

describe('parseClaudeChain', () => {
  it('从真实 fixture 解出主线 user/assistant 文本', () => {
    const fixturePath = join(__dirname, '__fixtures__', 'transcript_tool_round.jsonl');
    if (!existsSync(fixturePath)) {
      // fixture 缺失不算 fail(可能是测试环境无 fixture);用合成 jsonl 跑通
      const synth = [
        JSON.stringify({
          uuid: 'u1', parentUuid: null, type: 'user', timestamp: 't1',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        }),
        JSON.stringify({
          uuid: 'a1', parentUuid: 'u1', type: 'assistant', timestamp: 't2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      ].join('\n');
      const chain = parseClaudeChain(synth);
      expect(chain).toEqual([
        { role: 'user', ts: 't1', content: 'hi' },
        { role: 'assistant', ts: 't2', content: 'hello' },
      ]);
      return;
    }
    const text = readFileSync(fixturePath, 'utf8');
    const chain = parseClaudeChain(text);
    expect(chain.some((m) => m.role === 'user')).toBe(true);
    expect(chain.some((m) => m.role === 'assistant')).toBe(true);
    for (const m of chain) {
      expect(typeof m.ts).toBe('string');
      expect(typeof m.content).toBe('string');
      expect(m.content.length).toBeGreaterThan(0);
    }
  });

  it('tool_result 行(role:user 但 blocks 是 tool_result)不出现在结果里', () => {
    const text = [
      JSON.stringify({
        uuid: 'u1', parentUuid: null, type: 'user', timestamp: 't1',
        message: { role: 'user', content: [{ type: 'text', text: '帮我跑 ls' }] },
      }),
      JSON.stringify({
        uuid: 'a1', parentUuid: 'u1', type: 'assistant', timestamp: 't2',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      }),
      JSON.stringify({
        uuid: 'r1', parentUuid: 'a1', type: 'user', timestamp: 't3', toolUseResult: { x: 1 },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README' }] },
      }),
      JSON.stringify({
        uuid: 'a2', parentUuid: 'r1', type: 'assistant', timestamp: 't4',
        message: { role: 'assistant', content: [{ type: 'text', text: '看到 README' }] },
      }),
    ].join('\n');
    const chain = parseClaudeChain(text);
    // 期望:user 文本 'hi'、assistant 'looking' — tool_use/tool_result 全跳过
    expect(chain).toEqual([
      { role: 'user', ts: 't1', content: '帮我跑 ls' },
      { role: 'assistant', ts: 't4', content: '看到 README' },
    ]);
  });

  it('空文本 → 空数组', () => {
    expect(parseClaudeChain('')).toEqual([]);
  });

  it('坏 JSON 跳过,不抛', () => {
    expect(parseClaudeChain('{not json\n')).toEqual([]);
  });

  it('sidechain 节点(子代理)不进主线', () => {
    const text = [
      JSON.stringify({
        uuid: 'u1', parentUuid: null, type: 'user', timestamp: 't1',
        message: { role: 'user', content: [{ type: 'text', text: 'main' }] },
      }),
      JSON.stringify({
        uuid: 's1', parentUuid: 'u1', type: 'user', timestamp: 't2', isSidechain: true,
        message: { role: 'user', content: [{ type: 'text', text: '子代理内部' }] },
      }),
    ].join('\n');
    const chain = parseClaudeChain(text);
    expect(chain).toEqual([{ role: 'user', ts: 't1', content: 'main' }]);
  });
});
