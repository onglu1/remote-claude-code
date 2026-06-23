import { describe, it, expect } from 'vitest';
import { createActivityState, tickActivity, parseToolUseEvents, type ActivityIO } from './activity';

const baseCtx = {
  transcriptPath: '/fake/transcript.jsonl',
  tmuxName: 'rcc-x-y',
  sessionId: 'sess1',
  statuslineDir: '/fake/sl',
  askDir: '/fake/ask',
};

function makeIO(overrides: Partial<ActivityIO>): ActivityIO {
  return {
    transcriptStat: () => null,
    transcriptTail: () => ({ text: '', end: 0 }),
    sidecarStat: () => null,
    askSidecarExists: () => false,
    paneHash: () => null,
    now: () => 1000,
    ...overrides,
  };
}

describe('parseToolUseEvents', () => {
  it('提取主线 tool_use 与 tool_result', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      }),
    ].join('\n') + '\n';
    const events = parseToolUseEvents(lines);
    expect(events).toEqual([
      { kind: 'open', id: 'tu1', sidechain: false },
      { kind: 'close', id: 'tu1', sidechain: false },
    ]);
  });

  it('sidechain 节点单独标记', () => {
    const lines = JSON.stringify({
      type: 'assistant',
      uuid: 'a1', isSidechain: true,
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    }) + '\n';
    expect(parseToolUseEvents(lines)).toEqual([
      { kind: 'open', id: 'tu1', sidechain: true },
    ]);
  });
});

describe('tickActivity 五信号', () => {
  it('信号①:未闭合 tool_use → busy', () => {
    const state = createActivityState(0);
    const io = makeIO({
      transcriptStat: () => ({ mtimeMs: 0, size: 100 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'assistant', uuid: 'a',
          message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        }) + '\n',
        end: 100,
      }),
      now: () => 5000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('open_tool_use');
  });

  it('信号①:tool_use 后 tool_result 来了 → 不再 busy(若其它信号也无)', () => {
    const state = createActivityState(0);
    state.lastBusyAt = 0;
    // 第一次:开 tool_use
    let io = makeIO({
      transcriptStat: () => ({ mtimeMs: 100, size: 100 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'assistant', uuid: 'a',
          message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        }) + '\n',
        end: 100,
      }),
      now: () => 1000,
    });
    tickActivity(state, baseCtx, io, 90_000);
    expect(state.openToolUseIds.has('tu1')).toBe(true);

    // 第二次:关 tool_result;mtime 也跳了,但我们在 windowMs 之外
    io = makeIO({
      transcriptStat: () => ({ mtimeMs: 200, size: 200 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'user', uuid: 'u',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        }) + '\n',
        end: 200,
      }),
      now: () => 1_000_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(state.openToolUseIds.has('tu1')).toBe(false);
    expect(r.busy).toBe(false);
  });

  it('信号②:askSidecarExists=true → busy', () => {
    const state = createActivityState(0);
    const io = makeIO({ askSidecarExists: () => true, now: () => 1000 });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('ask_sidecar');
  });

  it('信号③:transcript mtime 在 windowMs 内跳 → busy', () => {
    const state = createActivityState(0);
    state.lastTranscriptMtime = 1000;
    const io = makeIO({
      transcriptStat: () => ({ mtimeMs: 5000, size: 0 }),
      now: () => 10_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('transcript_mtime');
  });

  it('信号④:statusline sidecar mtime 跳 → busy', () => {
    const state = createActivityState(0);
    state.lastStatuslineMtime = 1000;
    const io = makeIO({
      sidecarStat: () => ({ mtimeMs: 5000 }),
      now: () => 10_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('statusline_mtime');
  });

  it('信号⑤:pane hash 在 windowMs 内变 → busy', () => {
    const state = createActivityState(0);
    state.lastPaneHash = 'aaa';
    state.lastPaneHashAt = 1000;
    const io = makeIO({
      paneHash: () => 'bbb',
      now: () => 5000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('pane_hash');
  });

  it('全空闲:idleForMs = now - lastBusyAt', () => {
    const state = createActivityState(1000);
    state.lastBusyAt = 1000;
    const io = makeIO({ now: () => 11_000 });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(false);
    expect(r.idleForMs).toBe(10_000);
  });
});
