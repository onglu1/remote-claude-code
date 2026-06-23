/**
 * 解析 Claude Code 原生交互式会话写出的 transcript jsonl，
 * 规整成前端可渲染的 ChatMessage；并提供按字节偏移的增量 tail。
 */
import {
  existsSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ContentBlock } from '@rcc/shared';

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && 'text' in b) return String((b as { text: unknown }).text);
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function normalizeBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length) out.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking.length)
          out.push({ type: 'thinking', text: block.thinking });
        break;
      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: String(block.id ?? ''),
          name: String(block.name ?? 'tool'),
          input: block.input ?? {},
        });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          toolUseId: String(block.tool_use_id ?? ''),
          content: flattenToolResult(block.content),
          isError: block.is_error === true ? true : undefined,
        });
        break;
      case 'image':
        out.push({ type: 'image', alt: typeof block.alt === 'string' ? block.alt : undefined });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * transcript 条目的语义分类。关键：claude 把「工具结果」也以 role:"user" 写入，
 * 故角色不能只看 message.role，必须看 content-block 与若干标志位。
 * - human       真实人类消息（文本/图片）
 * - assistant   助手输出（文本/思考/工具调用）
 * - tool_result 工具反馈（role 虽为 user，但属助手回合，前端按 id 配对）
 * - noise       不渲染：命令包装(isMeta)/压缩摘要(isCompactSummary)/子代理(isSidechain)/非对话类型
 */
export type EntryClass = 'human' | 'assistant' | 'tool_result' | 'noise';

function contentHasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b) => b != null && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result')
  );
}

export function classifyEntry(o: Record<string, unknown>): EntryClass {
  if (!o || typeof o !== 'object') return 'noise';
  if (o.type === 'assistant') return o.isSidechain === true ? 'noise' : 'assistant';
  if (o.type !== 'user') return 'noise';
  if (o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) return 'noise';
  if (o.toolUseResult !== undefined || o.sourceToolAssistantUUID !== undefined) return 'tool_result';
  const content = (o.message as Record<string, unknown> | undefined)?.content;
  if (contentHasToolResult(content)) return 'tool_result';
  return 'human';
}

/**
 * 把已解析的 transcript 对象规整为可渲染 ChatMessage；noise/空内容 → null。
 * 角色取自 classifyEntry：assistant→assistant，human/tool_result→user
 * （tool_result 保留 role:user 以便前端按 tool_use_id 配对，分组时不作为用户回合）。
 */
function renderMessage(o: Record<string, unknown>): ChatMessage | null {
  const klass = classifyEntry(o);
  if (klass === 'noise') return null;
  const msg = o.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') return null;
  const blocks = normalizeBlocks(msg.content);
  if (blocks.length === 0) return null;
  return {
    uuid: typeof o.uuid === 'string' ? o.uuid : randomUUID(),
    role: klass === 'assistant' ? 'assistant' : 'user',
    blocks,
    ts: typeof o.timestamp === 'string' ? o.timestamp : undefined,
  };
}

/** transcript 树节点：含 uuid/parentUuid（即便不可渲染，如 attachment/system，也参与活动链回溯）。 */
export interface TranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  msg: ChatMessage | null;
  /** 子代理侧链节点：不属主线对话，活动链回溯需排除（否则主线被子代理内容替换）。 */
  isSidechain: boolean;
  /** assistant 条目的 message.usage（token 计数）；HUD 的 transcript 兜底数据源用。无则 undefined。 */
  usage?: Record<string, unknown>;
}

/** 从 assistant 条目取 message.usage（含 input/cache/output token）；非对象 → undefined。 */
function extractUsage(o: Record<string, unknown>): Record<string, unknown> | undefined {
  if (o.type !== 'assistant') return undefined;
  const msg = o.message as Record<string, unknown> | undefined;
  const usage = msg?.usage;
  return usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : undefined;
}

/** 解析一行为树节点：有 uuid 即记为节点（msg 可空）；无 uuid/坏 JSON → null。 */
export function parseEntry(line: string): TranscriptEntry | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!o || typeof o.uuid !== 'string') return null;
  return {
    uuid: o.uuid,
    parentUuid: typeof o.parentUuid === 'string' ? o.parentUuid : null,
    msg: renderMessage(o),
    isSidechain: o.isSidechain === true,
    usage: extractUsage(o),
  };
}

