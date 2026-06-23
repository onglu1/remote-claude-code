/**
 * 把活动链投影成"历史骨架":用户消息全文 + 每个 AI 回合一个折叠占位,
 * 最后一个(空闲的)助手回合附"底部约一屏"文本。纯函数,便于单测。
 *
 * 切分维度为"按回合 + 按角色":用户输入体量小、全保留当目录;AI 回复体量可能极大,
 * 折叠成占位、正文按需取。运行中订阅时把进行中的助手回合剥离到 live,避免与骨架双渲染。
 */
import type { ChatMessage, SkeletonTail, ChatSkeletonItem, ChatHistorySnapshot } from './chatWs';

export type TurnSlice =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; turnId: string; messages: ChatMessage[] };

const DEFAULT_TAIL_CHARS = 1500;

/** 真实用户消息:role user 且含文本/图片(非纯工具结果)。 */
function isRealUser(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image');
}

/** 纯工具结果的 user 消息:全部块都是 tool_result(属助手回合)。 */
function isToolResultOnly(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.type === 'tool_result');
}

/**
 * 按回合切片,保留回合内全部原始消息(助手块 + 夹在其间的 tool_result-only 用户消息),
 * 供"构骨架"与"取正文"共用。assistant 回合 turnId = 该回合首条助手消息 uuid。
 */
export function turnSlices(chain: ChatMessage[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let cur: Extract<TurnSlice, { kind: 'assistant' }> | null = null;
  for (const m of chain) {
    if (isRealUser(m)) {
      cur = null;
      slices.push({ kind: 'user', message: m });
    } else if (isToolResultOnly(m)) {
      if (cur) cur.messages.push(m); // 孤儿 tool_result(无前置助手回合)忽略——不该出现
    } else if (m.role === 'assistant') {
      if (!cur) {
        cur = { kind: 'assistant', turnId: m.uuid, messages: [] };
        slices.push(cur);
      }
      cur.messages.push(m);
    }
  }
  return slices;
}

/** 拼接回合内所有文本块。 */
function turnText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) for (const b of m.blocks) if (b.type === 'text') parts.push(b.text);
  return parts.join('\n\n');
}

/**
 * 计算最后一轮的 tail:文本拼接后取末尾约一屏;超长则截断(truncated=true)。
 * 即便未截断,只要回合还含工具/图片块(有更多可看),也置 truncated=true 以便展开。
 */
function makeTail(messages: ChatMessage[], tailChars: number): SkeletonTail {
  const text = turnText(messages);
  const overflow = text.length > tailChars;
  const hasMore = messages.some((m) =>
    m.blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image'),
  );
  return { text: overflow ? text.slice(text.length - tailChars) : text, truncated: overflow || hasMore };
}

/**
 * 把活动链投影成历史快照。
 * - 用户回合 → 全文;助手回合 → 折叠占位(只带 turnId)。
 * - 空闲时最后一个助手回合附 tail(底部约一屏)。
 * - running 且最后回合为助手 → 该进行中回合剥离为 live(由 onMessage 续写),不进骨架。
 */
export function buildHistorySnapshot(
  chain: ChatMessage[],
  opts?: { running?: boolean; tailChars?: number },
): ChatHistorySnapshot {
  const running = opts?.running ?? false;
  const tailChars = opts?.tailChars ?? DEFAULT_TAIL_CHARS;
  const slices = turnSlices(chain);

  let live: ChatMessage[] = [];
  const last = slices[slices.length - 1];
  if (running && last && last.kind === 'assistant') {
    live = last.messages;
    slices.pop();
  }

  const lastIdx = slices.length - 1;
  const items: ChatSkeletonItem[] = slices.map((s, i) => {
    if (s.kind === 'user') return { kind: 'user', message: s.message };
    if (i === lastIdx && !running) return { kind: 'assistant', turnId: s.turnId, tail: makeTail(s.messages, tailChars) };
    return { kind: 'assistant', turnId: s.turnId };
  });
  return { items, live };
}

/** 取某助手回合的完整原始消息切片(供 load_turn 展开);未命中 null。 */
export function getTurnSlice(chain: ChatMessage[], turnId: string): ChatMessage[] | null {
  const s = turnSlices(chain).find((x) => x.kind === 'assistant' && x.turnId === turnId);
  return s && s.kind === 'assistant' ? s.messages : null;
}
