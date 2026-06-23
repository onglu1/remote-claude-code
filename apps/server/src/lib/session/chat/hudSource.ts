/**
 * 纯函数：聊天 HUD 的「不依赖 claude-hud」数据源。
 *
 * 真正的数据源是 Claude Code 喂给 statusLine 命令的 stdin JSON（claude-hud 只是格式化器）。
 * remote-cc 的捕获脚本（scripts/rcc-statusline.mjs）把该 JSON 按会话落到 sidecar 文件，
 * 这里负责把 sidecar 内容 / transcript usage / 读屏 pane 三种来源解析、推算、合并成统一 Hud。
 *
 * 全部纯函数 + 注入 IO，便于单测；任何环境只要 remote-cc 配好就能用，与 claude-hud 无关。
 */
import type { Hud, HudUsage } from '@rcc/shared';

/** 把 resets_at（秒级 epoch）算成相对 now（秒）的倒计时字符串。已过期/当下 → "now"。 */
export function formatResetCountdown(resetsAtSec: number, nowSec: number): string {
  const diff = Math.floor(resetsAtSec - nowSec);
  if (!Number.isFinite(diff) || diff <= 0) return 'now';
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** 上下文窗口 token 数 → 标记（1m / 200k）。其它值原样按 k 估。 */
function windowLabel(size: number | undefined): string | undefined {
  if (!size || !Number.isFinite(size)) return undefined;
  if (size >= 1_000_000) return '1m';
  if (size === 200_000) return '200k';
  return `${Math.round(size / 1000)}k`;
}

interface RateLimitSeg {
  used_percentage?: number;
  resets_at?: number;
}

function parseRate(seg: RateLimitSeg | undefined, nowSec: number): HudUsage | undefined {
  if (!seg || typeof seg !== 'object') return undefined;
  const pct = typeof seg.used_percentage === 'number' ? Math.round(seg.used_percentage) : undefined;
  const text =
    typeof seg.resets_at === 'number' && seg.resets_at > 0 ? formatResetCountdown(seg.resets_at, nowSec) : undefined;
  if (pct === undefined && text === undefined) return undefined;
  return { pct, text };
}

/** 上下文已用 token（input + cache_creation + cache_read，与 /context 口径一致，不含 output）。 */
function usageContextTokens(u: Record<string, unknown> | undefined): number {
  if (!u || typeof u !== 'object') return 0;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
}

/**
 * 解析 statusLine stdin JSON 为 Hud（source='statusline'，最完整）。坏 JSON / 无可用字段 → null。
 * @param nowSec 当前秒级时间戳（注入便于测试倒计时）。
 */
export function parseStatuslineStdin(raw: string, nowSec: number = Math.floor(Date.now() / 1000)): Hud | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;

  const model = o.model as { id?: string; display_name?: string } | undefined;
  const cw = o.context_window as
    | { context_window_size?: number; used_percentage?: number; current_usage?: Record<string, unknown> }
    | undefined;
  const rl = o.rate_limits as { five_hour?: RateLimitSeg; seven_day?: RateLimitSeg } | undefined;

  const hud: Hud = { source: 'statusline', raw: '' };

  const name = model?.display_name || model?.id;
  if (name) hud.model = String(name);

  if (cw && typeof cw === 'object') {
    const size = typeof cw.context_window_size === 'number' ? cw.context_window_size : undefined;
    if (size) hud.contextWindowTokens = size;
    const win = windowLabel(size);
    if (win) hud.contextWindow = win;
    const tokens = usageContextTokens(cw.current_usage);
    if (tokens > 0) hud.contextTokens = tokens;
    if (typeof cw.used_percentage === 'number') {
      hud.contextPct = Math.round(cw.used_percentage);
    } else if (size && tokens > 0) {
      hud.contextPct = Math.round((tokens / size) * 100);
    }
  }

  if (rl) {
    const five = parseRate(rl.five_hour, nowSec);
    if (five) hud.fiveHour = five;
    const week = parseRate(rl.seven_day, nowSec);
    if (week) hud.weekly = week;
  }

  // 自渲染一行镜像，供前端展开兜底（也是脚本无下游时打印到状态栏的内容）。
  hud.raw = renderHudLine(hud);

  // 至少要有 model 或 context 才算有效。
  if (!hud.model && hud.contextPct === undefined && hud.contextTokens === undefined) return null;
  return hud;
}

