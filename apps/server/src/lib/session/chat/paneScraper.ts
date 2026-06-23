/**
 * 从 tmux capture-pane 的纯文本里剥掉 Claude Code TUI 的 chrome，
 * 抽出"在生成中的助手正文"做逐字流式预览，并给出 spinner/done 信号。
 *
 * 仅用于过渡预览：消息一旦完成，前端会用 transcript 的干净版覆盖它，
 * 所以这里"足够好"即可，不追求完美解析。
 */

export interface PaneScrape {
  /** 抽出的助手正文（已去 chrome、去 bullet/缩进）。无正文时为 ''。 */
  preview: string;
  /** 是否检测到运行 spinner（如 "✽ Slithering…"）。 */
  spinner: boolean;
  /** 是否检测到完成行（如 "✻ Cooked for 6s"）。 */
  done: boolean;
}

const RULE = /^[─]{20,}$/; // ─────…（≥20）
const PROMPT = /^❯/; // ❯
const WELCOME_TOP = /^╭.*Claude Code/; // ╭─── Claude Code …
const WELCOME_BOT = /^╰/; // ╰───…
const BULLET = /^[●⏺]\s/; // "● " / "⏺ "
const STAR = '[\\u2735\\u273B\\u273D\\u2736\\u2737\\u2738\\u2739\\u273A\\u2733\\u2734\\u2722\\u2723\\u2724\\u2725\\u2726\\u2727\\u00B7\\u2217]';
const SPINNER_LINE = new RegExp(`^${STAR}\\s.*\\u2026\\s*$`); // 星形 + … 结尾
const DONE_LINE = new RegExp(`^${STAR}\\s.*\\bfor\\s+\\d+s\\b`); // 星形 + "for Ns"

function isStatusOrPerms(line: string): boolean {
  const t = line.trimStart();
  // 状态行 "[model] ░░ 3% | …"、权限行 "⏵⏵ …"、"Weekly …"
  return /^\[[^\]]*\]\s/.test(t) || t.startsWith('⏵⏵') || /^Weekly\b/.test(t);
}

/** 去掉顶部欢迎框（╭…Claude Code … 到 ╰…）。 */
function dropWelcome(lines: string[]): string[] {
  const top = lines.findIndex((l) => WELCOME_TOP.test(l.trimEnd()));
  if (top === -1) return lines;
  for (let i = top; i < lines.length; i++) {
    if (WELCOME_BOT.test(lines[i].trimEnd())) {
      return [...lines.slice(0, top), ...lines.slice(i + 1)];
    }
  }
  return lines;
}

/**
 * 找底部输入框的起点并截断：输入框形如 rule / "❯ …" / rule。
 * 取最后一个满足 [i]=rule, [i+1]=❯…, [i+2]=rule 的 i，从 i 起全部丢弃。
 * 找不到则退化为"最后一条 rule 起截断"。
 */
function dropInputBox(lines: string[]): string[] {
  const isRule = (s: string) => RULE.test(s.trimEnd());
  for (let i = lines.length - 3; i >= 0; i--) {
    if (isRule(lines[i]) && PROMPT.test(lines[i + 1].trimEnd()) && isRule(lines[i + 2])) {
      return lines.slice(0, i);
    }
  }
  let lastRule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRule(lines[i])) {
      lastRule = i;
      break;
    }
  }
  return lastRule === -1 ? lines : lines.slice(0, lastRule);
}

export function scrapePane(pane: string): PaneScrape {
  const raw = pane.replace(/\r/g, '').split('\n');
  let lines = dropWelcome(raw);
  lines = dropInputBox(lines);

  let spinner = false;
  let done = false;
  for (const l of lines) {
    const t = l.trimEnd();
    if (SPINNER_LINE.test(t)) spinner = true;
    if (DONE_LINE.test(t)) done = true;
  }

  // 只取"最新一轮"的助手正文：从最后一个用户回显(❯)之后的第一条 bullet 开始，
  // 避免把上一轮回复或刚发出的用户文字卷进预览。若可见屏里已无 ❯(长回复把回显
  // 顶出屏幕)，退化为从第一条 bullet 开始。
  let lastPrompt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (PROMPT.test(lines[i].trimEnd())) lastPrompt = i;
  }
  let start = -1;
  for (let i = lastPrompt + 1; i < lines.length; i++) {
    if (BULLET.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return { preview: '', spinner, done };

  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trimEnd();
    if (SPINNER_LINE.test(t) || DONE_LINE.test(t) || isStatusOrPerms(l) || RULE.test(t)) continue;
    if (BULLET.test(l)) out.push(l.replace(BULLET, ''));
    else out.push(l.replace(/^ {1,2}/, ''));
  }
  return { preview: out.join('\n').trim(), spinner, done };
}
