import { describe, it, expect } from 'vitest';
import { groupTurns } from './turns';
import type { ChatMessage, ContentBlock } from './chatWs';

const user = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }] });
const asst = (uuid: string, ...blocks: ContentBlock[]): ChatMessage => ({ uuid, role: 'assistant', blocks });
const toolRes = (uuid: string, id: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'tool_result', toolUseId: id, content: 'o' }] });

describe('groupTurns', () => {
  it('用户/助手交替 → 两回合', () => {
    const t = groupTurns([user('u1', 'hi'), asst('a1', { type: 'text', text: 'yo' })]);
    expect(t.map((x) => x.kind)).toEqual(['user', 'assistant']);
  });

  it('一轮多条助手 + 工具结果 → 单一助手回合,且 tool_result 不进 blocks', () => {
    const t = groupTurns([
      user('u1', 'do'),
      asst('a1', { type: 'text', text: 'step1' }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls' } }),
      toolRes('r1', 'b'),
      asst('a2', { type: 'text', text: 'done' }),
    ]);
    expect(t.map((x) => x.kind)).toEqual(['user', 'assistant']);
    const a = t[1];
    if (a.kind !== 'assistant') throw new Error('expected assistant turn');
    expect(a.blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);
  });

  it('并行 tool_use 同属一个助手回合', () => {
    const t = groupTurns([
      user('u1', 'go'),
      asst('a1', { type: 'tool_use', id: 'x', name: 'Read', input: {} }, { type: 'tool_use', id: 'y', name: 'Read', input: {} }),
    ]);
    const a = t[1];
    if (a.kind !== 'assistant') throw new Error('expected assistant turn');
    expect(a.blocks.filter((b) => b.type === 'tool_use')).toHaveLength(2);
  });

  it('tool_result-only 夹在两段助手之间仍是单个助手回合', () => {
    const t = groupTurns([user('u1', 'q'), asst('a1', { type: 'text', text: '1' }), toolRes('r', 't'), asst('a2', { type: 'text', text: '2' })]);
    expect(t.filter((x) => x.kind === 'assistant')).toHaveLength(1);
  });

  it('两条真实用户消息 → 两个用户回合', () => {
    const t = groupTurns([user('u1', 'a'), user('u2', 'b')]);
    expect(t.map((x) => x.kind)).toEqual(['user', 'user']);
  });

  it('AskUserQuestion 的 tool_use 留在助手回合(交前端特化渲染)', () => {
    const t = groupTurns([user('u1', '?'), asst('a1', { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [] } })]);
    const a = t[1];
    if (a.kind !== 'assistant') throw new Error('expected assistant turn');
    expect(a.blocks[0]).toMatchObject({ type: 'tool_use', name: 'AskUserQuestion' });
  });

  it('空输入 → 空回合', () => {
    expect(groupTurns([])).toEqual([]);
  });
});
