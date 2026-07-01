import { describe, it, expect } from 'vitest';
import { ChatSession, type TmuxLike } from './chatSession';
import type { AgentAdapter } from './agent/adapter';
import type { ChatMessage } from '@rcc/shared';

function fakeAdapter(): AgentAdapter {
  return {
    kind: 'claude',
    capabilities: { effort: true, askHook: false, hud: false, rewind: true, presetSessionId: true, paneRunningSignal: true },
    buildLaunchCmd: () => 'noop',
    buildResumeCmd: () => 'noop',
    locateTranscript: () => null,
    makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {} }),
    discoverSessionId: async () => null,
    parseToolUseEvents: () => [],
    parseTranscriptText: () => [],
  };
}

function fakeTmux(): TmuxLike {
  return {
    hasSession: async () => true,
    newDetached: async () => {},
    sendKeys: async () => {},
    sendLiteralKeys: async () => {},
    pasteText: async () => {},
    capturePaneVisible: async () => '',
  };
}

describe('ChatSession sessionIndex inline push', () => {
  it('ensure() 后,新主线消息走 onMessage,tool_use 块跳过,不重复推送', async () => {
    const calls: Array<{ key: string; idx: number; role: string; content: string }> = [];
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: '你好' }], ts: 't1' },
      { uuid: 'a1', role: 'assistant', blocks: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },  // 跳过 inline 推送
      { uuid: 'a2', role: 'assistant', blocks: [{ type: 'text', text: '在' }], ts: 't2' },
    ];
    const tail = { activeChain: () => messages, reset: () => {} };
    const session = new ChatSession(
      {
        tmuxName: 't', cwd: '/tmp', launchCommand: 'echo', sessionId: 'sid',
        cols: 80, rows: 24, agentKind: 'claude',
        projectId: 'p1', convId: 'c1',
      },
      {
        tmux: fakeTmux(),
        scrape: () => ({ preview: '', running: false }) as never,
        tail,
        adapter: fakeAdapter(),
        hasTranscript: () => false,
        sessionIndex: {
          onMessage: (k, m) => calls.push({ key: k, idx: m.msgIndex, role: m.role, content: m.content }),
        },
      },
      {
        onMessage: () => {}, onHistory: () => {}, onPreview: () => {}, onTurnState: () => {},
        onAskState: () => {}, onAskPending: () => {}, onAskPendingClear: () => {}, onAskPendingFailed: () => {}, onHud: () => {},
      },
    );
    await session.ensure();
    expect(calls).toEqual([
      { key: 'p1:c1', idx: 0, role: 'user', content: '你好' },
      // idx 1 = tool_use 块,无文本 → 跳过推送但 lastIndexedMsgIndex 前进
      { key: 'p1:c1', idx: 2, role: 'assistant', content: '在' },
    ]);
    // 第二次 ensure 不应重复推送(lastIndexedMsgIndex 已记到 2)
    calls.length = 0;
    await session.ensure();
    expect(calls).toEqual([]);
  });

  it('未注入 sessionIndex 时静默 noop(行为零变化)', async () => {
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], ts: 't1' },
    ];
    const tail = { activeChain: () => messages, reset: () => {} };
    const session = new ChatSession(
      {
        tmuxName: 't', cwd: '/tmp', launchCommand: 'echo', sessionId: 'sid',
        cols: 80, rows: 24, agentKind: 'claude',
        projectId: 'p1', convId: 'c1',
      },
      {
        tmux: fakeTmux(),
        scrape: () => ({ preview: '', running: false }) as never,
        tail,
        adapter: fakeAdapter(),
        hasTranscript: () => false,
        // 不注入 sessionIndex
      },
      {
        onMessage: () => {}, onHistory: () => {}, onPreview: () => {}, onTurnState: () => {},
        onAskState: () => {}, onAskPending: () => {}, onAskPendingClear: () => {}, onAskPendingFailed: () => {}, onHud: () => {},
      },
    );
    await expect(session.ensure()).resolves.toBeUndefined();
  });

  it('spec 缺 projectId/convId → 不推送', async () => {
    const calls: number[] = [];
    const messages: ChatMessage[] = [
      { uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], ts: 't1' },
    ];
    const tail = { activeChain: () => messages, reset: () => {} };
    const session = new ChatSession(
      {
        tmuxName: 't', cwd: '/tmp', launchCommand: 'echo', sessionId: 'sid',
        cols: 80, rows: 24, agentKind: 'claude',
        // 缺 projectId/convId
      },
      {
        tmux: fakeTmux(),
        scrape: () => ({ preview: '', running: false }) as never,
        tail,
        adapter: fakeAdapter(),
        hasTranscript: () => false,
        sessionIndex: { onMessage: () => calls.push(1) },
      },
      {
        onMessage: () => {}, onHistory: () => {}, onPreview: () => {}, onTurnState: () => {},
        onAskState: () => {}, onAskPending: () => {}, onAskPendingClear: () => {}, onAskPendingFailed: () => {}, onHud: () => {},
      },
    );
    await session.ensure();
    expect(calls).toEqual([]);
  });
});
