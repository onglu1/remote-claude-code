import { describe, it, expect, vi } from 'vitest';
import { ChatSession, type ChatSpec, type TmuxLike, type TranscriptLike } from './chatSession';
import { scrapePane } from './paneScraper';
import type { AskHookPending } from './askSidecar';
import type { ChatMessage } from '@rcc/shared';
import type { AgentAdapter } from './agent/adapter';

const spec: ChatSpec = {
  tmuxName: 'rcc-p-c',
  cwd: '/proj',
  launchCommand: 'Fable-yolo',
  sessionId: 'u-123',
  cols: 120,
  rows: 40,
  agentKind: 'claude',
};

/**
 * fake claude adapter:capabilities 全开,buildLaunchCmd/buildResumeCmd 复刻 buildClaudeCmd
 * 的输出格式(`<launchCommand> --effort <e> --session-id/--resume <sid>` + 可选 askLaunch
 * env/settings)。既有 50+ claude 测试经此 helper 注入,断言命令字符串照旧成立 → claude 行为零变化。
 */
function makeFakeClaudeAdapter(): AgentAdapter {
  const effortFlag = (e?: string) => `--effort ${e ?? 'max'}`;
  const wrap = (o: { launchCommand: string; sessionId: string; effort?: string; askLaunch?: { envExport: string; settingsArg: string } }, idFlag: string) => {
    const pre = o.askLaunch?.envExport ?? '';
    const post = o.askLaunch ? ` ${o.askLaunch.settingsArg}` : '';
    return `${pre}${o.launchCommand} ${effortFlag(o.effort)} ${idFlag}${post}`;
  };
  return {
    kind: 'claude',
    capabilities: { effort: true, askHook: true, hud: true, rewind: true, presetSessionId: true },
    buildLaunchCmd: (o) => wrap(o, `--session-id ${o.sessionId}`),
    buildResumeCmd: (o) => wrap(o, `--resume ${o.sessionId}`),
    locateTranscript: () => null,
    makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {/* noop */} }),
    discoverSessionId: async (o) => o.tentativeSessionId,
    parseToolUseEvents: () => [],
  };
}

/** fake codex adapter:capabilities 全关。buildLaunchCmd 透传 launchCommand,resume 固定模板。 */
function makeFakeCodexAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    kind: 'codex',
    capabilities: { effort: false, askHook: false, hud: false, rewind: false, presetSessionId: false },
    buildLaunchCmd: (o) => o.launchCommand,
    buildResumeCmd: (o) => `codex resume --yolo ${o.sessionId}`,
    locateTranscript: () => null,
    makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {/* noop */} }),
    discoverSessionId: async (o) => o.tentativeSessionId,
    parseToolUseEvents: () => [],
    ...overrides,
  };
}

function fakeTmux(over: Partial<TmuxLike> = {}): TmuxLike & { calls: any } {
  const calls = { newDetached: [] as any[], sendKeys: [] as any[], pasteText: [] as any[] };
  return {
    calls,
    hasSession: vi.fn(async () => false),
    newDetached: vi.fn(async (...a: any[]) => void calls.newDetached.push(a)),
    sendKeys: vi.fn(async (n: string, k: string[]) => void calls.sendKeys.push(k)),
    pasteText: vi.fn(async (n: string, t: string) => void calls.pasteText.push(t)),
    capturePaneVisible: vi.fn(async () => ''),
    ...over,
  } as any;
}

function fakeTail(
  initial: ChatMessage[] = [],
): TranscriptLike & { push: (m: ChatMessage) => void; setChain: (ms: ChatMessage[]) => void } {
  let chain = [...initial];
  return {
    activeChain: () => chain,
    reset: () => {},
    push: (m) => {
      chain = [...chain, m];
    },
    setChain: (ms) => {
      chain = ms;
    },
  };
}

const events = () => ({
  onMessage: vi.fn(),
  onPreview: vi.fn(),
  onTurnState: vi.fn(),
  onHistory: vi.fn(),
  onAskState: vi.fn(),
  onAskPending: vi.fn(),
  onAskPendingClear: vi.fn(),
  onAskPendingFailed: vi.fn(),
  onHud: vi.fn(),
});

function fakeRewind(over: Record<string, any> = {}) {
  return {
    open: vi.fn(async () => ({ items: [{ index: 0, label: 'p', changes: 'x' }] })),
    execute: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => {}),
    ...over,
  };
}

function fakeAsk(over: Record<string, any> = {}) {
  return { answer: vi.fn(async () => ({ ok: true })), answerCurrent: vi.fn(async () => ({ ok: true })), ...over };
}

