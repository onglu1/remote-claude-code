import { describe, it, expect } from 'vitest';
import { parseTranscriptForIndex } from './parser';
import type { AgentAdapter } from '../session/chat/agent/adapter';

function fakeAdapter(
  messages: Array<{ role: 'user' | 'assistant'; ts: string; content: string }>,
): AgentAdapter {
  return {
    kind: 'claude',
    capabilities: { effort: true, askHook: true, hud: true, rewind: true, presetSessionId: true, paneRunningSignal: true },
    buildLaunchCmd: () => 'noop',
    buildResumeCmd: () => 'noop',
    locateTranscript: () => null,
    makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {} }),
    discoverSessionId: async () => null,
    parseToolUseEvents: () => [],
    parseTranscriptText: () => messages,
  };
}

describe('parseTranscriptForIndex', () => {
  it('转换为 IndexedMessage[](带 sessionKey + msgIndex)', () => {
    const adapter = fakeAdapter([
      { role: 'user', ts: 't1', content: 'hi' },
      { role: 'assistant', ts: 't2', content: 'hello' },
    ]);
    const out = parseTranscriptForIndex('p1:c1', adapter, 'session-uuid', 'jsonl text');
    expect(out).toEqual([
      { sessionKey: 'p1:c1', msgIndex: 0, role: 'user', ts: 't1', content: 'hi' },
      { sessionKey: 'p1:c1', msgIndex: 1, role: 'assistant', ts: 't2', content: 'hello' },
    ]);
  });

  it('空 chain → 空数组', () => {
    const adapter = fakeAdapter([]);
    expect(parseTranscriptForIndex('p1:c1', adapter, 'sid', '')).toEqual([]);
  });
});
