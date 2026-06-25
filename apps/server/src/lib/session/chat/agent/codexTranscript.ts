/**
 * codex CLI rollout jsonl 解析。
 *
 * 文件位置:`<HOME>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`。
 * 每行 `{ timestamp, type, payload }`;type 包括 session_meta / event_msg /
 * response_item / turn_context;详见 spec 风险章节链接的 OpenAI 文档。
 *
 * 注:OpenAI 明言此格式"非程序 API、可能变",故每行 try/catch 跳过坏行,
 * 不让格式抖动挂掉整个 session。
 */
import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlock } from '@rcc/shared';
import type { TranscriptLike } from './adapter';

interface CodexLineEnvelope {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** 把 response_item.message.content 数组里的 input_text 拼成纯文本。 */
function joinInputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('');
}

/** 把 reasoning summary 数组拼成单一 text。 */
function joinReasoningSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  return summary
    .map((s) => (s && typeof s === 'object' && 'text' in s ? String((s as { text: unknown }).text) : ''))
    .join('\n');
}

/** 把一行 codex jsonl 规整为 ChatMessage;非对话 / 空内容 / 坏 JSON → null。 */
export function parseCodexLine(line: string): ChatMessage | null {
  if (!line || !line.trim()) return null;
  let env: CodexLineEnvelope;
  try {
    env = JSON.parse(line) as CodexLineEnvelope;
  } catch {
    return null;
  }
  if (!env || typeof env !== 'object') return null;
  const ts = typeof env.timestamp === 'string' ? env.timestamp : undefined;
  const t = env.type;
  const p = env.payload ?? {};

  if (t === 'event_msg') {
    if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.length) {
      return { uuid: randomUUID(), role: 'assistant', blocks: [{ type: 'text', text: p.message }], ts };
    }
    return null;
  }

  if (t === 'response_item') {
    const pt = p.type;
    if (pt === 'message') {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
      if (!role) return null;
      const text = joinInputText(p.content);
      if (!text) return null;
      return { uuid: randomUUID(), role, blocks: [{ type: 'text', text }], ts };
    }
    if (pt === 'function_call' && typeof p.call_id === 'string') {
      let parsedArgs: unknown = {};
      if (typeof p.arguments === 'string') {
        try { parsedArgs = JSON.parse(p.arguments); } catch { parsedArgs = p.arguments; }
      }
      const block: ContentBlock = {
        type: 'tool_use',
        id: p.call_id,
        name: typeof p.name === 'string' ? p.name : 'tool',
        input: parsedArgs as Record<string, unknown>,
      };
      return { uuid: randomUUID(), role: 'assistant', blocks: [block], ts };
    }
    if (pt === 'function_call_output' && typeof p.call_id === 'string') {
      const block: ContentBlock = {
        type: 'tool_result',
        toolUseId: p.call_id,
        content: typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? ''),
      };
      return { uuid: randomUUID(), role: 'user', blocks: [block], ts };
    }
    if (pt === 'reasoning') {
      const text = joinReasoningSummary(p.summary);
      if (!text) return null;
      return { uuid: randomUUID(), role: 'assistant', blocks: [{ type: 'thinking', text }], ts };
    }
    return null;
  }

  return null;  // session_meta / turn_context / 其他事件不渲染
}

/** token_count event_msg 的 payload → usage 形状(供 HUD transcript 兜底用)。 */
function parseTokenCount(line: string): Record<string, unknown> | null {
  try {
    const env = JSON.parse(line) as CodexLineEnvelope;
    if (env.type !== 'event_msg') return null;
    const p = env.payload ?? {};
    if (p.type !== 'token_count') return null;
    const { type, ...rest } = p;
    void type;
    return rest as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * codex 版 TranscriptTail:线性事件流(无 parentUuid 树),
 * activeChain 直接按时间顺序输出可渲染消息。
 */
export class CodexTranscriptTail implements TranscriptLike {
  private offset = 0;
  private pending = '';
  private messages: ChatMessage[] = [];
  private lastUsage: Record<string, unknown> | null = null;

  constructor(private readonly getPath: () => string | null) {}

  private readFrom(start: number): { text: string; end: number } {
    const filePath = this.getPath();
    if (!filePath || !existsSync(filePath)) return { text: '', end: start };
    const fd = openSync(filePath, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size <= start) return { text: '', end: size };
      const len = size - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return { text: buf.toString('utf8'), end: size };
    } finally {
      closeSync(fd);
    }
  }

  private ingest(): void {
    const { text, end } = this.readFrom(this.offset);
    this.offset = end;
    if (!text) return;
    this.pending += text;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      const m = parseCodexLine(line);
      if (m) this.messages.push(m);
      const usage = parseTokenCount(line);
      if (usage) this.lastUsage = usage;
    }
  }

  activeChain(): ChatMessage[] {
    this.ingest();
    return [...this.messages];
  }

  lastAssistantUsage(): Record<string, unknown> | null {
    this.ingest();
    return this.lastUsage;
  }

  reset(): void {
    this.offset = 0;
    this.pending = '';
    this.messages = [];
    this.lastUsage = null;
  }
}