describe('ChatSession.ensure', () => {
  it('无 tmux 会话且无 transcript → --session-id 新建（含 --effort）', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, events());
    await s.ensure();
    expect(tmux.calls.newDetached[0][2]).toBe('Fable-yolo --effort max --session-id u-123');
  });

  it('无 tmux 会话但有 transcript → --resume（含 --effort）', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => true, adapter: makeFakeClaudeAdapter() }, events());
    await s.ensure();
    expect(tmux.calls.newDetached[0][2]).toBe('Fable-yolo --effort max --resume u-123');
  });

  it('spec.effort 反映到命令（--effort 在 idFlag 之前）', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession({ ...spec, effort: 'high' }, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, events());
    await s.ensure();
    expect(tmux.calls.newDetached[0][2]).toBe('Fable-yolo --effort high --session-id u-123');
  });

  it('tmux 会话已存在 → 不新建，直接 seed 历史', async () => {
    const tmux = fakeTmux({ hasSession: vi.fn(async () => true) });
    const hist: ChatMessage[] = [{ uuid: 'm1', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }];
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(hist), hasTranscript: () => true, adapter: makeFakeClaudeAdapter() }, events());
    await s.ensure();
    expect(tmux.newDetached).not.toHaveBeenCalled();
    expect(s.getMessages()).toEqual(hist);
  });
});

describe('ChatSession 输入', () => {
  it('sendText 粘贴文本 + Enter + 标记运行', async () => {
    const tmux = fakeTmux();
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.sendText('hello');
    expect(tmux.calls.pasteText[0]).toBe('hello');
    expect(tmux.calls.sendKeys[0]).toEqual(['Enter']);
    expect(ev.onTurnState).toHaveBeenCalledWith(true);
  });

  it('sendKey 映射命名键', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, events());
    await s.sendKey('esc');
    await s.sendKey('up');
    await s.sendKey('ctrl-c');
    expect(tmux.calls.sendKeys).toEqual([['Escape'], ['Up'], ['C-c']]);
  });

  it('setEffort 发 /effort 命令，不翻转 running', async () => {
    const tmux = fakeTmux();
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.setEffort('max');
    expect(tmux.calls.pasteText.at(-1)).toBe('/effort max');
    expect(tmux.calls.sendKeys.at(-1)).toEqual(['Enter']);
    expect(s.isRunning()).toBe(false);
    expect(ev.onTurnState).not.toHaveBeenCalled();
  });
});

describe('ChatSession.tick', () => {
  it('transcript 追加新消息（前缀扩展）→ 逐条 onMessage', async () => {
    const tmux = fakeTmux();
    const tail = fakeTail();
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    const m: ChatMessage = { uuid: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'yo' }] };
    tail.push(m);
    await s.tick();
    expect(ev.onMessage).toHaveBeenCalledWith(m);
    expect(ev.onHistory).not.toHaveBeenCalled();
    expect(s.getMessages()).toContainEqual(m);
  });

  it('transcript 分叉（非前缀，rewind 后）→ 整屏 onHistory', async () => {
    const tmux = fakeTmux();
    const tail = fakeTail([{ uuid: 'u1', role: 'user', blocks: [{ type: 'text', text: 'a' }] }]);
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.ensure(); // messages = [u1]
    const forked: ChatMessage = { uuid: 'u2', role: 'user', blocks: [{ type: 'text', text: 'b' }] };
    tail.setChain([forked]); // 链头变（u1→u2），非前缀
    await s.tick();
    expect(ev.onHistory).toHaveBeenCalledWith({ items: [{ kind: 'user', message: forked }], live: [] });
    expect(s.getMessages()).toEqual([forked]);
  });

  it('读屏推进预览与运行态：streaming→running+preview，complete→done', async () => {
    const streaming = [
      '❯ q',
      '',
      '● 1. 第一句正文在生成。',
      '  2. 第二句也出现了。',
      '',
      '✽ Slithering…',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  [opus] ░░ 3% | x',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    const complete = [
      '❯ q',
      '',
      '● 1. 第一句正文在生成。',
      '  2. 第二句也出现了。',
      '  3. 收尾。',
      '',
      '✻ Cooked for 3s',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  [opus] ░░ 3% | x',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');

    let pane = streaming;
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);

    await s.tick();
    expect(ev.onTurnState).toHaveBeenCalledWith(true);
    expect(ev.onPreview).toHaveBeenCalledWith(expect.stringContaining('第一句正文'));
    expect(s.isRunning()).toBe(true);

    pane = complete;
    await s.tick();
    expect(ev.onTurnState).toHaveBeenCalledWith(false);
    expect(s.isRunning()).toBe(false);
  });

  it('空闲：屏幕残留上一轮回复不会触发 running（修复反复抽搐）', async () => {
    const idlePane = [
      '❯ q',
      '',
      '● 这是上一轮的回复，静止在屏幕上。',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  [opus] ░░ 3% | x',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => idlePane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    for (let i = 0; i < 10; i++) await s.tick();
    expect(s.isRunning()).toBe(false);
    expect(ev.onTurnState).not.toHaveBeenCalled(); // 从未翻转
    expect(ev.onPreview).not.toHaveBeenCalled(); // 空闲不发预览
  });

  it('发送后：屏幕仍是上一轮残留（无 spinner）时不误报为本轮预览', async () => {
    const stale = [
      '❯ 上一条',
      '',
      '● 上一轮回复残留在屏幕上。',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    const responding = [
      '❯ 新问题',
      '',
      '● 新一轮的回复来了。',
      '',
      '✽ Slithering…',
      '',
      '────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────',
      '  ⏵⏵ bypass permissions on',
    ].join('\n');
    let pane = stale;
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);

    await s.sendText('新问题'); // holdPreview=true
    await s.tick(); // 残留屏幕被屏蔽，不应发预览
    expect(ev.onPreview).not.toHaveBeenCalled();

    pane = responding; // 出现 spinner + 新一轮 ●
    await s.tick();
    expect(ev.onPreview).toHaveBeenCalledWith(expect.stringContaining('新一轮的回复'));
    expect(ev.onPreview).not.toHaveBeenCalledWith(expect.stringContaining('上一轮回复残留'));
  });
});

