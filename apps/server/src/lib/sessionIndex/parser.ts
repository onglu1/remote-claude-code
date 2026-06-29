/**
 * 把 transcript 文本(claude jsonl 或 codex rollout jsonl)转换为 IndexedMessage[]。
 * 委托给 adapter.parseTranscriptText 拿中性消息,再补 sessionKey + msgIndex。
 *
 * 调用方负责:读文件文本、传 adapter 实例、给 sessionKey。
 * 这里是纯函数,无 I/O,完全可测。
 */
import type { AgentAdapter } from '../session/chat/agent/adapter';
import type { IndexedMessage } from './types';

export function parseTranscriptForIndex(
  sessionKey: string,
  adapter: AgentAdapter,
  sessionId: string,
  text: string,
): IndexedMessage[] {
  const chain = adapter.parseTranscriptText(text, sessionId);
  return chain.map((m, i) => ({
    sessionKey,
    msgIndex: i,
    role: m.role,
    ts: m.ts,
    content: m.content,
  }));
}
