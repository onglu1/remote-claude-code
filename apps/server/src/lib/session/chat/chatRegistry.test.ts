import { describe, it, expect, vi } from 'vitest';
import { ChatRegistry, type ChatSessionLike, type ChatSubscriber } from './chatRegistry';
import type { ChatSpec, ChatSessionEvents } from './chatSession';
import { buildHistorySnapshot, getTurnSlice } from '@rcc/shared';
import type { AskPending, ChatMessage, Hud } from '@rcc/shared';

const spec: ChatSpec = {
  tmuxName: 'rcc-p-c',
  cwd: '/proj',
  launchCommand: 'Fable-yolo',
  sessionId: 'u-1',
  cols: 120,
  rows: 40,
};

function fakeSession(messages: ChatMessage[] = [], liveAsk: AskPending | null = null, liveHud: Hud | null = null) {
  let captured: ChatSessionEvents | null = null;
  const session: ChatSessionLike = {
    ensure: vi.fn(async () => {}),
    getSkeleton: () => buildHistorySnapshot(messages),
    getTurnBody: (turnId: string) => getTurnSlice(messages, turnId),
    sendText: vi.fn(async () => {}),
    sendKey: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    capturePeek: vi.fn(async () => 'PANE'),
    setEffort: vi.fn(async () => {}),
    rewindOpen: vi.fn(async () => [{ index: 0, label: 'p', changes: 'x' }]),
    rewindExecute: vi.fn(async () => ({ ok: true })),
    rewindCancel: vi.fn(async () => {}),
    answerAsk: vi.fn(async () => {}),
    answerPendingAsk: vi.fn(async () => {}),
    getLiveAsk: () => liveAsk,
    getLiveHud: () => liveHud,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
  };
  const factory = (_spec: ChatSpec, events: ChatSessionEvents) => {
    captured = events;
    return session;
  };
  return { session, factory, emit: () => captured! };
}

function sub(): ChatSubscriber & { calls: any } {
  const calls = {
    history: [] as any[],
    message: [] as any[],
    preview: [] as any[],
    turn: [] as any[],
    ask: [] as any[],
    askPending: [] as any[],
    askPendingClear: 0,
    askPendingFailed: [] as any[],
    hud: [] as any[],
  };
  return {
    calls,
    onHistory: (m) => calls.history.push(m),
    onMessage: (m) => calls.message.push(m),
    onPreview: (t) => calls.preview.push(t),
    onTurnState: (r) => calls.turn.push(r),
    onAskState: (s) => calls.ask.push(s),
    onAskPending: (a) => calls.askPending.push(a),
    onAskPendingClear: () => {
      calls.askPendingClear += 1;
    },
    onAskPendingFailed: (e) => calls.askPendingFailed.push(e),
    onHud: (h) => calls.hud.push(h),
  };
}