describe('ChatSession.rewind', () => {
  const msg = (uuid: string, role: 'user' | 'assistant', text: string): ChatMessage => ({
    uuid,
    role,
    blocks: [{ type: 'text', text }],
  });

  it('rewindOpen 期间 tick 跳过预览/消息（轮询隔离）', async () => {
    const pane = ['❯ q', '', '● 正文残留', '', '✽ Slithering…'].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const rw = fakeRewind();
    const s = new ChatSession(
      spec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeRewind: () => rw },
      ev,
    );
    await s.rewindOpen();
    ev.onPreview.mockClear();
    ev.onMessage.mockClear();
    await s.tick();
    expect(ev.onPreview).not.toHaveBeenCalled();
    expect(ev.onMessage).not.toHaveBeenCalled();
  });

  it('rewindExecute 成功 → 截到所选 checkpoint 之前并 onHistory', async () => {
    const tail = fakeTail();
    const ev = events();
    const rw = fakeRewind();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeRewind: () => rw },
      ev,
    );
    const chain = [msg('u0', 'user', 'p0'), msg('a0', 'assistant', 'r0'), msg('u1', 'user', 'p1'), msg('a1', 'assistant', 'r1')];
    tail.setChain(chain);
    await s.ensure(); // messages = chain
    await s.rewindOpen();
    const r = await s.rewindExecute(1, 'conversation'); // 回退到第 1 个用户消息(u1)之前
    expect(r.ok).toBe(true);
    expect(rw.execute).toHaveBeenCalledWith(1, 'conversation');
    expect(s.getMessages().map((m) => m.uuid)).toEqual(['u0', 'a0']);
    expect(ev.onHistory).toHaveBeenCalledWith({
      items: [
        { kind: 'user', message: chain[0] },
        { kind: 'assistant', turnId: 'a0', tail: { text: 'r0', truncated: false } },
      ],
      live: [],
    });
  });

  it('rewind 后 tick 不把截断的消息加回（transcript 未变，边界维持）', async () => {
    const tail = fakeTail();
    const ev = events();
    const rw = fakeRewind();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeRewind: () => rw },
      ev,
    );
    const chain = [msg('u0', 'user', 'p0'), msg('a0', 'assistant', 'r0'), msg('u1', 'user', 'p1'), msg('a1', 'assistant', 'r1')];
    tail.setChain(chain);
    await s.ensure();
    await s.rewindOpen();
    await s.rewindExecute(1, 'conversation'); // → [u0,a0]
    ev.onMessage.mockClear();
    await s.tick(); // transcript 仍返回全链，但 u1 仍在活动链 → 维持截断
    expect(s.getMessages().map((m) => m.uuid)).toEqual(['u0', 'a0']);
    expect(ev.onMessage).not.toHaveBeenCalled();
  });

  it('rewind 后用户发新消息（分叉）→ 边界解除，渲染新链', async () => {
    const tail = fakeTail();
    const ev = events();
    const rw = fakeRewind();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeRewind: () => rw },
      ev,
    );
    tail.setChain([msg('u0', 'user', 'p0'), msg('a0', 'assistant', 'r0'), msg('u1', 'user', 'p1'), msg('a1', 'assistant', 'r1')]);
    await s.ensure();
    await s.rewindOpen();
    await s.rewindExecute(1, 'conversation'); // → [u0,a0]
    // 用户发新消息：u1 离开活动链，新分支 u2/a2 接在 a0 后
    tail.setChain([msg('u0', 'user', 'p0'), msg('a0', 'assistant', 'r0'), msg('u2', 'user', 'p2'), msg('a2', 'assistant', 'r2')]);
    ev.onMessage.mockClear();
    await s.tick();
    expect(s.getMessages().map((m) => m.uuid)).toEqual(['u0', 'a0', 'u2', 'a2']);
  });

  it('rewindExecute 失败 → 不截断、不 onHistory', async () => {
    const tail = fakeTail();
    const ev = events();
    const rw = fakeRewind({ execute: vi.fn(async () => ({ ok: false, error: 'x' })) });
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeRewind: () => rw },
      ev,
    );
    tail.setChain([msg('u0', 'user', 'p0'), msg('a0', 'assistant', 'r0')]);
    await s.ensure();
    ev.onHistory.mockClear();
    const r = await s.rewindExecute(0, 'both');
    expect(r.ok).toBe(false);
    expect(s.getMessages().map((m) => m.uuid)).toEqual(['u0', 'a0']);
    expect(ev.onHistory).not.toHaveBeenCalled();
  });
});

