/**
 * AskUserQuestion 作答驱动：用「绝对数字键」选项。数字键按编号选定、一次按键原子提交、
 * 不受光标位置影响（已真机验证）——故人工挪动光标也不会「点歪」，对 AI 作答安全。
 *
 * 安全闸（guard，默认开）：发键前抓一次屏，仅断言「存在 `i+1. <hook 给的精确 label>` 行」。
 * 命中才发键；对不上即返回 fallback，让上层转既有 AskController（不瞎按）。
 * 这与「解析整个菜单结构」不同：只验证一个已知串在场，光标怎么动行号都不变。
 *
 * 兜底：多选 / 一次选多项 / 选项 >9（数字键不够用）→ 返回 fallback，由上层用 AskController。
 * 作答「是否成功」不在此判定——由上层经 sidecar 消失（PostToolUse）确认，避免读屏判菜单关闭。
 */
export interface AskDriverTmux {
  capturePaneVisible(name: string): Promise<string>;
  sendLiteralKeys(name: string, text: string): Promise<void>;
  sendKeys(name: string, keys: string[]): Promise<void>;
}

export interface AskDriverResult {
  ok: boolean;
  /** 该场景数字键不适用，请上层转 AskController（读屏箭头导航）。 */
  fallback?: boolean;
  error?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 屏上是否存在「<num>. <label>」这一选项行（num 1 起）。 */
function optionLinePresent(pane: string, num: number, label: string): boolean {
  const re = new RegExp(`^\\s*❯?\\s*${num}\\.\\s+${escapeRegExp(label.trim())}\\s*$`, 'm');
  return re.test(pane.replace(/\r/g, ''));
}

export class AskDriver {
  constructor(
    private readonly name: string,
    private readonly tmux: AskDriverTmux,
    private readonly opts: { guard?: boolean } = {},
  ) {}

  /** 作答当前屏这一题。返回 {ok} 或 {fallback} 让上层兜底。 */
  async answer(options: { label: string }[], optionIndices: number[], multiSelect: boolean): Promise<AskDriverResult> {
    // 多选 / 一次选多项：本驱动只做「单选绝对数字键」这一条最稳的路径，
    // 多选刻意**统一降级**到既有 AskController（读屏箭头 + Space + 逐步重抓校验），
    // 比 spec 草图里「逐项数字键 toggle」更保守、也不必单独实现一条 toggle 路径。
    if (multiSelect || optionIndices.length !== 1) return { ok: false, fallback: true };
    const index = optionIndices[0];
    const num = index + 1;
    // >9 项：单字符数字键不够用 → 兜底。
    if (num > 9) return { ok: false, fallback: true };
    const label = options[index]?.label ?? '';

    const guard = this.opts.guard ?? true;
    if (guard) {
      const pane = await this.tmux.capturePaneVisible(this.name);
      if (!optionLinePresent(pane, num, label)) return { ok: false, fallback: true };
    }
    await this.tmux.sendLiteralKeys(this.name, String(num));
    return { ok: true };
  }
}