describe('ChatRegistry', () => {
  it('首个订阅创建会话并 ensure+startPolling，第二个复用', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    await reg.subscribe('c', spec, sub());
    await reg.subscribe('c', spec, sub());
    expect(fs.session.ensure).toHaveBeenCalledTimes(1);
    expect(fs.session.startPolling).toHaveBeenCalledTimes(1);
    expect(reg.activeCount()).toBe(1);
  });

  it('订阅即收到历史骨架快照', async () => {
    const hist: ChatMessage[] = [{ uuid: 'm', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }];
    const fs = fakeSession(hist);
    const reg = new ChatRegistry(fs.factory);
    const s = sub();
    await reg.subscribe('c', spec, s);
    expect(s.calls.history[0]).toEqual({ items: [{ kind: 'user', message: hist[0] }], live: [] });
  });

  it('转发 load_turn 到会话取回合正文', async () => {
    const chain: ChatMessage[] = [
      { uuid: 'u', role: 'user', blocks: [{ type: 'text', text: 'q' }] },
      { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'r' }] },
    ];
    const fs = fakeSession(chain);
    const reg = new ChatRegistry(fs.factory);
    const h = await reg.subscribe('c', spec, sub());
    expect(h.loadTurn('a1')?.map((m) => m.uuid)).toEqual(['a1']);
    expect(h.loadTurn('nope')).toBeNull();
  });

  it('事件广播给所有订阅者', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const a = sub();
    const b = sub();
    await reg.subscribe('c', spec, a);
    await reg.subscribe('c', spec, b);
    const m: ChatMessage = { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'x' }] };
    fs.emit().onMessage(m);
    fs.emit().onPreview('p');
    fs.emit().onTurnState(true);
    expect(a.calls.message[0]).toEqual(m);
    expect(b.calls.message[0]).toEqual(m);
    expect(a.calls.preview[0]).toBe('p');
    expect(b.calls.turn[0]).toBe(true);
  });

  it('路由输入到会话', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const h = await reg.subscribe('c', spec, sub());
    await h.sendText('hi');
    await h.sendKey('esc');
    await h.interrupt();
    expect(fs.session.sendText).toHaveBeenCalledWith('hi');
    expect(fs.session.sendKey).toHaveBeenCalledWith('esc');
    expect(fs.session.interrupt).toHaveBeenCalledTimes(1);
  });

  it('转发 setEffort 到会话', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const h = await reg.subscribe('c', spec, sub());
    await h.setEffort('high');
    expect(fs.session.setEffort).toHaveBeenCalledWith('high');
  });

  it('转发 rewind open/execute/cancel 到会话', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const h = await reg.subscribe('c', spec, sub());
    expect(await h.rewindOpen()).toEqual([{ index: 0, label: 'p', changes: 'x' }]);
    await h.rewindExecute(2, 'conversation');
    await h.rewindCancel();
    expect(fs.session.rewindExecute).toHaveBeenCalledWith(2, 'conversation');
    expect(fs.session.rewindCancel).toHaveBeenCalledTimes(1);
  });

  it('转发 ask_answer 到会话,并广播 ask_state 给订阅者', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const a = sub();
    const h = await reg.subscribe('c', spec, a);
    await h.answerAsk('t1', [{ questionIndex: 0, optionIndices: [1] }]);
    expect(fs.session.answerAsk).toHaveBeenCalledWith('t1', [{ questionIndex: 0, optionIndices: [1] }]);
    fs.emit().onAskState({ toolUseId: 't1', status: 'driving' });
    expect(a.calls.ask[0]).toEqual({ toolUseId: 't1', status: 'driving' });
  });

  it('订阅时若会话有待答态 → 补发 onAskPending(待答态不在 transcript 历史里)', async () => {
    const live: AskPending = { options: [{ index: 0, label: 'Apple' }], multiSelect: false };
    const fs = fakeSession([], live);
    const reg = new ChatRegistry(fs.factory);
    const s = sub();
    await reg.subscribe('c', spec, s);
    expect(s.calls.askPending[0]).toEqual(live);
  });

  it('转发 ask_pending_answer 到会话,并广播 ask_pending/clear/failed 给订阅者', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const a = sub();
    const h = await reg.subscribe('c', spec, a);
    await h.answerPendingAsk([1]);
    expect(fs.session.answerPendingAsk).toHaveBeenCalledWith([1]);
    const live: AskPending = { options: [{ index: 0, label: 'X' }], multiSelect: false };
    fs.emit().onAskPending(live);
    fs.emit().onAskPendingClear();
    fs.emit().onAskPendingFailed('e');
    expect(a.calls.askPending[0]).toEqual(live);
    expect(a.calls.askPendingClear).toBe(1);
    expect(a.calls.askPendingFailed[0]).toBe('e');
  });

  it('onHud 扇出给所有订阅者', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const a = sub();
    const b = sub();
    await reg.subscribe('c', spec, a);
    await reg.subscribe('c', spec, b);
    const hud: Hud = { model: 'claude-opus-4-8', contextPct: 19, raw: '[claude-opus-4-8] 19%' };
    fs.emit().onHud(hud);
    expect(a.calls.hud[0]).toEqual(hud);
    expect(b.calls.hud[0]).toEqual(hud);
  });

  it('订阅时若会话有 HUD → 立即补发(HUD 是当前态、不在 transcript 里)', async () => {
    const hud: Hud = { model: 'claude-opus-4-8', contextPct: 33, raw: '[claude-opus-4-8] 33%' };
    const fs = fakeSession([], null, hud);
    const reg = new ChatRegistry(fs.factory);
    const s = sub();
    await reg.subscribe('c', spec, s);
    expect(s.calls.hud[0]).toEqual(hud);
  });

  it('resync 补发 HUD', async () => {
    const hud: Hud = { model: 'claude-opus-4-8', contextPct: 7, raw: '[claude-opus-4-8] 7%' };
    const fs = fakeSession([], null, hud);
    const reg = new ChatRegistry(fs.factory);
    const s = sub();
    const h = await reg.subscribe('c', spec, s);
    s.calls.hud.length = 0; // 清掉订阅时的首发,只看 resync
    h.resync();
    expect(s.calls.hud[0]).toEqual(hud);
  });

  it('最后一个订阅者离开时停轮询（不杀 tmux）', async () => {
    const fs = fakeSession();
    const reg = new ChatRegistry(fs.factory);
    const h1 = await reg.subscribe('c', spec, sub());
    const h2 = await reg.subscribe('c', spec, sub());
    h1.unsubscribe();
    expect(fs.session.stopPolling).not.toHaveBeenCalled();
    h2.unsubscribe();
    expect(fs.session.stopPolling).toHaveBeenCalledTimes(1);
    expect(reg.isActive('c')).toBe(false);
  });
});