describe('ChatSession.ask', () => {
  it('answerAsk:广播 driving→done 且调用控制器', async () => {
    const ev = events();
    const ask = fakeAsk();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeAsk: () => ask },
      ev,
    );
    await s.answerAsk('t1', [{ questionIndex: 0, optionIndices: [1] }]);
    expect(ask.answer).toHaveBeenCalledWith([{ questionIndex: 0, optionIndices: [1] }]);
    expect(ev.onAskState).toHaveBeenCalledWith({ toolUseId: 't1', status: 'driving' });
    expect(ev.onAskState).toHaveBeenCalledWith({ toolUseId: 't1', status: 'done' });
  });

  it('answerAsk 失败 → 广播 failed(含 error)', async () => {
    const ev = events();
    const ask = fakeAsk({ answer: vi.fn(async () => ({ ok: false, error: 'unreachable' })) });
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeAsk: () => ask },
      ev,
    );
    await s.answerAsk('t1', [{ questionIndex: 0, optionIndices: [0] }]);
    expect(ev.onAskState).toHaveBeenCalledWith({ toolUseId: 't1', status: 'failed', error: 'unreachable' });
  });

  it('ask 驱动期间 tick 跳过预览(轮询隔离)', async () => {
    const pane = ['❯ q', '', '● 残留', '', '✽ Slithering…'].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    let release: () => void = () => {};
    const ask = fakeAsk({ answer: vi.fn(() => new Promise<{ ok: boolean }>((r) => (release = () => r({ ok: true })))) });
    const s = new ChatSession(
      spec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeAsk: () => ask },
      ev,
    );
    const p = s.answerAsk('t1', [{ questionIndex: 0, optionIndices: [0] }]); // askActive=true,answer 挂起
    ev.onPreview.mockClear();
    await s.tick();
    expect(ev.onPreview).not.toHaveBeenCalled();
    release();
    await p;
  });
});

describe('ChatSession 待答选择题(实时读屏)', () => {
  const ASK_PANE = [
    ' ☐ Fruit',
    '',
    'Pick a fruit',
    '',
    '❯ 1. Apple',
    '  2. Banana',
    '  3. Type something.',
    '  4. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

  it('检测到待答 → onAskPending(真实选项),抑制预览,running=false', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => ASK_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onAskPending).toHaveBeenCalledWith({
      options: [
        { index: 0, label: 'Apple' },
        { index: 1, label: 'Banana' },
      ],
      multiSelect: false,
    });
    expect(ev.onPreview).not.toHaveBeenCalled();
    expect(s.isRunning()).toBe(false);
    expect(s.getLiveAsk()).not.toBeNull();
  });

  it('同一菜单连续 tick 只发一次 onAskPending(签名去重)', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => ASK_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    await s.tick();
    await s.tick();
    expect(ev.onAskPending).toHaveBeenCalledTimes(1);
  });

  it('菜单消失 → onAskPendingClear 且 getLiveAsk 归空', async () => {
    let pane = ASK_PANE;
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    pane = 'just some idle text';
    await s.tick();
    expect(ev.onAskPendingClear).toHaveBeenCalledTimes(1);
    expect(s.getLiveAsk()).toBeNull();
  });

  it('answerPendingAsk 调 answerCurrent;失败发 onAskPendingFailed', async () => {
    const ask = fakeAsk({ answerCurrent: vi.fn(async () => ({ ok: false, error: 'unreachable' })) });
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeAsk: () => ask },
      ev,
    );
    await s.answerPendingAsk([1]);
    expect(ask.answerCurrent).toHaveBeenCalledWith([1]);
    expect(ev.onAskPendingFailed).toHaveBeenCalledWith('unreachable');
  });

  it('answerPendingAsk 成功不发 failed', async () => {
    const ask = fakeAsk();
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), makeAsk: () => ask },
      ev,
    );
    await s.answerPendingAsk([0]);
    expect(ev.onAskPendingFailed).not.toHaveBeenCalled();
  });

  it('非 ask 屏:既有读屏/预览行为不变(不误触发待答)', async () => {
    const streaming = ['❯ q', '', '● 正文在生成。', '', '✽ Slithering…'].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => streaming) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onAskPending).not.toHaveBeenCalled();
    expect(ev.onPreview).toHaveBeenCalledWith(expect.stringContaining('正文在生成'));
    expect(s.isRunning()).toBe(true);
  });
});

