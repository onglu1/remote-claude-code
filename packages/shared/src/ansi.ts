/**
 * 极简 ANSI SGR 解析：把含颜色转义的一行文本拆成带样式的文本段，供前端渲染成 <span>。
 * 只处理 `ESC [ ... m`（颜色/加粗），其余转义序列跳过。用于终端历史阅读层着色。
 * 不依赖任何库；颜色取标准 xterm 调色板，256/truecolor 计算为 rgb()。
 */
export interface AnsiSeg {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

// 标准 16 色（xterm 常见取值）。
const BASIC16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

function color256(n: number): string {
  if (n < 16) return BASIC16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const r = levels[Math.floor(i / 36) % 6];
  const g = levels[Math.floor(i / 6) % 6];
  const b = levels[i % 6];
  return `rgb(${r},${g},${b})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
}

function applyCodes(style: Style, codes: number[]): void {
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) {
      style.fg = undefined;
      style.bg = undefined;
      style.bold = false;
    } else if (c === 1) style.bold = true;
    else if (c === 22) style.bold = false;
    else if (c === 39) style.fg = undefined;
    else if (c === 49) style.bg = undefined;
    else if (c >= 30 && c <= 37) style.fg = BASIC16[c - 30];
    else if (c >= 90 && c <= 97) style.fg = BASIC16[8 + (c - 90)];
    else if (c >= 40 && c <= 47) style.bg = BASIC16[c - 40];
    else if (c >= 100 && c <= 107) style.bg = BASIC16[8 + (c - 100)];
    else if (c === 38 || c === 48) {
      const isFg = c === 38;
      const mode = codes[i + 1];
      if (mode === 5) {
        const col = color256(codes[i + 2] ?? 0);
        if (isFg) style.fg = col;
        else style.bg = col;
        i += 2;
      } else if (mode === 2) {
        const r = codes[i + 2] ?? 0;
        const g = codes[i + 3] ?? 0;
        const b = codes[i + 4] ?? 0;
        const col = `rgb(${r},${g},${b})`;
        if (isFg) style.fg = col;
        else style.bg = col;
        i += 4;
      }
    }
    // 其余 SGR(斜体/下划线等)忽略
  }
}

export function parseSgr(line: string): AnsiSeg[] {
  const segs: AnsiSeg[] = [];
  const style: Style = {};
  let buf = '';

  const flush = () => {
    if (buf === '') return;
    const seg: AnsiSeg = { text: buf };
    if (style.fg) seg.fg = style.fg;
    if (style.bg) seg.bg = style.bg;
    if (style.bold) seg.bold = true;
    segs.push(seg);
    buf = '';
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\x1b' && line[i + 1] === '[') {
      // 找到序列结束字母
      let j = i + 2;
      while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
      const final = line[j];
      const body = line.slice(i + 2, j);
      if (final === 'm') {
        flush();
        const codes = body === '' ? [0] : body.split(';').map((s) => parseInt(s, 10) || 0);
        applyCodes(style, codes);
      }
      // 非 m 结尾(清屏/光标等)：跳过整段，不输出
      i = j + 1;
    } else if (ch === '\x1b') {
      i += 1; // 落单的 ESC，跳过
    } else {
      buf += ch;
      i += 1;
    }
  }
  flush();
  return segs;
}

/**
 * 从终端数据流里滤掉「应用开启鼠标上报」的 DECSET 序列(1000/1001/1002/1003),
 * 让网页端 xterm 永不进入鼠标模式 → 点击/拖拽不会被转成鼠标转义发给会话。
 * 只摘掉鼠标号、保留同一序列里的其它模式(如备用屏 1049);不依赖任何库。
 * 注:不处理跨数据块切断的极端情况(开机时通常整块到达);滚轮另由 xterm 滚轮钩子兜底。
 */
const MOUSE_MODES = new Set(['1000', '1001', '1002', '1003']);
export function stripMouseTracking(data: string): string {
  return data.replace(/\x1b\[\?([0-9;]+)h/g, (whole, params: string) => {
    const parts = params.split(';');
    const kept = parts.filter((p) => !MOUSE_MODES.has(p));
    if (kept.length === parts.length) return whole; // 没有鼠标号,原样
    return kept.length ? `\x1b[?${kept.join(';')}h` : '';
  });
}
