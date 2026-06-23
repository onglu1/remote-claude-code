/**
 * 纯函数：把原生 `/rewind` TUI 的 capture-pane 文本解析成结构化状态。
 * 这是 rewind 的唯一脆弱点——隔离成纯函数 + spike fixture 单测，便于 claude 升级后适配。
 */
import type { RewindItem, RewindMode } from '@rcc/shared';

export interface RewindPickerState {
  open: boolean;
  stage: 'list' | 'mode' | 'none';
  /** 列表阶段的可回退点。 */
  items: RewindItem[];
  /** 列表阶段光标：0..items.length（== items.length 表示停在 (current)）。 */
  cursor: number;
  /** 模式阶段光标：原生编号 1..5；0 表示未识别。 */
  modeCursor: number;
  /** 模式阶段：可见标签推断出的 编号→恢复模式 映射（供控制器稳健定位）。 */
  modeOptions?: { num: number; mode: RewindMode }[];
  /** 模式阶段：代码影响文案（"...restored -1 in x." / "...unchanged."）。 */
  codeEffect?: string;
}

const CURSOR = '❯';
const LIST_SUBTITLE = /Restore the code and\/or conversation/;
const MODE_TITLE = /Confirm you want to restore/;
const LIST_FOOTER = /Enter to continue/;
const MODE_LINE = /^\s*[❯↓]?\s*(\d+)\.\s+(.+?)\s*$/;

// 注意顺序：先匹配最长的 "code and conversation"，否则会被 "code" 误命中。
const MODE_LABEL: { re: RegExp; mode: RewindMode }[] = [
  { re: /restore code and conversation/i, mode: 'both' },
  { re: /restore conversation/i, mode: 'conversation' },
  { re: /restore code/i, mode: 'code' },
];

function stripCursor(line: string): string {
  return line.replace(/^\s*[❯↓]?\s*/, '').trimEnd();
}

export function parseRewindPicker(pane: string): RewindPickerState {
  const lines = pane.replace(/\r/g, '').split('\n');
  if (lines.some((l) => MODE_TITLE.test(l))) return parseMode(lines);
  if (lines.some((l) => LIST_SUBTITLE.test(l))) return parseList(lines);
  return { open: false, stage: 'none', items: [], cursor: 0, modeCursor: 0 };
}

function parseList(lines: string[]): RewindPickerState {
  const start = lines.findIndex((l) => LIST_SUBTITLE.test(l));
  let end = lines.findIndex((l) => LIST_FOOTER.test(l));
  if (end === -1) end = lines.length;
  const region = lines.slice(start + 1, end);

  // 按空行分组：一组 = 连续非空行。checkpoint 组 = [label 行(可换行)..., 改动行]；
  // 另有单独的 "(current)" 组。
  const groups: string[][] = [];
  let buf: string[] = [];
  for (const l of region) {
    if (l.trim() === '') {
      if (buf.length) {
        groups.push(buf);
        buf = [];
      }
    } else buf.push(l);
  }
  if (buf.length) groups.push(buf);

  const items: RewindItem[] = [];
  let cursor = -1;
  for (const g of groups) {
    const hasCursor = g.some((l) => l.includes(CURSOR));
    const stripped = g.map(stripCursor);
    if (stripped.some((s) => /^\(current\)/.test(s))) {
      if (hasCursor) cursor = items.length; // 光标停在 (current)
      continue;
    }
    const changes = stripped[stripped.length - 1] ?? '';
    const label = stripped.slice(0, -1).join(' ').trim();
    const index = items.length;
    items.push({ index, label, changes });
    if (hasCursor) cursor = index;
  }
  if (cursor === -1) cursor = items.length; // 兜底：当作停在 (current)
  return { open: true, stage: 'list', items, cursor, modeCursor: 0 };
}

function parseMode(lines: string[]): RewindPickerState {
  let modeCursor = 0;
  let codeEffect: string | undefined;
  const modeOptions: { num: number; mode: RewindMode }[] = [];
  for (const l of lines) {
    if (/The code will be/.test(l)) codeEffect = l.trim();
    const m = MODE_LINE.exec(l);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const hit = MODE_LABEL.find((x) => x.re.test(m[2]));
    if (hit) modeOptions.push({ num, mode: hit.mode });
    if (l.includes(CURSOR)) modeCursor = num;
  }
  return { open: true, stage: 'mode', items: [], cursor: 0, modeCursor, modeOptions, codeEffect };
}
