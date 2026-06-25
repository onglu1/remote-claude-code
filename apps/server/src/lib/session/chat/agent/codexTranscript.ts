/**
 * codex CLI rollout jsonl 解析。
 *
 * 文件位置:`<HOME>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`。
 * 每行 `{ timestamp, type, payload }`;type 包括 session_meta / event_msg /
 * response_item / turn_context;详见 spec 风险章节链接的 OpenAI 文档。
 *
 * 注:OpenAI 明言此格式"非程序 API、可能变",故每行 try/catch 跳过坏行,
 * 不让格式抖动挂掉整个 session。
 *
 * **真实数据下的两个关键观察(用本机 ~/.codex/sessions/ 实跑确认)**:
 * 1. **助手文本双源镜像**:同一段助手输出会同时被 codex 写到 `event_msg/agent_message`
 *    与 `response_item/message role=assistant` 两个事件里(内容 100% 重合)。为避免
 *    渲染时一句话出两遍,本解析器**只认 response_item 系列**(user/assistant/function_call/
 *    function_call_output/reasoning 同源、时间顺序自洽),`agent_message` 一律不输出。
 * 2. **token_count 真实嵌套形状**:`payload.info.last_token_usage.{input_tokens,
 *    cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`(以及
 *    `payload.info.total_token_usage` / `payload.info.model_context_window`),而不是顶层扁平
 *    字段。`lastAssistantUsage` 据此提取——HUD 当前不消费(codexAdapter.capabilities.hud=false),
 *    但留诚实形状的口子,未来若开 HUD 直接可用。
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

/**
 * 把 response_item.message.content 数组里所有"带 text 字段"的块拼成纯文本。
 * 注:codex 的 user 用 `input_text`、assistant 用 `output_text`——结构都带 `.text`,
 * 故用宽松 `'text' in b` 同时吃下两种,不按 type 字段筛(否则会丢掉 assistant 文本)。
 */
function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .join('');
}

/** 把 reasoning summary 数组拼成单一 text(真实数据 summary 多为空,真内容在 encrypted_content 里读不到)。 */
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

  // event_msg:目前仅 token_count 在 lastAssistantUsage 路径处理;agent_message 是 response_item
  // assistant 镜像,丢弃避免重复渲染(见文件头注释 ①)。其他 event_msg 子类(如 task_started)
  // 不在聊天流里渲染。
  if (t === 'event_msg') return null;

  if (t === 'response_item') {
    const pt = p.type;
    if (pt === 'message') {
      const role = p.role === 'user' ? 'user' : p.role === 'assistant' ? 'assistant' : null;
      if (!role) return null;  // developer / system 等注入角色不渲染
      const text = joinTextBlocks(p.content);
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

/**
 * 从 token_count event_msg 提取 usage 数据(供 HUD transcript 兜底用)。
 *
 * 真实结构(实跑确认):`payload.info.last_token_usage = { input_tokens, cached_input_tokens,
 * output_tokens, reasoning_output_tokens, total_tokens }`。若 last_token_usage 缺,
 * 退到 total_token_usage。返回的对象**字段与 claude 的 usage 形状对齐**——保留
 * input_tokens / output_tokens 等扁平字段,便于 HUD 复用 claude 那边的推算逻辑。
 */
function parseTokenCount(line: string): Record<string, unknown> | null {
  try {
    const env = JSON.parse(line) as CodexLineEnvelope;
    if (env.type !== 'event_msg') return null;
    const p = env.payload ?? {};
    if (p.type !== 'token_count') return null;
    const info = p.info;
    if (!info || typeof info !== 'object') return null;
    const usage =
      ((info as Record<string, unknown>).last_token_usage as Record<string, unknown> | undefined) ??
      ((info as Record<string, unknown>).total_token_usage as Record<string, unknown> | undefined);
    return usage ?? null;
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
  /** 累计跳过的"非空、非已知类型、解析返回 null"的行数;供排障观测 codex 格式漂移。 */
  private skippedLines = 0;

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
      if (!line.trim()) continue;
      const m = parseCodexLine(line);
      if (m) this.messages.push(m);
      const usage = parseTokenCount(line);
      if (usage) this.lastUsage = usage;
      // 既非消息又非 token_count 的非空行:可能是 session_meta/turn_context(预期跳过),
      // 也可能是 codex 新增的事件类型(格式漂移)。计数供排障——首次飙升时就该看一眼新事件 type。
      if (!m && !usage) this.skippedLines += 1;
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

  /** 排障辅助:返回累计跳过的行数(session_meta/turn_context 等预期跳过 + 未知事件)。 */
  skippedLineCount(): number {
    return this.skippedLines;
  }

  reset(): void {
    this.offset = 0;
    this.pending = '';
    this.messages = [];
    this.lastUsage = null;
    this.skippedLines = 0;
  }
}
