import { describe, it, expect, vi } from 'vitest';
import { AskDriver, type AskDriverTmux } from './askDriver';

const NAME = 'rcc-x';
const MENU = [
  'Pick a fruit',
  '',
  '❯ 1. Apple',
  '     苹果',
  '  2. Banana',
  '     香蕉',
  '  3. Cherry',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

function fakeTmux(pane = MENU): AskDriverTmux & {
  literal: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
} {
  const literal = vi.fn(async () => {});
  const keys = vi.fn(async () => {});
  return {
    literal,
    keys,
    capturePaneVisible: async () => pane,
    sendLiteralKeys: literal,
    sendKeys: keys,
  };
}

const OPTS = [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }];

describe('AskDriver.answer 单选绝对数字键', () => {
  it('guard 关：发字面量数字键 index+1、ok', async () => {
    const t = fakeTmux();
    const d = new AskDriver(NAME, t, { guard: false });
    const r = await d.answer(OPTS, [2], false);
    expect(r).toEqual({ ok: true });
    expect(t.literal).toHaveBeenCalledWith(NAME, '3');
  });

  it('guard 开且屏上有 "3. Cherry"：发 "3"、ok', async () => {
    const t = fakeTmux();
    const d = new AskDriver(NAME, t, { guard: true });
    const r = await d.answer(OPTS, [2], false);
    expect(r.ok).toBe(true);
    expect(t.literal).toHaveBeenCalledWith(NAME, '3');
  });

  it('guard 开但屏上无对应行：不发键、fallback', async () => {
    const t = fakeTmux('完全不相干的屏幕内容');
    const d = new AskDriver(NAME, t, { guard: true });
    const r = await d.answer(OPTS, [2], false);
    expect(r.fallback).toBe(true);
    expect(t.literal).not.toHaveBeenCalled();
  });
});

describe('AskDriver.answer 兜底场景', () => {
  it('多选 → fallback、不发键', async () => {
    const t = fakeTmux();
    const d = new AskDriver(NAME, t, { guard: false });
    const r = await d.answer(OPTS, [0, 2], true);
    expect(r.fallback).toBe(true);
    expect(t.literal).not.toHaveBeenCalled();
  });

  it('单选但选了多个 index → fallback', async () => {
    const t = fakeTmux();
    const d = new AskDriver(NAME, t, { guard: false });
    const r = await d.answer(OPTS, [0, 1], false);
    expect(r.fallback).toBe(true);
  });

  it('index+1 > 9（两位数）→ fallback', async () => {
    const t = fakeTmux();
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `O${i}` }));
    const d = new AskDriver(NAME, t, { guard: false });
    const r = await d.answer(many, [9], false);
    expect(r.fallback).toBe(true);
    expect(t.literal).not.toHaveBeenCalled();
  });
});