/** 把一行 transcript jsonl 规整为 ChatMessage；非对话/空内容/坏 JSON → null。 */
export function parseTranscriptLine(line: string): ChatMessage | null {
  try {
    return renderMessage(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return null;
  }
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * 给定 unixUser 解析其 ~/.claude/projects 路径。
 * 多用户隔离设计:locateTranscript / launchFlag 不能默认用 ServiceUser 的 home,
 * 否则 zhangrengang 跑的 claude 写的 transcript 永远找不到,
 * 网页显示的总是 ServiceUser 那份(老消息+串号)。
 *
 *   - unixUser === serviceUser → 用 homedir()(零开销路径,等于现状)
 *   - 跨 unix → /home/<unixUser>/.claude/projects(Linux 约定;
 *     非标准家目录的少数环境靠 env 兜底,目前未实现)
 *
 * 注:当前进程(ServiceUser uid)读跨 unix 用户的家目录需对应 r/x 权限
 * (~ 默认 755 → 通常 OK;transcript 文件本身 600 → 需 sudo cat,
 * 但 existsSync/find 只 stat,通常无需 sudo)。读文件内容由 TranscriptTail 处理,
 * 当前用 node fs;若跨 unix 权限不通,后续可扩展为 runAs cat。
 */
export function projectsDirFor(unixUser: string, serviceUser: string): string {
  if (unixUser === serviceUser) return join(homedir(), '.claude', 'projects');
  return join('/home', unixUser, '.claude', 'projects');
}

/** 用全局唯一的 sessionId 在 ~/.claude/projects/* 下定位 transcript（免去 cwd 编码规则）。 */
export function locateTranscript(sessionId: string, baseDir = defaultProjectsDir()): string | null {
  if (!existsSync(baseDir)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(baseDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const p = join(baseDir, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 启动 claude 用的会话标志：该 sessionId 已有 transcript → --resume（续上历史），
 * 否则 --session-id（全新）。终端/聊天两路共用，避免 "Session ID already in use"。
 */
export function launchFlag(sessionId: string, baseDir = defaultProjectsDir()): string {
  return locateTranscript(sessionId, baseDir)
    ? `--resume ${sessionId}`
    : `--session-id ${sessionId}`;
}

/**
 * 增量读取 transcript（append-only，字节偏移有效），维护 uuid→节点的树，
 * 并按 parentUuid 回溯出「活动分支」——正确处理 rewind 产生的分叉树。
 */
export class TranscriptTail {
  private offset = 0;
  private pending = '';
  private order: string[] = [];
  private byUuid = new Map<string, TranscriptEntry>();

  /** getPath 每次调用都重新解析（文件可能在会话开始后才出现）。 */
  constructor(private readonly getPath: () => string | null) {}

  private readFrom(start: number): { text: string; end: number } {
    const path = this.getPath();
    if (!path || !existsSync(path)) return { text: '', end: start };
    const fd = openSync(path, 'r');
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

  /** 读入自上次以来的新字节，解析为节点填入 map（处理跨 poll 的半行缓冲）。 */
  private ingest(): void {
    const { text, end } = this.readFrom(this.offset);
    this.offset = end;
    if (!text) return;
    this.pending += text;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      const e = parseEntry(line);
      if (!e) continue;
      if (!this.byUuid.has(e.uuid)) this.order.push(e.uuid);
      this.byUuid.set(e.uuid, e);
    }
  }

  /**
   * 活动分支：从最后写入的「主线」节点沿 parentUuid 回溯到根，正序的可渲染消息。
   * 起点与回溯都排除 sidechain（子代理侧链自成一棵 parentUuid 树，否则会把主线
   * 整段替换为子代理内部内容）。
   */
  activeChain(): ChatMessage[] {
    this.ingest();
    const out: ChatMessage[] = [];
    const seen = new Set<string>();
    let cur: string | null = null;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.byUuid.get(this.order[i]);
      if (e && !e.isSidechain) {
        cur = e.uuid;
        break;
      }
    }
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.byUuid.get(cur);
      if (!e) break;
      if (!e.isSidechain && e.msg) out.push(e.msg);
      cur = e.parentUuid;
    }
    return out.reverse();
  }

  /**
   * 最后写入的主线 assistant 条目的 message.usage（token 计数）。
   * 供 HUD 的 transcript 兜底数据源推算上下文占用（窗口大小不在 transcript 里，故 pct 近似）。
   * 排除 sidechain（子代理）。无则 null。
   */
  lastAssistantUsage(): Record<string, unknown> | null {
    this.ingest();
    for (let i = this.order.length - 1; i >= 0; i--) {
      const e = this.byUuid.get(this.order[i]);
      if (e && !e.isSidechain && e.usage) return e.usage;
    }
    return null;
  }

  /** 重置（重连/全量重读）：丢弃偏移与已积累的树，下次 activeChain 从头重读。 */
  reset(): void {
    this.offset = 0;
    this.pending = '';
    this.order = [];
    this.byUuid.clear();
  }
}
