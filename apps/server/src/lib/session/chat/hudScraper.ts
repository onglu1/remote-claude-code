/**
 * 纯函数:从 tmux capture-pane 的整屏文本里解析用户 statusLine(claude-hud)
 * 渲染的 HUD 状态行,抽出模型/上下文/5h 限额/周限额等结构化字段供聊天界面顶部展示。
 *
 * 这是另一条独立解析(与 paneScraper 的流式预览互不影响):复用 ChatSession.tick()
 * 已抓的同一份 pane,不新增 tmux 调用、不读 claude-hud 配置。
 *
 * 真实格式(claude-hud,2026-06-21 实测):
 *   [claude-opus-4-8[1m]] ██░░ 19% | remote-cc git:(master*) | Usage █░░ 14% (2h 19m / 5h)
 *   Weekly █░░ 14% (6d 3h / Weekly)
 * 其中尾部 [1m]/[200k] 是上下文窗口大小标记,从模型名里拆出。
 * usage(Usage 段 + Weekly 行)仅订阅账号才有;API 用户/无订阅 → 缺失,正常,不显示。
 *
 * 全字段可选+容错:解析不到就不带该字段;保留清洗后的 raw(去权限行)作兜底镜像。
 */
import type { Hud } from '@rcc/shared';

/** HUD 首行:trim 后以 "[" 开头(statusLine 首 token 恒为 [model])。 */
const HUD_HEAD = /^\s*\[/;
/** 模型方括号:捕获内层窗口标记(可选)与方括号后第一个 NN%。 */
const MODEL = /\[([^\]]*?)(?:\[([^\]]+)\])?\]\s*[^%]*?(\d+)%/;
const GIT = /git:\(([^)]+)\)/;
/** Usage 段:Usage … NN% (… )。括号文本可缺(刚重置/无剩余时显示)→ 仍取百分比。 */
const USAGE = /Usage\s+[^%]*?(\d+)%\s*(?:\(([^)]+)\))?/;
/** Weekly 行:Weekly … NN% (… )。括号文本同样可缺。 */
const WEEKLY = /^\s*Weekly\b[^%]*?(\d+)%\s*(?:\(([^)]+)\))?/;

/**
 * 解析整屏文本为 Hud;无 HUD 状态行(无方括号首 token)→ null。
 */
export function scrapeHud(pane: string): Hud | null {
  const lines = pane.replace(/\r/g, '').split('\n');
  // 取最后一条「trim 后以 [ 开头且能匹配 [model] … NN%」的行作为 HUD 首行
  // (最后一条:状态行恒在底部,避免误吃正文里靠上的方括号)。
  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HUD_HEAD.test(lines[i]) && MODEL.test(lines[i])) {
      headIdx = i;
      break;
    }
  }
  if (headIdx === -1) return null;

  const head = lines[headIdx];
  const hud: Hud = { raw: '' };

  const m = MODEL.exec(head);
  if (m) {
    hud.model = m[1].trim();
    if (m[2]) hud.contextWindow = m[2].trim();
    hud.contextPct = parseInt(m[3], 10);
  }

  const g = GIT.exec(head);
  if (g) hud.gitBranch = g[1];

  const u = USAGE.exec(head);
  if (u) hud.fiveHour = { pct: parseInt(u[1], 10), text: u[2]?.trim() };

  // 紧随 HUD 首行之后找 Weekly 行(允许中间有杂行,向后扫描数行)。
  const rawLines = [stripBars(head)];
  for (let i = headIdx + 1; i < lines.length && i <= headIdx + 3; i++) {
    const w = WEEKLY.exec(lines[i]);
    if (w) {
      hud.weekly = { pct: parseInt(w[1], 10), text: w[2]?.trim() };
      rawLines.push(stripBars(lines[i]));
      break;
    }
  }

  hud.raw = rawLines.join('\n').trim();
  return hud;
}

/** 把进度条字符压成单个标记,raw 更可读但仍忠实(保留百分比/文本)。 */
function stripBars(line: string): string {
  return line.replace(/[█░]+/g, '▓').trim();
}
