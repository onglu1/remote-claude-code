/**
 * 把逐条 ChatMessage 折叠成「回合」用于渲染:一个真实用户消息 = 一个用户回合;
 * 连续的助手输出(文本/思考/工具调用)+ 夹在其间的工具结果 = 一个助手回合。
 *
 * 关键:claude 把「工具结果」以 role:user 写入,它属于助手回合而非用户回合;
 * 因此 tool_result-only 的 user 消息既不新开用户回合,也不打断当前助手回合
 * (其内容由前端按 tool_use_id 配对进工具卡)。纯函数,便于单测。
 */
import type { ChatMessage, ContentBlock } from './chatWs';

export type Turn =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; id: string; blocks: ContentBlock[] };

/** 真实用户消息:role user 且含文本/图片(非纯工具结果)。 */
function isRealUser(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image');
}

/** 纯工具结果的 user 消息:全部块都是 tool_result。 */
function isToolResultOnly(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.type === 'tool_result');
}

export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Extract<Turn, { kind: 'assistant' }> | null = null;

  for (const m of messages) {
    if (isToolResultOnly(m)) continue; // 结果靠 id 配对,不影响回合结构
    if (isRealUser(m)) {
      current = null;
      turns.push({ kind: 'user', message: m });
      continue;
    }
    if (m.role === 'assistant') {
      if (!current) {
        current = { kind: 'assistant', id: m.uuid, blocks: [] };
        turns.push(current);
      }
      for (const b of m.blocks) if (b.type !== 'tool_result') current.blocks.push(b);
    }
  }
  return turns;
}

/** 把消息里的 tool_result 收成 toolUseId→结果 的配对表(前端按 id 配进工具卡)。纯函数。 */
export function collectToolResults(messages: ChatMessage[]): Record<string, { content: string; isError?: boolean }> {
  const map: Record<string, { content: string; isError?: boolean }> = {};
  for (const m of messages)
    for (const b of m.blocks) if (b.type === 'tool_result') map[b.toolUseId] = { content: b.content, isError: b.isError };
  return map;
}