describe('ChatSession 待答选择题(hook 真值)', () => {
  const HOOK_PENDING: AskHookPending = {
    toolUseId: 'toolu_9',
    ts: 1,
    questions: [
      { question: 'Pick a fruit', header: 'Fruit', multiSelect: false, options: [{ label: 'Apple', description: '苹果' }, { label: 'Banana' }] },
      { question: 'Pick a color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }] },
    ],
  };
  const fakeDriver = (over: Record<string, any> = {}) => ({ answer: vi.fn(async () => ({ ok: true })), ...over });

  it('注入 askLaunch → 命令含 export RCC_ASK_DIR 与 --settings', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(
      spec,
      {
        tmux,
        scrape: scrapePane,
        tail: fakeTail(),
        hasTranscript: () => false,
        adapter: makeFakeClaudeAdapter(),
        askDir: '/d',
        askLaunch: { envExport: "export RCC_ASK_DIR='/d'; ", settingsArg: "--settings '/s.json'" },
      },
      events(),
    );
    await s.ensure();
    expect(tmux.calls.newDetached[0][2]).toBe("export RCC_ASK_DIR='/d'; Fable-yolo --effort max --session-id u-123 --settings '/s.json'");
  });

  it('sidecar 有 → onAskPending(全结构),抑制预览,running=false,getLiveAsk 非空', async () => {
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING },
      ev,
    );
    await s.tick();
    expect(ev.onAskPending).toHaveBeenCalledWith({
      question: 'Pick a fruit',
      header: 'Fruit',
      multiSelect: false,
      qIndex: 0,
      qTotal: 2,
      options: [
        { index: 0, label: 'Apple', description: '苹果' },
        { index: 1, label: 'Banana' },
      ],
    });
    expect(ev.onPreview).not.toHaveBeenCalled();
    expect(s.isRunning()).toBe(false);
    expect(s.getLiveAsk()).not.toBeNull();
  });

  it('同一 sidecar 连续 tick 只发一次(签名去重)', async () => {
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING },
      ev,
    );
    await s.tick();
    await s.tick();
    expect(ev.onAskPending).toHaveBeenCalledTimes(1);
  });

  it('sidecar 由有转无 → onAskPendingClear 且 getLiveAsk 归空', async () => {
    let p: AskHookPending | null = HOOK_PENDING;
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => p },
      ev,
    );
    await s.tick();
    p = null;
    await s.tick();
    expect(ev.onAskPendingClear).toHaveBeenCalledTimes(1);
    expect(s.getLiveAsk()).toBeNull();
  });

  it('answerPendingAsk 调 AskDriver.answer(当前题选项)', async () => {
    const driver = fakeDriver();
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING, makeAskDriver: () => driver },
      ev,
    );
    await s.answerPendingAsk([1]);
    expect(driver.answer).toHaveBeenCalledWith(HOOK_PENDING.questions[0].options, [1], false);
    expect(ev.onAskPendingFailed).not.toHaveBeenCalled();
  });

  it('driver 返回 fallback → 转既有 AskController.answerCurrent', async () => {
    const driver = fakeDriver({ answer: vi.fn(async () => ({ ok: false, fallback: true })) });
    const ask = fakeAsk();
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING, makeAskDriver: () => driver, makeAsk: () => ask },
      ev,
    );
    await s.answerPendingAsk([0]);
    expect(ask.answerCurrent).toHaveBeenCalledWith([0]);
  });

  it('driver 失败(非 fallback) → onAskPendingFailed', async () => {
    const driver = fakeDriver({ answer: vi.fn(async () => ({ ok: false, error: 'guard' })) });
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING, makeAskDriver: () => driver },
      ev,
    );
    await s.answerPendingAsk([0]);
    expect(ev.onAskPendingFailed).toHaveBeenCalledWith('guard');
  });

  it('多问题:答完第0题 → 下个 tick 发第1题(qIndex 推进)', async () => {
    const driver = fakeDriver();
    const ev = events();
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter(), askDir: '/d', readAskSidecar: () => HOOK_PENDING, makeAskDriver: () => driver },
      ev,
    );
    await s.tick();
    await s.answerPendingAsk([0]);
    await s.tick();
    const calls = ev.onAskPending.mock.calls.map((c: any[]) => c[0]);
    expect(calls[0].qIndex).toBe(0);
    expect(calls[1].qIndex).toBe(1);
    expect(calls[1].question).toBe('Pick a color');
  });
});

