/**
 * 闭环驱动原生 `/rewind` TUI 的控制器：每步发按键后都重抓屏校验光标，
 * 双校验（目标行已选中 且 目标模式已高亮）通过才发执行键；任何不确定即中止 + Esc。
 * —— 错回退会丢工作，宁可失败重来，绝不在不确定时按下执行键。
 */
import type { RewindItem, RewindMode } from '@rcc/shared';
import { parseRewindPicker } from './rewindScraper';

/** 控制器只需 tmux 的这组能力（便于注入 fake 测试）。 */
export interface RewindTmux {
  sendKeys(name: string, keys: string[]): Promise<void>;
  pasteText(name: string, text: string): Promise<void>;
  capturePaneVisible(name: string): Promise<string>;
}

export interface RewindResult {
  ok: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RewindController {
  constructor(
    private readonly name: string,
    private readonly tmux: RewindTmux,
    private readonly opts: { settleMs?: number; maxSteps?: number; openTries?: number } = {},
  ) {}

  private settle(): Promise<void> {
    return sleep(this.opts.settleMs ?? 300);
  }
  private async snap() {
    return parseRewindPicker(await this.tmux.capturePaneVisible(this.name));
  }

  /** 打开 picker：清空 composer → /rewind → 轮询直到列表就绪。 */
  async open(): Promise<{ items: RewindItem[] }> {
    await this.tmux.sendKeys(this.name, ['C-u']);
    await this.tmux.pasteText(this.name, '/rewind');
    await this.tmux.sendKeys(this.name, ['Enter']);
    for (let i = 0; i < (this.opts.openTries ?? 20); i++) {
      await this.settle();
      const s = await this.snap();
      if (s.open && s.stage === 'list') return { items: s.items };
    }
    throw new Error('rewind picker 未能打开');
  }

  /**
   * 执行回退到第 index 个 checkpoint、用 mode 模式。闭环导航 + 双校验。
   * 失败一律中止并 Esc 退出 picker，绝不在不确定时执行。
   */
  async execute(index: number, mode: RewindMode): Promise<RewindResult> {
    let s = await this.snap();
    if (!(s.open && s.stage === 'list')) return this.abort('not-in-list');

    // 阶段一：列表光标 → index
    let guard = this.opts.maxSteps ?? 40;
    while (s.cursor !== index && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.cursor > index ? 'Up' : 'Down']);
      await this.settle();
      const before = s.cursor;
      s = await this.snap();
      if (s.stage !== 'list') return this.abort('list-stage-lost');
      if (s.cursor === before) return this.abort('list-cursor-stuck');
    }
    if (s.cursor !== index) return this.abort('list-unreachable');

    // 进入模式菜单
    await this.tmux.sendKeys(this.name, ['Enter']);
    await this.settle();
    s = await this.snap();
    if (s.stage !== 'mode') return this.abort('mode-not-shown');

    // 用刮屏得到的「模式→编号」映射定位目标编号（稳健于原生选项重排）
    const target = s.modeOptions?.find((o) => o.mode === mode)?.num;
    if (target === undefined) return this.abort('mode-option-missing');

    // 阶段二：模式光标 → target
    guard = this.opts.maxSteps ?? 40;
    while (s.modeCursor !== target && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.modeCursor > target ? 'Up' : 'Down']);
      await this.settle();
      const before = s.modeCursor;
      s = await this.snap();
      if (s.stage !== 'mode') return this.abort('mode-stage-lost');
      if (s.modeCursor === before) return this.abort('mode-cursor-stuck');
    }
    if (s.modeCursor !== target) return this.abort('mode-unreachable');

    // 双校验通过 → 执行
    await this.tmux.sendKeys(this.name, ['Enter']);
    await this.settle();
    return { ok: true };
  }

  /** 关闭 picker（Esc，最多几次直到不在 picker）。 */
  async cancel(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.tmux.sendKeys(this.name, ['Escape']);
      await this.settle();
      if (!(await this.snap()).open) return;
    }
  }

  private async abort(error: string): Promise<RewindResult> {
    await this.cancel();
    return { ok: false, error };
  }
}
