import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scrapeHud } from './hudScraper';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');

describe('scrapeHud', () => {
  it('繁忙/有订阅:解出 model+contextWindow+contextPct+5h+周+git', () => {
    const h = scrapeHud(fx('hud_busy_with_usage.txt'));
    expect(h).not.toBeNull();
    expect(h!.model).toBe('claude-opus-4-8');
    expect(h!.contextWindow).toBe('1m');
    expect(h!.contextPct).toBe(19);
    expect(h!.fiveHour).toEqual({ pct: 14, text: '2h 19m / 5h' });
    expect(h!.weekly).toEqual({ pct: 14, text: '6d 3h / Weekly' });
    expect(h!.gitBranch).toBe('master*');
    // raw 是清洗后的镜像:含两行 HUD、不含权限行(⏵⏵)
    expect(h!.raw).toContain('claude-opus-4-8');
    expect(h!.raw).toContain('Weekly');
    expect(h!.raw).not.toContain('⏵⏵');
  });

  it('空闲/无 usage:仅 model+contextWindow+contextPct,无 5h/周', () => {
    const h = scrapeHud(fx('hud_idle_no_usage.txt'));
    expect(h).not.toBeNull();
    expect(h!.model).toBe('claude-opus-4-8');
    expect(h!.contextWindow).toBe('1m');
    expect(h!.contextPct).toBe(0);
    expect(h!.fiveHour).toBeUndefined();
    expect(h!.weekly).toBeUndefined();
    // git:(master*) 里括号内才是分支;前面的 sample-finetune 是工作目录名
    expect(h!.gitBranch).toBe('master*');
    // raw 仅一行(无 Weekly 行)、不含权限行
    expect(h!.raw).toContain('claude-opus-4-8');
    expect(h!.raw).not.toContain('Weekly');
    expect(h!.raw).not.toContain('⏵⏵');
  });

  it('无 HUD 状态行(无方括号首 token) → null', () => {
    expect(scrapeHud('just some chat text\n❯ \nno hud here')).toBeNull();
    expect(scrapeHud('')).toBeNull();
  });

  it('模型方括号无内层窗口标记 → model 全名、contextWindow undefined', () => {
    const pane = '  [claude-sonnet-4-7] ███░░░░░░░ 30% | proj git:(main)';
    const h = scrapeHud(pane);
    expect(h).not.toBeNull();
    expect(h!.model).toBe('claude-sonnet-4-7');
    expect(h!.contextWindow).toBeUndefined();
    expect(h!.contextPct).toBe(30);
    expect(h!.gitBranch).toBe('main');
  });

  it('夹杂杂行/换行仍能定位 HUD 行与紧随的 Weekly 行', () => {
    const pane = [
      '  some leftover assistant line',
      '✻ Cooked for 6s',
      '',
      '────────────────────',
      '  [claude-opus-4-8[1m]] ██░░░░░░░░ 19% | remote-cc git:(master*) | Usage █░░░░░░░░░ 14% (2h 19m / 5h)',
      '  Weekly █░░░░░░░░░ 14% (6d 3h / Weekly)',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const h = scrapeHud(pane);
    expect(h).not.toBeNull();
    expect(h!.model).toBe('claude-opus-4-8');
    expect(h!.fiveHour).toEqual({ pct: 14, text: '2h 19m / 5h' });
    expect(h!.weekly).toEqual({ pct: 14, text: '6d 3h / Weekly' });
  });

  it('Usage 段无括号文本(刚重置/无剩余)→ 仍取百分比、text 缺省', () => {
    // 线上实测变体:rcc-remote-cc-3ec40936 的 "Usage ▓ 16%" 后无 (…)
    const pane = [
      '  [claude-opus-4-8[1m]] ██░░░░░░░░ 13% | remote-cc git:(master) | Usage ██░░░░░░░░ 16%',
      '  Weekly █░░░░░░░░░ 3% (6d 11h / Weekly)',
    ].join('\n');
    const h = scrapeHud(pane);
    expect(h).not.toBeNull();
    expect(h!.fiveHour).toEqual({ pct: 16, text: undefined });
    expect(h!.weekly).toEqual({ pct: 3, text: '6d 11h / Weekly' });
  });

  it('只有 model+context、无 git、无 usage 也能解析', () => {
    const h = scrapeHud('  [claude-opus-4-8[200k]] █████░░░░░ 52%');
    expect(h).not.toBeNull();
    expect(h!.model).toBe('claude-opus-4-8');
    expect(h!.contextWindow).toBe('200k');
    expect(h!.contextPct).toBe(52);
    expect(h!.gitBranch).toBeUndefined();
    expect(h!.fiveHour).toBeUndefined();
  });
});