describe('ChatSession HUD 读屏', () => {
  const HUD_PANE = [
    '────────────────────',
    '❯ ',
    '────────────────────',
    '  [claude-opus-4-8[1m]] ██░░░░░░░░ 19% | remote-cc git:(master*) | Usage █░░░░░░░░░ 14% (2h 19m / 5h)',
    '  Weekly █░░░░░░░░░ 14% (6d 3h / Weekly)',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');

  it('首次 tick → onHud(解析出 model/上下文/限额),getLiveHud 返回它', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    const hud = ev.onHud.mock.calls[0][0];
    expect(hud.model).toBe('claude-opus-4-8');
    expect(hud.contextWindow).toBe('1m');
    expect(hud.contextPct).toBe(19);
    expect(hud.fiveHour).toEqual({ pct: 14, text: '2h 19m / 5h' });
    expect(hud.weekly).toEqual({ pct: 14, text: '6d 3h / Weekly' });
    expect(s.getLiveHud()).toEqual(hud);
  });

  it('HUD 不变 → 连续 tick 只发一次(签名去重)', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    await s.tick();
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
  });

  it('HUD 变化(百分比变) → 重发', async () => {
    let pane = HUD_PANE;
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    pane = HUD_PANE.replace('19%', '20%');
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(2);
    expect(ev.onHud.mock.calls[1][0].contextPct).toBe(20);
  });

  it('无 HUD 状态行的屏 → 不发 onHud,getLiveHud 仍为 null', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => 'just idle chat\n❯ ') });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onHud).not.toHaveBeenCalled();
    expect(s.getLiveHud()).toBeNull();
  });

  it('待答菜单打开时 HUD 仍更新(在 ask 早返回之前广播)', async () => {
    // 同屏既有 ask 菜单又有 HUD 行(实测待答期 HUD 仍在屏)。
    const pane = [
      '  [claude-opus-4-8[1m]] ██░░░░░░░░ 19% | remote-cc git:(master*) | Usage █░░░░░░░░░ 14% (2h 19m / 5h)',
      '  Weekly █░░░░░░░░░ 14% (6d 3h / Weekly)',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '',
      '❯ 1. Apple',
      '  2. Banana',
      '  3. Type something.',
      '  4. Chat about this',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    // ask 与 HUD 互不影响:两者都应触发。
    expect(ev.onAskPending).toHaveBeenCalledTimes(1);
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    expect(ev.onHud.mock.calls[0][0].model).toBe('claude-opus-4-8');
  });
});

