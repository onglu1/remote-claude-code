import { describe, it, expect } from 'vitest';
import { turnSlices, buildHistorySnapshot, getTurnSlice } from './skeleton';
import type { ChatMessage } from './chatWs';

const u = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }] });
const a = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'text', text }] });
const aTool = (uuid: string, id: string): ChatMessage => ({
  uuid,
  role: 'assistant',
  blocks: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
});
const tr = (uuid: string, id: string): ChatMessage => ({
  uuid,
  role: 'user',
  blocks: [{ type: 'tool_result', toolUseId: id, content: 'ok' }],
});

describe('turnSlices', () => {
  it('空链 → []', () => expect(turnSlices([])).toEqual([]));

  it('工具回合保留 tool_result,turnId 取首条助手 uuid', () => {
    const chain = [u('u1', 'hi'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'done')];
    const s = turnSlices(chain);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ kind: 'user', message: chain[0] });
    expect(s[1].kind).toBe('assistant');
    if (s[1].kind === 'assistant') {
      expect(s[1].turnId).toBe('a1');
      expect(s[1].messages.map((m) => m.uuid)).toEqual(['a1', 'r1', 'a2']);
    }
  });
});

describe('buildHistorySnapshot', () => {
  it('多回合:用户全文 + 助手折叠,最后助手回合给 tail', () => {
    const chain = [u('u1', 'q1'), a('a1', 'r1'), u('u2', 'q2'), a('a2', 'r2-final')];
    const { items, live } = buildHistorySnapshot(chain, { running: false });
    expect(live).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(items[1]).toEqual({ kind: 'assistant', turnId: 'a1' }); // 旧回合无 tail
    if (items[3].kind === 'assistant') {
      expect(items[3].turnId).toBe('a2');
      expect(items[3].tail?.text).toBe('r2-final');
      expect(items[3].tail?.truncated).toBe(false);
    }
  });

  it('tail 超长则截断末尾', () => {
    const long = 'x'.repeat(5000);
    const { items } = buildHistorySnapshot([u('u1', 'q'), a('a1', long)], { running: false, tailChars: 100 });
    const it = items[1];
    expect(it.kind).toBe('assistant');
    if (it.kind === 'assistant') {
      expect(it.tail?.truncated).toBe(true);
      expect(it.tail?.text.length).toBe(100);
      expect(long.endsWith(it.tail!.text)).toBe(true);
    }
  });

  it('running:进行中助手回合剥离到 live、不进骨架', () => {
    const chain = [u('u1', 'q1'), a('a1', 'r1'), u('u2', 'q2'), a('a2', 'streaming…')];
    const { items, live } = buildHistorySnapshot(chain, { running: true });
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user']);
    expect(live.map((m) => m.uuid)).toEqual(['a2']);
  });

  it('含工具的最后回合:tail.truncated=true(有非文本块可展开)', () => {
    const chain = [u('u1', 'q'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'short')];
    const { items } = buildHistorySnapshot(chain, { running: false });
    const last = items[1];
    if (last.kind === 'assistant') expect(last.tail?.truncated).toBe(true);
  });

  it('空链 → 空骨架', () => {
    expect(buildHistorySnapshot([], { running: false })).toEqual({ items: [], live: [] });
  });
});

describe('getTurnSlice', () => {
  it('命中返回完整切片,未命中 null', () => {
    const chain = [u('u1', 'q'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'done')];
    expect(getTurnSlice(chain, 'a1')?.map((m) => m.uuid)).toEqual(['a1', 'r1', 'a2']);
    expect(getTurnSlice(chain, 'nope')).toBeNull();
  });
});
