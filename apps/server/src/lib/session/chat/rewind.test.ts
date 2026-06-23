import { describe, it, expect } from 'vitest';
import { RewindController, type RewindTmux } from './rewind';

const MODE_LABELS: Record<number, string> = {
  1: 'Restore code and conversation',
  2: 'Restore conversation',
  3: 'Restore code',
  4: 'Summarize from here',
  5: 'Summarize up to here',
};

/** 会渲染真实 picker 文本的 fake，让控制器走真·刮屏闭环（搭配真 parseRewindPicker）。 */
class FakePicker implements RewindTmux {
  stage: 'closed' | 'list' | 'mode' | 'done' = 'closed';
  listCursor: number; // 0..items（== items 表示 current）
  modeCursor = 1;
  keys: string[] = [];
  private pendingOpen = false;
  constructor(
    public items: number,
    listCursor = items,
    private readonly opts: { freezeList?: boolean } = {},
  ) {
    this.listCursor = listCursor;
  }

  async pasteText(_n: string, t: string): Promise<void> {
    if (t === '/rewind') this.pendingOpen = true;
  }

  async sendKeys(_n: string, ks: string[]): Promise<void> {
    for (const k of ks) {
      this.keys.push(k);
      if (this.stage === 'closed') {
        if (k === 'Enter' && this.pendingOpen) {
          this.stage = 'list';
          this.pendingOpen = false;
        }
      } else if (this.stage === 'list') {
        if (k === 'Up' && !this.opts.freezeList) this.listCursor = Math.max(0, this.listCursor - 1);
        else if (k === 'Down' && !this.opts.freezeList) this.listCursor = Math.min(this.items, this.listCursor + 1);
        else if (k === 'Enter') this.stage = 'mode';
        else if (k === 'Escape') this.stage = 'closed';
      } else if (this.stage === 'mode') {
        if (k === 'Up') this.modeCursor = Math.max(1, this.modeCursor - 1);
        else if (k === 'Down') this.modeCursor = Math.min(5, this.modeCursor + 1);
        else if (k === 'Enter') this.stage = 'done';
        else if (k === 'Escape') this.stage = 'list';
      }
    }
  }

  async capturePaneVisible(): Promise<string> {
    if (this.stage === 'list') return this.renderList();
    if (this.stage === 'mode') return this.renderMode();
    return '❯ \n  ⏵⏵ bypass permissions on';
  }

  private renderList(): string {
    const out = ['  Rewind', '', '  Restore the code and/or conversation to the point before…', ''];
    for (let i = 0; i < this.items; i++) {
      out.push(`${this.listCursor === i ? '  ❯ ' : '    '}Prompt ${i}`);
      out.push('    file.txt +1');
      out.push('');
    }
    out.push(`${this.listCursor === this.items ? '  ❯ ' : '    '}(current)`);
    out.push('', '  Enter to continue · Esc to cancel');
    return out.join('\n');
  }

  private renderMode(): string {
    const out = [
      '  Rewind',
      '',
      '  Confirm you want to restore to the point before you sent this message:',
      '',
      '  │ Prompt',
      '  │ (1s ago)',
      '',
      '  The conversation will be forked.',
      '  The code will be unchanged.',
      '',
    ];
    for (let n = 1; n <= 5; n++) out.push(`${this.modeCursor === n ? '  ❯ ' : '    '}${n}. ${MODE_LABELS[n]}`);
    out.push('', '  ⚠ Rewinding does not affect files edited manually or via bash.');
    return out.join('\n');
  }
}

const ctrl = (fake: FakePicker) => new RewindController('sess', fake, { settleMs: 0 });

describe('RewindController', () => {
  it('open 发 /rewind 并返回 items', async () => {
    const fake = new FakePicker(2);
    const items = (await ctrl(fake).open()).items;
    expect(items).toHaveLength(2);
    expect(fake.keys).toContain('C-u'); // 先清空 composer
  });

  it('execute(0, conversation)：导航到 item0 + 选项2，双校验后执行', async () => {
    const fake = new FakePicker(2, 2); // 光标初始停在 (current)=2
    fake.stage = 'list'; // 模拟 open() 之后
    const r = await ctrl(fake).execute(0, 'conversation');
    expect(r.ok).toBe(true);
    expect(fake.stage).toBe('done'); // 最终 Enter 执行
    // 列表阶段从 2 → 0：两次 Up；模式阶段从 1 → 2：一次 Down
    expect(fake.keys.filter((k) => k === 'Up')).toHaveLength(2);
    expect(fake.keys.filter((k) => k === 'Down')).toHaveLength(1);
  });

  it('execute(1, both)：item1 + 选项1（光标已在1，无需移动模式）', async () => {
    const fake = new FakePicker(2, 2);
    fake.stage = 'list'; // 模拟 open() 之后
    const r = await ctrl(fake).execute(1, 'both');
    expect(r.ok).toBe(true);
    expect(fake.keys.filter((k) => k === 'Up')).toHaveLength(1); // 2→1
  });

  it('列表光标卡住 → 中止且发 Esc，不执行', async () => {
    const fake = new FakePicker(2, 2, { freezeList: true });
    fake.stage = 'list'; // 模拟 open() 之后
    const r = await ctrl(fake).execute(0, 'conversation');
    expect(r.ok).toBe(false);
    expect(fake.keys).toContain('Escape');
    expect(fake.stage).not.toBe('done');
  });
});