describe('ChatSession HUD 分层数据源', () => {
  const HUD_PANE = [
    '  [claude-opus-4-8[1m]] ██░░ 19% | remote-cc git:(master*) | Usage █░░ 14% (2h 19m / 5h)',
    '  Weekly █░░ 14% (6d 3h / Weekly)',
  ].join('\n');

  const sidecarJson = JSON.stringify({
    transcript_path: '/x/u-123.jsonl',
    model: { display_name: 'Opus 4.8' },
    context_window: { context_window_size: 1_000_000, used_percentage: 22, current_usage: { input_tokens: 220_000 } },
    rate_limits: { five_hour: { used_percentage: 30, resets_at: 0 }, seven_day: { used_percentage: 55, resets_at: 0 } },
  });

  it('有 sidecar → source=statusline,用其完整字段;git 从 pane 补', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const s = new ChatSession(
      spec,
      {
        tmux,
        scrape: scrapePane,
        tail: fakeTail(),
        hasTranscript: () => false,
        adapter: makeFakeClaudeAdapter(),
        statuslineDir: '/dir',
        readSidecar: () => ({ content: sidecarJson, mtimeMs: Date.now() }),
      },
      ev,
    );
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    const hud = ev.onHud.mock.calls[0][0];
    expect(hud.source).toBe('statusline');
    expect(hud.model).toBe('Opus 4.8');
    expect(hud.contextPct).toBe(22);
    expect(hud.contextWindowTokens).toBe(1_000_000);
    expect(hud.fiveHour).toEqual({ pct: 30 }); // resets_at=0 → 无 text
    expect(hud.weekly).toEqual({ pct: 55 });
    expect(hud.gitBranch).toBe('master*'); // sidecar 无 git → 从 pane 补
  });

  it('sidecar 过期(mtime 旧) → 退回读屏 pane(source=pane)', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const s = new ChatSession(
      spec,
      {
        tmux,
        scrape: scrapePane,
        tail: fakeTail(),
        hasTranscript: () => false,
        adapter: makeFakeClaudeAdapter(),
        statuslineDir: '/dir',
        readSidecar: () => ({ content: sidecarJson, mtimeMs: Date.now() - 60_000 }), // >15s
      },
      ev,
    );
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    expect(ev.onHud.mock.calls[0][0].source).toBe('pane');
  });

  it('无 sidecar,有 transcript usage → source=transcript,叠加 pane 的用量/git', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const tail = { ...fakeTail(), lastAssistantUsage: () => ({ input_tokens: 100_000, cache_read_input_tokens: 50_000 }) };
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail, hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    const hud = ev.onHud.mock.calls[0][0];
    expect(hud.source).toBe('transcript');
    expect(hud.contextTokens).toBe(150_000);
    expect(hud.approxContext).toBe(true);
    // transcript 无 5h/周 → 借 pane 的
    expect(hud.fiveHour).toEqual({ pct: 14, text: '2h 19m / 5h' });
    expect(hud.gitBranch).toBe('master*');
  });

  it('无 sidecar/transcript,仅读屏 → source=pane(旧行为不破)', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => HUD_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeClaudeAdapter() }, ev);
    await s.tick();
    expect(ev.onHud).toHaveBeenCalledTimes(1);
    expect(ev.onHud.mock.calls[0][0].source).toBe('pane');
  });
});

