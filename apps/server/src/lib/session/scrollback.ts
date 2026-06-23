/**
 * 终端历史阅读层的纯窗口换算。把「显示下标(0=最旧)」窗口映射到 tmux capture-pane 的 -S/-E 行号。
 *
 * 实测语义(见 docs/superpowers/specs/2026-06-21-terminal-native-scroll-copy-design.md)：
 *   T = historySize + paneHeight；显示下标 d → tmux 行号 L = d - historySize；
 *   最旧行 -historySize，最底行 paneHeight-1；capture -S -<H> -E <P-1> 取全部 T 行。
 *
 * 显示下标对「实时追加」稳定：新行把旧行上推时 L 减 1、historySize 加 1，d=L+H 不变。
 */
export interface WindowInput {
  historySize: number; // tmux #{history_size}
  paneHeight: number; // tmux #{pane_height}
  before: number | null; // 本次取数的「排他上界」显示下标；null=最新一窗
  limit: number; // 一窗最多行数
}

export interface WindowResult {
  startLine: number; // tmux -S
  endLine: number; // tmux -E
  nextBefore: number; // 本窗下界 = 下一更早窗的游标
  atTop: boolean; // 已到最旧
  empty: boolean; // 无内容可取
}

export function computeWindow(input: WindowInput): WindowResult {
  const H = Math.max(0, Math.floor(input.historySize));
  const P = Math.max(1, Math.floor(input.paneHeight));
  const total = H + P;
  const limit = Math.max(1, Math.floor(input.limit));
  const hiRaw = input.before == null ? total : Math.floor(input.before);
  const hi = Math.min(Math.max(hiRaw, 0), total);
  const lo = Math.max(0, hi - limit);
  const empty = hi <= 0 || hi <= lo;
  return {
    startLine: lo - H,
    endLine: hi - 1 - H,
    nextBefore: lo,
    atTop: lo === 0,
    empty,
  };
}
