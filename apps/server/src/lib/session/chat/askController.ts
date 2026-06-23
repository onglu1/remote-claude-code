/**
 * 闭环驱动原生 AskUserQuestion TUI 菜单的控制器:每步发按键后重抓屏校验光标,
 * 命中目标才发选择键;任何不确定即中止 + Esc 取消。
 * —— 对冲原生 remote-control 的"选择不回传"缺陷(#28508):靠重抓校验确认 TUI 真的前进。
 *
 * transcript 选项序号 i(0 起)→ TUI 编号 i+1(claude 在用户选项后追加额外项,顺序不变)。
 * 单选:导航到目标 → Enter。多选:对每个目标导航 → Space 切换,最后 Enter 确认。
 */
import { parseAskPicker } from './askScraper';
import type { AskPick } from '@rcc/shared';

export interface AskTmux {
  sendKeys(name: string, keys: string[]): Promise<void>;
  capturePaneVisible(name: string): Promise<string>;
}

export interface AskResult {
  ok: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AskController {
  constructor(
    private readonly name: string,
    private readonly tmux: AskTmux,
    private readonly opts: { settleMs?: number; maxSteps?: number } = {},
  ) {}

  private settle(): Promise<void> {
    return sleep(this.opts.settleMs ?? 250);
  }
  private async snap() {
    return parseAskPicker(await this.tmux.capturePaneVisible(this.name));
  }

  /** 按 picks 逐题作答(题序升序)。失败一律 Esc 中止,绝不在不确定时选择。 */
  async answer(picks: AskPick[]): Promise<AskResult> {
    const ordered = [...picks].sort((a, b) => a.questionIndex - b.questionIndex);
    for (let qi = 0; qi < ordered.length; qi++) {
      const s = await this.snap();
      if (!s.open) return qi === 0 ? this.abort('not-in-ask') : { ok: true }; // 后续题菜单已闭 = 已完成
      const targets = ordered[qi].optionIndices.map((i) => i + 1);
      if (targets.length === 0) return this.abort('empty-pick');

      if (targets.length === 1) {
        const nav = await this.navigateTo(targets[0]);
        if (!nav.ok) return nav;
        await this.tmux.sendKeys(this.name, ['Enter']);
      } else {
        for (const t of targets) {
          const nav = await this.navigateTo(t);
          if (!nav.ok) return nav;
          await this.tmux.sendKeys(this.name, ['Space']);
          await this.settle();
        }
        await this.tmux.sendKeys(this.name, ['Enter']); // 确认多选
      }
      await this.settle();
    }
    const final = await this.snap();
    return final.open ? this.abort('not-advanced') : { ok: true };
  }

  /**
   * 只作答当前屏这一题(逐题模型,供实时读屏卡片驱动)。失败不取消,留菜单给手动兜底。
   * 与 answer() 的区别:不做"后续题菜单仍开 → abort"判定(逐题下一题本就应留开)。
   */
  async answerCurrent(optionIndices: number[]): Promise<AskResult> {
    const s = await this.snap();
    if (!s.open) return { ok: false, error: 'not-in-ask' };
    const targets = optionIndices.map((i) => i + 1);
    if (targets.length === 0) return { ok: false, error: 'empty-pick' };
    if (targets.length === 1) {
      const nav = await this.navigateSoft(targets[0]);
      if (!nav.ok) return nav;
      await this.tmux.sendKeys(this.name, ['Enter']);
    } else {
      for (const t of targets) {
        const nav = await this.navigateSoft(t);
        if (!nav.ok) return nav;
        await this.tmux.sendKeys(this.name, ['Space']);
        await this.settle();
      }
      await this.tmux.sendKeys(this.name, ['Enter']);
    }
    await this.settle();
    return { ok: true };
  }

  /** 同 navigateTo 但失败只返回结果、不 Esc 取消(逐题/兜底场景)。 */
  private async navigateSoft(target: number): Promise<AskResult> {
    let s = await this.snap();
    if (!s.open) return { ok: false, error: 'menu-lost' };
    let guard = this.opts.maxSteps ?? 40;
    while (s.cursor !== target && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.cursor > target ? 'Up' : 'Down']);
      await this.settle();
      const before = s.cursor;
      s = await this.snap();
      if (!s.open) return { ok: false, error: 'menu-lost' };
      if (s.cursor === before) return { ok: false, error: 'cursor-stuck' };
    }
    if (s.cursor !== target) return { ok: false, error: 'unreachable' };
    return { ok: true };
  }

  /** 闭环把光标移到目标编号:每步重抓,光标不动/菜单消失即中止。 */
  private async navigateTo(target: number): Promise<AskResult> {
    let s = await this.snap();
    if (!s.open) return this.abort('menu-lost');
    let guard = this.opts.maxSteps ?? 40;
    while (s.cursor !== target && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.cursor > target ? 'Up' : 'Down']);
      await this.settle();
      const before = s.cursor;
      s = await this.snap();
      if (!s.open) return this.abort('menu-lost');
      if (s.cursor === before) return this.abort('cursor-stuck');
    }
    if (s.cursor !== target) return this.abort('unreachable');
    return { ok: true };
  }

  /** 取消:Esc 直到不在菜单。 */
  async cancel(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.tmux.sendKeys(this.name, ['Escape']);
      await this.settle();
      if (!(await this.snap()).open) return;
    }
  }

  private async abort(error: string): Promise<AskResult> {
    await this.cancel();
    return { ok: false, error };
  }
}
