import { describe, it, expect } from 'vitest';
import {
  formatResetCountdown,
  parseStatuslineStdin,
  deriveContextFromTranscriptUsage,
  pickHud,
  readStatuslineSidecar,
  type SidecarIO,
} from './hudSource';
import type { Hud } from '@rcc/shared';

/** 构造一份完整的 statusLine stdin JSON（实测形状）。 */
function sampleStdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    transcript_path: '/home/u/.claude/projects/-mnt-proj/abc-123.jsonl',
    session_id: 'abc-123',
    cwd: '/mnt/proj',
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: 19.6,
      current_usage: {
        input_tokens: 10_000,
        cache_creation_input_tokens: 5_000,
        cache_read_input_tokens: 180_000,
        output_tokens: 2_000,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 14, resets_at: 0 },
      seven_day: { used_percentage: 41, resets_at: 0 },
    },
    ...over,
  });
}

describe('formatResetCountdown', () => {
  const now = 1_000_000; // 秒
  it('小时+分钟', () => {
    expect(formatResetCountdown(now + 3 * 3600 + 27 * 60, now)).toBe('3h 27m');
  });
  it('超过一天 → 天+小时', () => {
    expect(formatResetCountdown(now + 2 * 86400 + 4 * 3600, now)).toBe('2d 4h');
  });
  it('不足一小时 → 仅分钟', () => {
    expect(formatResetCountdown(now + 42 * 60, now)).toBe('42m');
  });
  it('已过期/当下 → now', () => {
    expect(formatResetCountdown(now - 10, now)).toBe('now');
    expect(formatResetCountdown(now, now)).toBe('now');
  });
});

describe('parseStatuslineStdin', () => {
  const now = 1_000_000;
  it('完整 JSON → model/contextPct/token/窗口/5h/周/source', () => {
    const h = parseStatuslineStdin(sampleStdin({
      rate_limits: {
        five_hour: { used_percentage: 14, resets_at: now + 2 * 3600 + 19 * 60 },
        seven_day: { used_percentage: 41, resets_at: now + 6 * 86400 + 3 * 3600 },
      },
    }), now);
    expect(h).not.toBeNull();
    expect(h!.model).toBe('Opus 4.8');
    expect(h!.contextPct).toBe(20); // 19.6 取整
    expect(h!.contextTokens).toBe(195_000); // 10k+5k+180k（含 output? 不含——见实现注释）
    expect(h!.contextWindowTokens).toBe(1_000_000);
    expect(h!.contextWindow).toBe('1m');
    expect(h!.fiveHour).toEqual({ pct: 14, text: '2h 19m' });
    expect(h!.weekly).toEqual({ pct: 41, text: '6d 3h' });
    expect(h!.source).toBe('statusline');
    expect(h!.raw).toContain('Opus 4.8');
  });

  it('坏 JSON → null', () => {
    expect(parseStatuslineStdin('not json', now)).toBeNull();
    expect(parseStatuslineStdin('', now)).toBeNull();
  });

  it('缺 rate_limits → 无 5h/周，仍有 model+context', () => {
    const h = parseStatuslineStdin(JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { context_window_size: 200_000, used_percentage: 30, current_usage: { input_tokens: 60_000 } },
    }), now);
    expect(h).not.toBeNull();
    expect(h!.model).toBe('Sonnet');
    expect(h!.contextWindow).toBe('200k');
    expect(h!.contextPct).toBe(30);
    expect(h!.fiveHour).toBeUndefined();
    expect(h!.weekly).toBeUndefined();
  });

  it('无 display_name → 退回 model.id', () => {
    const h = parseStatuslineStdin(JSON.stringify({ model: { id: 'claude-x' }, context_window: { context_window_size: 1_000_000, used_percentage: 5 } }), now);
    expect(h!.model).toBe('claude-x');
  });

  it('无 context_window.used_percentage → 由 token/窗口算 pct', () => {
    const h = parseStatuslineStdin(JSON.stringify({
      model: { display_name: 'M' },
      context_window: { context_window_size: 200_000, current_usage: { input_tokens: 100_000 } },
    }), now);
    expect(h!.contextPct).toBe(50);
  });
});

