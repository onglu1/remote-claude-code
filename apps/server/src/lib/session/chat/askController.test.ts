import { describe, it, expect } from 'vitest';
import { AskController, type AskTmux } from './askController';

const OPTS = [
  { num: 1, label: 'Apple' },
  { num: 2, label: 'Banana' },
  { num: 3, label: 'Type something.' },
  { num: 4, label: 'Chat about this' },
];

/** 单选 fake:Down/Up 移动光标,Enter 选中并关闭,Escape 取消关闭。 */
class SingleAskTmux implements AskTmux {
  cursor = 1;
  open = true;
  selected: number | null = null;
  keys: string[] = [];
  constructor(init?: Partial<SingleAskTmux>) {
    Object.assign(this, init);
  }
  async sendKeys(_n: string, keys: string[]): Promise<void> {
    this.keys.push(...keys);
    for (const k of keys) {
      if (!this.open) continue;
      if (k === 'Down') this.cursor = Math.min(OPTS.length, this.cursor + 1);
      else if (k === 'Up') this.cursor = Math.max(1, this.cursor - 1);
      else if (k === 'Enter') {
        this.selected = this.cursor;
        this.open = false;
      } else if (k === 'Escape') this.open = false;
    }
  }
  async capturePaneVisible(): Promise<string> {
    if (!this.open) return 'done\n❯ \n';
    return ['Pick a fruit', '', ...OPTS.map((o) => `${o.num === this.cursor ? '❯' : ' '} ${o.num}. ${o.label}`), 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
  }
}

/** 多选 fake:Space 切换选中集,Enter 确认关闭。 */
class MultiAskTmux implements AskTmux {
  cursor = 1;
  open = true;
  toggled = new Set<number>();
  keys: string[] = [];
  async sendKeys(_n: string, keys: string[]): Promise<void> {
    this.keys.push(...keys);
    for (const k of keys) {
      if (!this.open) continue;
      if (k === 'Down') this.cursor = Math.min(OPTS.length, this.cursor + 1);
      else if (k === 'Up') this.cursor = Math.max(1, this.cursor - 1);
      else if (k === 'Space') this.toggled.has(this.cursor) ? this.toggled.delete(this.cursor) : this.toggled.add(this.cursor);
      else if (k === 'Enter') this.open = false;
      else if (k === 'Escape') this.open = false;
    }
  }
  async capturePaneVisible(): Promise<string> {
    if (!this.open) return 'done\n❯ \n';
    return ['Pick fruits', '', ...OPTS.map((o) => `${o.num === this.cursor ? '❯' : ' '} ${o.num}. ${o.label}`), 'Space to select · Enter to confirm · ↑/↓ to navigate'].join('\n');
  }
}

describe('AskController.answer', () => {
  it('单选:导航到目标(Banana=编号2)并 Enter,菜单关闭 → ok', async () => {
    const tmux = new SingleAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answer([{ questionIndex: 0, optionIndices: [1] }]);
    expect(r.ok).toBe(true);
    expect(tmux.selected).toBe(2);
  });

  it('单选:已在目标项(Apple=编号1)直接 Enter,不移动', async () => {
    const tmux = new SingleAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answer([{ questionIndex: 0, optionIndices: [0] }]);
    expect(r.ok).toBe(true);
    expect(tmux.selected).toBe(1);
    expect(tmux.keys.filter((k) => k === 'Up' || k === 'Down')).toHaveLength(0);
  });

  it('菜单不在 → abort(ok=false)并发 Esc', async () => {
    const tmux = new SingleAskTmux({ open: false });
    const r = await new AskController('s', tmux, { settleMs: 0 }).answer([{ questionIndex: 0, optionIndices: [0] }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not-in-ask');
  });

  it('多选:对每个目标 Space 切换后 Enter 确认 → ok', async () => {
    const tmux = new MultiAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answer([{ questionIndex: 0, optionIndices: [0, 2] }]);
    expect(r.ok).toBe(true);
    expect([...tmux.toggled].sort()).toEqual([1, 3]); // 编号 1、3
  });
});

describe('AskController.answerCurrent（逐题、失败不取消）', () => {
  it('单选:导航到目标(Banana=编号2)并 Enter → ok', async () => {
    const tmux = new SingleAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answerCurrent([1]);
    expect(r.ok).toBe(true);
    expect(tmux.selected).toBe(2);
  });

  it('菜单已关 → 失败且不发 Esc(不取消)', async () => {
    const tmux = new SingleAskTmux({ open: false });
    const r = await new AskController('s', tmux, { settleMs: 0 }).answerCurrent([0]);
    expect(r.ok).toBe(false);
    expect(tmux.keys).not.toContain('Escape');
  });

  it('多选:Space×n + Enter → ok', async () => {
    const tmux = new MultiAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answerCurrent([0, 2]);
    expect(r.ok).toBe(true);
    expect([...tmux.toggled].sort()).toEqual([1, 3]);
  });

  it('空选 → 失败且不发 Esc', async () => {
    const tmux = new SingleAskTmux();
    const r = await new AskController('s', tmux, { settleMs: 0 }).answerCurrent([]);
    expect(r.ok).toBe(false);
    expect(tmux.keys).not.toContain('Escape');
  });
});