/** 把 Hud 关键字段渲染成单行文本（`[model] ctx N% | 5h N% | wk N%`）。 */
export function renderHudLine(h: Hud): string {
  const parts: string[] = [];
  if (h.model) parts.push(`[${h.model}${h.contextWindow ? `:${h.contextWindow}` : ''}]`);
  if (h.contextPct !== undefined) parts.push(`ctx ${h.contextPct}%`);
  if (h.fiveHour?.pct !== undefined) parts.push(`5h ${h.fiveHour.pct}%`);
  if (h.weekly?.pct !== undefined) parts.push(`wk ${h.weekly.pct}%`);
  return parts.join(' | ');
}

/**
 * 从 transcript 末条 assistant 的 message.usage 推上下文 token；窗口大小未知，故 pct 为近似：
 * tokens>200k 视为 1M 窗口，否则 200k 窗口。至少给 tokens。
 */
export function deriveContextFromTranscriptUsage(usage: Record<string, unknown> | undefined): {
  tokens: number;
  pct?: number;
  approx: boolean;
} {
  const tokens = usageContextTokens(usage);
  if (tokens <= 0) return { tokens: 0, approx: true };
  const window = tokens > 200_000 ? 1_000_000 : 200_000;
  return { tokens, pct: Math.round((tokens / window) * 100), approx: true };
}

/** 把 transcript 推算结果包成 Hud（source='transcript'，无用量）。 */
export function hudFromTranscript(usage: Record<string, unknown> | undefined): Hud | null {
  const d = deriveContextFromTranscriptUsage(usage);
  if (d.tokens <= 0) return null;
  const hud: Hud = { source: 'transcript', contextTokens: d.tokens, approxContext: true, raw: '' };
  if (d.pct !== undefined) hud.contextPct = d.pct;
  hud.raw = renderHudLine(hud);
  return hud;
}

/**
 * 按优先级合并三源为一个 Hud：
 * - statusline（最完整）：直接用；缺 gitBranch 时从 pane 补（pane 才有 git）。
 * - 无 statusline：transcript 提供 context（token/近似 pct），叠加 pane 的用量(5h/周)/model/git。
 * - 都无：用 pane。
 * 全空 → null。
 */
export function pickHud(sources: { statusline?: Hud | null; transcript?: Hud | null; pane?: Hud | null }): Hud | null {
  const { statusline, transcript, pane } = sources;

  if (statusline) {
    const h: Hud = { ...statusline };
    if (h.gitBranch === undefined && pane?.gitBranch) h.gitBranch = pane.gitBranch;
    return h;
  }

  if (transcript) {
    const h: Hud = { ...transcript };
    if (pane) {
      if (h.model === undefined) h.model = pane.model;
      if (h.contextWindow === undefined) h.contextWindow = pane.contextWindow;
      if (h.fiveHour === undefined) h.fiveHour = pane.fiveHour;
      if (h.weekly === undefined) h.weekly = pane.weekly;
      if (h.gitBranch === undefined) h.gitBranch = pane.gitBranch;
    }
    h.raw = renderHudLine(h);
    return h;
  }

  // pane 是读屏旧路径（scrapeHud 不打 source）；统一在合并出口标注 source='pane'。
  if (pane) return { ...pane, source: 'pane' };
  return null;
}

/** sidecar 文件读取的可注入 IO（便于测试）。 */
export interface SidecarIO {
  /** 读文件，返回内容与 mtime（ms）；不存在/失败应抛错。 */
  read(path: string): { content: string; mtimeMs: number };
}

/** sidecar 视为新鲜的最大 mtime 年龄（ms）：会话停了就不显示陈旧数据。 */
export const SIDECAR_MAX_AGE_MS = 15_000;

/**
 * 读 `${dir}/${sessionId}.json`，mtime 超 15s 视为过期 → null；不存在/坏内容 → null（不抛）。
 * @param nowMs 当前毫秒时间戳（注入便于测试）。
 */
export function readStatuslineSidecar(
  io: SidecarIO,
  dir: string,
  sessionId: string,
  nowMs: number = Date.now(),
): Hud | null {
  let content: string;
  let mtimeMs: number;
  try {
    const r = io.read(joinPath(dir, `${sessionId}.json`));
    content = r.content;
    mtimeMs = r.mtimeMs;
  } catch {
    return null;
  }
  if (nowMs - mtimeMs > SIDECAR_MAX_AGE_MS) return null;
  return parseStatuslineStdin(content, Math.floor(nowMs / 1000));
}

/** 极简路径拼接（避免在纯函数模块里引 node:path，测试断言更直观）。 */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
