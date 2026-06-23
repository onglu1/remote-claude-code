/**
 * 纯函数:把原生 AskUserQuestion TUI 的 capture-pane 文本解析成结构化菜单态。
 * 这是 ask 驱动的唯一脆弱点——隔离成纯函数 + 真实快照夹具单测,便于 claude 升级后适配。
 *
 * 实测形态(claude 2.1.141):选项带数字编号、❯ 光标,底部
 * "Enter to select · ↑/↓ to navigate · Esc to cancel";claude 会在用户选项后
 * 自动追加 "Type something." / "Chat about this"。
 *
 * 内容(问题/标题/描述)由 transcript tool_use 干净给出,这里只需 options/cursor/open
 * 供闭环导航,故刻意不解析问题文本(更稳)。
 */
import type { AskPending } from '@rcc/shared';

export interface AskOption {
  /** TUI 行内编号(1 起)。 */
  num: number;
  label: string;
}

export interface AskPickerState {
  open: boolean;
  options: AskOption[];
  /** 当前 ❯ 光标所在编号;未识别时回退首项。 */
  cursor: number;
}

const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
const FOOTER = /(Enter to select|↑\/↓ to navigate)/;

export function parseAskPicker(pane: string): AskPickerState {
  const lines = pane.replace(/\r/g, '').split('\n');
  const hasFooter = lines.some((l) => FOOTER.test(l));
  if (!hasFooter) return { open: false, options: [], cursor: 0 };

  const options: AskOption[] = [];
  let cursor = 0;
  for (const l of lines) {
    const m = OPTION.exec(l);
    if (!m) continue;
    const num = parseInt(m[2], 10);
    options.push({ num, label: m[3] });
    if (m[1]) cursor = num;
  }
  if (options.length === 0) return { open: false, options: [], cursor: 0 };
  if (cursor === 0) cursor = options[0].num;
  return { open: true, options, cursor };
}

const NAV = /to navigate/;
const CANCEL = /Esc to cancel/;
const ASK_AFFORDANCE = /Chat about this/i;
const REWIND_MARK = /(Restore the code|Confirm you want to restore)/;
const APPENDED = /^(Type something\.?|Chat about this)$/i;

/**
 * AskUserQuestion 专属签名检测(供实时待答用,区别于宽泛的 parseAskPicker):
 * 必含导航 footer(to navigate + Esc to cancel) + claude 特有词缀(Chat about this) +
 * ≥1 编号选项,且不含 rewind 标志——对 rewind/slash/权限提示等其他菜单零误判。
 * 追加项(Type something./Chat about this)不外露,真实卡片只含原始选项。
 */
export function parseAskPickerLive(pane: string): AskPending & { open: boolean } {
  const text = pane.replace(/\r/g, '');
  const lines = text.split('\n');
  const closed = { open: false as const, options: [], multiSelect: false };
  const hasNav = lines.some((l) => NAV.test(l)) && lines.some((l) => CANCEL.test(l));
  if (!hasNav || !ASK_AFFORDANCE.test(text) || REWIND_MARK.test(text)) return closed;
  const raw = parseAskPicker(pane);
  if (!raw.open || raw.options.length === 0) return closed;
  const cut = raw.options.findIndex((o) => APPENDED.test(o.label.trim()));
  const real = cut === -1 ? raw.options : raw.options.slice(0, cut);
  if (real.length === 0) return closed;
  const multiSelect = /Space/.test(text) || lines.some((l) => /[☐☑]/.test(l) && /\d+\.\s/.test(l));
  return { open: true, options: real.map((o, i) => ({ index: i, label: o.label })), multiSelect };
}