describe('deriveContextFromTranscriptUsage', () => {
  it('窗口未知、tokens≤200k → 视 200k 估 pct + approx', () => {
    const r = deriveContextFromTranscriptUsage({ input_tokens: 50_000, cache_read_input_tokens: 50_000 });
    expect(r.tokens).toBe(100_000);
    expect(r.pct).toBe(50);
    expect(r.approx).toBe(true);
  });
  it('tokens>200k → 视 1M 估 pct', () => {
    const r = deriveContextFromTranscriptUsage({ input_tokens: 300_000 });
    expect(r.tokens).toBe(300_000);
    expect(r.pct).toBe(30);
    expect(r.approx).toBe(true);
  });
  it('空 usage → tokens 0', () => {
    const r = deriveContextFromTranscriptUsage({});
    expect(r.tokens).toBe(0);
  });
});

describe('pickHud', () => {
  const sl: Hud = { source: 'statusline', model: 'Opus', contextPct: 20, contextTokens: 195_000, contextWindowTokens: 1_000_000, fiveHour: { pct: 14, text: '2h' }, weekly: { pct: 41, text: '6d' }, raw: 'SL' };
  const pane: Hud = { source: 'pane', model: 'Opus(pane)', contextPct: 19, fiveHour: { pct: 16 }, weekly: { pct: 40 }, gitBranch: 'master', raw: 'PANE' };

  it('有 sidecar → 直接用 sidecar（最完整）', () => {
    const h = pickHud({ statusline: sl, pane });
    expect(h!.source).toBe('statusline');
    expect(h!.contextTokens).toBe(195_000);
  });

  it('sidecar 有但缺 git → 从 pane 补 gitBranch', () => {
    const h = pickHud({ statusline: sl, pane });
    expect(h!.gitBranch).toBe('master');
  });

  it('无 sidecar：transcript context + pane 用量合并', () => {
    const tr: Hud = { source: 'transcript', contextTokens: 100_000, contextPct: 50, approxContext: true, raw: 'TR' };
    const h = pickHud({ transcript: tr, pane });
    expect(h!.source).toBe('transcript');
    expect(h!.contextTokens).toBe(100_000);
    expect(h!.contextPct).toBe(50);
    // 用量来自 pane（transcript 无 5h/周）
    expect(h!.fiveHour).toEqual({ pct: 16 });
    expect(h!.weekly).toEqual({ pct: 40 });
    expect(h!.gitBranch).toBe('master');
    // model 缺则借 pane
    expect(h!.model).toBe('Opus(pane)');
  });

  it('只有 pane → 用 pane', () => {
    const h = pickHud({ pane });
    expect(h!.source).toBe('pane');
  });

  it('全空 → null', () => {
    expect(pickHud({})).toBeNull();
  });
});

describe('readStatuslineSidecar', () => {
  const now = 2_000_000_000_000; // ms
  const fresh = sampleStdin();
  const mkIO = (content: string | null, mtimeMs: number): SidecarIO => ({
    read: (p) => {
      expect(p).toContain('abc-123.json');
      if (content === null) throw new Error('ENOENT');
      return { content, mtimeMs };
    },
  });

  it('新鲜 sidecar → 解析为 statusline Hud', () => {
    const h = readStatuslineSidecar(mkIO(fresh, now - 2000), '/dir', 'abc-123', now);
    expect(h).not.toBeNull();
    expect(h!.source).toBe('statusline');
  });

  it('mtime 过期(>15s) → null', () => {
    expect(readStatuslineSidecar(mkIO(fresh, now - 20_000), '/dir', 'abc-123', now)).toBeNull();
  });

  it('文件不存在 → null（不抛）', () => {
    expect(readStatuslineSidecar(mkIO(null, 0), '/dir', 'abc-123', now)).toBeNull();
  });

  it('坏内容 → null', () => {
    expect(readStatuslineSidecar(mkIO('garbage', now), '/dir', 'abc-123', now)).toBeNull();
  });
});