describe('ChatSession 历史骨架', () => {
  const msg = (uuid: string, role: 'user' | 'assistant', text: string): ChatMessage => ({
    uuid,
    role,
    blocks: [{ type: 'text', text }],
  });

  it('getSkeleton:用户全文 + 助手折叠,最后助手回合带 tail;getTurnBody 取正文', async () => {
    const chain = [msg('u0', 'user', 'q0'), msg('a0', 'assistant', 'r0'), msg('u1', 'user', 'q1'), msg('a1', 'assistant', 'r1')];
    const tail = fakeTail(chain);
    const s = new ChatSession(
      spec,
      { tmux: fakeTmux({ hasSession: vi.fn(async () => true) }), scrape: scrapePane, tail, hasTranscript: () => true, adapter: makeFakeClaudeAdapter() },
      events(),
    );
    await s.ensure(); // messages = chain
    const snap = s.getSkeleton();
    expect(snap.live).toEqual([]);
    expect(snap.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const last = snap.items[3];
    expect(last.kind).toBe('assistant');
    if (last.kind === 'assistant') {
      expect(last.turnId).toBe('a1');
      expect(last.tail?.text).toBe('r1');
    }
    expect(s.getTurnBody('a0')?.map((m) => m.uuid)).toEqual(['a0']);
    expect(s.getTurnBody('nope')).toBeNull();
  });
});

describe('ChatSession codex 模式(capability 全 false)', () => {
  const codexSpec: ChatSpec = { ...spec, agentKind: 'codex', launchCommand: 'codex --yolo' };

  it('setEffort/answerAsk/answerPendingAsk/rewind* 静默 noop:不动 tmux、返回 noop 值', async () => {
    const tmux = fakeTmux();
    const ev = events();
    const s = new ChatSession(
      codexSpec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeCodexAdapter() },
      ev,
    );
    // effort:不发 /effort,不碰 tmux。
    await s.setEffort('high');
    expect(tmux.pasteText).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    // rewind:open 返空、execute 返失败、cancel 静默。
    expect(await s.rewindOpen()).toEqual([]);
    expect(await s.rewindExecute(0, 'conversation')).toEqual({ ok: false, error: 'rewind 不支持' });
    await s.rewindCancel();
    // answerAsk:广播 failed(不 driving)。
    await s.answerAsk('t1', [{ questionIndex: 0, optionIndices: [0] }]);
    expect(ev.onAskState).toHaveBeenCalledWith({ toolUseId: 't1', status: 'failed', error: 'askHook 不支持' });
    expect(ev.onAskState).not.toHaveBeenCalledWith({ toolUseId: 't1', status: 'driving' });
    // answerPendingAsk:广播 failed。
    await s.answerPendingAsk([0]);
    expect(ev.onAskPendingFailed).toHaveBeenCalledWith('askHook 不支持');
    // getLiveAsk/getLiveHud:始终 null。
    expect(s.getLiveAsk()).toBeNull();
    expect(s.getLiveHud()).toBeNull();
    // 全程没有任何按键被发出(连 rewind/ask 控制器都没被触达)。
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(tmux.pasteText).not.toHaveBeenCalled();
  });

  it('tick 不发 HUD、不发待答(hud/askHook 两段被 capability 包护跳过)', async () => {
    // 给一屏既像 claude HUD 又像 ask 菜单的内容:codex 模式下两段都不该触发。
    const pane = [
      '  [claude-opus-4-8[1m]] ██░░ 19% | repo git:(master*) | Usage █░░ 14% (2h / 5h)',
      '❯ 1. Apple',
      '  2. Banana',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(
      codexSpec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeCodexAdapter() },
      ev,
    );
    await s.tick();
    expect(ev.onHud).not.toHaveBeenCalled();
    expect(ev.onAskPending).not.toHaveBeenCalled();
  });

  it('ensure 走 adapter.buildLaunchCmd(无 transcript)', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(
      codexSpec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter: makeFakeCodexAdapter() },
      events(),
    );
    await s.ensure();
    // codex buildLaunchCmd 透传 launchCommand(无 --session-id/--effort)。
    expect(tmux.calls.newDetached[0][2]).toBe('codex --yolo');
  });

  it('ensure 走 adapter.buildResumeCmd(有 transcript) → codex resume 模板', async () => {
    const tmux = fakeTmux();
    const s = new ChatSession(
      codexSpec,
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => true, adapter: makeFakeCodexAdapter() },
      events(),
    );
    await s.ensure();
    expect(tmux.calls.newDetached[0][2]).toBe('codex resume --yolo u-123');
  });

  it('!presetSessionId:首次启动后 discoverSessionId 扫到新 UUID → 回调 + tail.setSessionId', async () => {
    const tmux = fakeTmux();
    const resolved: string[] = [];
    const setSidCalls: string[] = [];
    // tail 暴露 setSessionId 钩子(codex tail 有)。
    const tail = Object.assign(fakeTail(), { setSessionId: (sid: string) => setSidCalls.push(sid) });
    const adapter = makeFakeCodexAdapter({ discoverSessionId: async () => 'real-uuid-xyz' });
    const s = new ChatSession(
      { ...codexSpec, onSessionIdResolved: (sid) => resolved.push(sid) },
      { tmux, scrape: scrapePane, tail, hasTranscript: () => false, adapter },
      events(),
    );
    await s.ensure();
    // discoverAndPersistSessionId 是 fire-and-forget,await 一个微任务队列让它跑完。
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toEqual(['real-uuid-xyz']);
    expect(setSidCalls).toEqual(['real-uuid-xyz']);
  });

  it('!presetSessionId 但扫到的 UUID 与占位相同 → 不回调、不切 tail', async () => {
    const tmux = fakeTmux();
    const resolved: string[] = [];
    const setSidCalls: string[] = [];
    const tail = Object.assign(fakeTail(), { setSessionId: (sid: string) => setSidCalls.push(sid) });
    // discoverSessionId 返回占位本身(u-123)。
    const adapter = makeFakeCodexAdapter({ discoverSessionId: async (o) => o.tentativeSessionId });
    const s = new ChatSession(
      { ...codexSpec, onSessionIdResolved: (sid) => resolved.push(sid) },
      { tmux, scrape: scrapePane, tail, hasTranscript: () => false, adapter },
      events(),
    );
    await s.ensure();
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toEqual([]);
    expect(setSidCalls).toEqual([]);
  });

  it('presetSessionId=true(claude)不触发 discoverSessionId 回写', async () => {
    const tmux = fakeTmux();
    const resolved: string[] = [];
    const discover = vi.fn(async () => 'should-not-be-used');
    const adapter = makeFakeClaudeAdapter();
    adapter.discoverSessionId = discover;
    const s = new ChatSession(
      { ...spec, onSessionIdResolved: (sid) => resolved.push(sid) },
      { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, adapter },
      events(),
    );
    await s.ensure();
    await new Promise((r) => setTimeout(r, 0));
    expect(discover).not.toHaveBeenCalled();
    expect(resolved).toEqual([]);
  });
});
