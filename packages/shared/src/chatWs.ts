/** 聊天视图 WebSocket 协议（结构化，不同于终端视图的字节流 ws.ts）。 */
import { z } from 'zod';
import { EffortLevelSchema, type EffortLevel } from './schemas';

/** 常驻按键条可发送的命名键。 */
export const ChatKeySchema = z.enum(['up', 'down', 'left', 'right', 'enter', 'esc', 'ctrl-c']);
export type ChatKey = z.infer<typeof ChatKeySchema>;

/** rewind 恢复模式（原生三种）。 */
export const RewindModeSchema = z.enum(['both', 'conversation', 'code']);
export type RewindMode = z.infer<typeof RewindModeSchema>;

/** rewind 可回退点（来自原生 picker 刮屏）。 */
export interface RewindItem {
  /** 在 picker 列表中的行序号（0 开始，自顶向下）。 */
  index: number;
  /** 该 checkpoint 对应的用户消息预览。 */
  label: string;
  /** 改动摘要（如 "note.txt +2" / "No code changes"）。 */
  changes: string;
}

/** 一条消息里的内容块（对 claude transcript 的规整投影）。 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal('image'), alt: z.string().optional() }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** 一条规整后的聊天消息。 */
export const ChatMessageSchema = z.object({
  uuid: z.string(),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(ContentBlockSchema),
  ts: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** 折叠回合附带的"底部约一屏"文本(仅最后一个助手回合)。 */
export interface SkeletonTail {
  text: string;
  /** true → 前端给"展开全部"(被截断,或含工具/图片块还有更多可看)。 */
  truncated: boolean;
}

/**
 * 历史骨架的一项:用户消息全文(小、当目录) / 助手回合折叠占位(只带 turnId,正文按需取)。
 * 用户提示词本身就是该轮摘要,故折叠的旧助手回合无需另存摘要。
 */
export type ChatSkeletonItem =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; turnId: string; tail?: SkeletonTail };

/** 一次历史快照:骨架 + (进行中回合剥离出的)实时消息。 */
export interface ChatHistorySnapshot {
  items: ChatSkeletonItem[];
  live: ChatMessage[];
}

/** AskUserQuestion 的一题作答：选中第 questionIndex 题的若干选项(单选即长度 1)。 */
export const AskPickSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  optionIndices: z.array(z.number().int().nonnegative()),
});
export type AskPick = z.infer<typeof AskPickSchema>;

/** 待答选择题的单个可点选项（序号 0 起）。description 来自 hook 真值（原生卡片每项的说明文字）。 */
export interface AskPendingOption {
  index: number;
  label: string;
  /** 该选项的说明文字（hook 源才有；读屏兜底源无）。 */
  description?: string;
}
/**
 * 当前屏待答选择题。优先来自 PreToolUse hook 真值（含问题正文/说明/多问题进度），
 * hook 不可用时退化为实时读屏投影（仅 options/multiSelect）。待答态不在 transcript 历史里，靠此实时传递。
 */
export interface AskPending {
  options: AskPendingOption[];
  multiSelect: boolean;
  /** 问题正文（hook 源才有）。 */
  question?: string;
  /** 问题分类标签 header（hook 源才有）。 */
  header?: string;
  /** 多问题时当前题序（0 起；hook 源才有）。 */
  qIndex?: number;
  /** 多问题总题数（hook 源才有）。 */
  qTotal?: number;
}

/** HUD 限额段（5h / 周）：百分比与括号内文本均可缺（无订阅/刚重置）。 */
export interface HudUsage {
  pct?: number;
  /** 括号内文本，如 "2h 19m / 5h" / "6d 3h / Weekly"。 */
  text?: string;
}

/**
 * 顶部 HUD 信息条。三种数据源(优先级递减)：
 * - statusline：remote-cc 捕获脚本落的 sidecar（Claude Code 喂给 statusLine 的 stdin JSON），
 *   完整且准确（含 5h/周用量、原生 context%、token 数）；不依赖 claude-hud。
 * - transcript：从 transcript 末条 assistant.usage 推 context token（窗口未知则近似 pct）。
 * - pane：读屏 claude-hud 状态行（旧路径，兜底）。
 * 全字段可选+容错：解析不到就不带（API 用户/无订阅 → 无 5h/周，正常）；raw 为镜像兜底。
 */
export interface Hud {
  model?: string;
  /** 上下文窗口大小标记，如 "1m" / "200k"。 */
  contextWindow?: string;
  /** 上下文占用百分比。 */
  contextPct?: number;
  /** 上下文已用 token 数（statusline/transcript 源才有）。 */
  contextTokens?: number;
  /** 上下文窗口总 token 数（statusline 源才有）。 */
  contextWindowTokens?: number;
  /** 上下文为近似值（transcript 源、窗口大小未知时推算）。 */
  approxContext?: boolean;
  fiveHour?: HudUsage;
  weekly?: HudUsage;
  gitBranch?: string;
  /** 数据来源，便于前端标注/调试。 */
  source?: 'statusline' | 'transcript' | 'pane';
  /** 清洗后的 1~2 行 HUD 文本（镜像兜底展示）。 */
  raw: string;
}

/** 浏览器 → 服务器 */
const ChatClientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_text'), text: z.string() }),
  z.object({ type: z.literal('key'), key: ChatKeySchema }),
  z.object({ type: z.literal('image'), dataB64: z.string(), mime: z.string(), name: z.string() }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('peek') }),
  // 让 TUI 重绘当前屏(发 Ctrl-L + resize-window 触发 SIGWINCH 兜底);不打断对话。
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('set_effort'), level: EffortLevelSchema }),
  z.object({ type: z.literal('rewind_open') }),
  z.object({ type: z.literal('rewind_execute'), index: z.number().int().nonnegative(), mode: RewindModeSchema }),
  z.object({ type: z.literal('rewind_cancel') }),
  z.object({ type: z.literal('ask_answer'), toolUseId: z.string(), picks: z.array(AskPickSchema) }),
  z.object({ type: z.literal('ask_pending_answer'), optionIndices: z.array(z.number().int().nonnegative()) }),
  z.object({ type: z.literal('load_turn'), turnId: z.string() }),
]);
export type ChatClientMessage = z.infer<typeof ChatClientSchema>;

/** 服务器 → 浏览器 */
export type ChatServerMessage =
  | { type: 'history'; items: ChatSkeletonItem[]; live: ChatMessage[] }
  | { type: 'turn_body'; turnId: string; messages: ChatMessage[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'preview'; text: string }
  | { type: 'turn_state'; running: boolean }
  | { type: 'session'; sessionId: string; name: string }
  | { type: 'peek'; text: string }
  | { type: 'effort'; level: EffortLevel }
  | { type: 'rewind_list'; items: RewindItem[] }
  | { type: 'rewind_done'; mode: RewindMode; ok: boolean }
  | { type: 'ask_state'; toolUseId: string; status: 'driving' | 'done' | 'failed'; error?: string }
  | {
      type: 'ask_pending';
      options: AskPendingOption[];
      multiSelect: boolean;
      question?: string;
      header?: string;
      qIndex?: number;
      qTotal?: number;
    }
  | { type: 'ask_pending_clear' }
  | { type: 'ask_pending_failed'; error?: string }
  | { type: 'hud'; hud: Hud }
  | { type: 'error'; message: string };

export function decodeChatClient(raw: string): ChatClientMessage | null {
  try {
    const parsed = ChatClientSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeChatServer(msg: ChatServerMessage): string {
  return JSON.stringify(msg);
}
