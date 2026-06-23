/**
 * 活动探测器:五信号合判 claude 会话是否在等(busy)。
 * 全纯函数 + 注入 IO,sweeper 与 chatSession 各持一份 state 复用。
 *
 * 信号:
 *  ① 未闭合 tool_use     ─ 增量解析 transcript jsonl,见 tool_use 入 / 见对应 tool_result 出
 *  ② ask sidecar 存在    ─ 选择题待答
 *  ③ transcript mtime    ─ jsonl 在 append
 *  ④ statusline sidecar  ─ claude 主进程在动
 *  ⑤ pane hash 滑窗      ─ 抓 bash stream stdout / TUI 动画
 *
 * 任一为真 → busy;lastBusyAt 滚动到 now。idleForMs = now - lastBusyAt。
 */

export interface ActivityIO {
  transcriptStat(path: string): { mtimeMs: number; size: number } | null;
  transcriptTail(path: string, fromOffset: number): { text: string; end: number };
  sidecarStat(dir: string, sessionId: string): { mtimeMs: number } | null;
  askSidecarExists(dir: string, sessionId: string): boolean;
  paneHash(tmuxName: string): string | null;
  now(): number;
}

export interface ActivityCtx {
  transcriptPath: string | null;
  tmuxName: string;
  sessionId: string;
  statuslineDir: string;
  askDir: string;
}

export interface ActivityState {
  transcriptOffset: number;
  transcriptPending: string;
  lastTranscriptMtime: number;
  lastStatuslineMtime: number;
  lastPaneHash: string | null;
  lastPaneHashAt: number;
  openToolUseIds: Set<string>;
  openToolUseIdsSidechain: Set<string>;
  lastBusyAt: number;
}

export function createActivityState(now: number): ActivityState {
  return {
    transcriptOffset: 0,
    transcriptPending: '',
    lastTranscriptMtime: 0,
    lastStatuslineMtime: 0,
    lastPaneHash: null,
    lastPaneHashAt: now,
    openToolUseIds: new Set(),
    openToolUseIdsSidechain: new Set(),
    lastBusyAt: now,
  };
}

export interface ToolUseEvent {
  kind: 'open' | 'close';
  id: string;
  sidechain: boolean;
}

/**
 * 从 transcript jsonl 文本提取 tool_use 开/关事件。
 * - assistant 条目的 content 含 tool_use → open
 * - user 条目的 content 含 tool_result.tool_use_id → close
 * - isSidechain 节点单独标记
 */
export function parseToolUseEvents(text: string): ToolUseEvent[] {
  const events: ToolUseEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    const sidechain = o.isSidechain === true;
    const msg = o.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        events.push({ kind: 'open', id: block.id, sidechain });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        events.push({ kind: 'close', id: block.tool_use_id, sidechain });
      }
    }
  }
  return events;
}

export interface TickResult {
  busy: boolean;
  idleForMs: number;
  reasons: string[];
}

export function tickActivity(
  state: ActivityState,
  ctx: ActivityCtx,
  io: ActivityIO,
  windowMs: number,
): TickResult {
  const now = io.now();
  const reasons: string[] = [];

  // ── 信号 ③ + ① 一起:读 transcript 增量,既看 mtime 又解析 tool_use ──
  if (ctx.transcriptPath) {
    const stat = io.transcriptStat(ctx.transcriptPath);
    if (stat) {
      if (state.lastTranscriptMtime > 0 && stat.mtimeMs > state.lastTranscriptMtime && now - stat.mtimeMs <= windowMs) {
        reasons.push('transcript_mtime');
      }
      state.lastTranscriptMtime = stat.mtimeMs;

      if (stat.size > state.transcriptOffset) {
        const { text, end } = io.transcriptTail(ctx.transcriptPath, state.transcriptOffset);
        state.transcriptOffset = end;
        state.transcriptPending += text;
        const idx = state.transcriptPending.lastIndexOf('\n');
        if (idx >= 0) {
          const complete = state.transcriptPending.slice(0, idx + 1);
          state.transcriptPending = state.transcriptPending.slice(idx + 1);
          for (const ev of parseToolUseEvents(complete)) {
            const set = ev.sidechain ? state.openToolUseIdsSidechain : state.openToolUseIds;
            if (ev.kind === 'open') set.add(ev.id);
            else set.delete(ev.id);
          }
        }
      }
    }
  }

  // ── 信号 ①:有任何未闭合 tool_use(主线或 sidechain) ──
  if (state.openToolUseIds.size > 0 || state.openToolUseIdsSidechain.size > 0) {
    reasons.push('open_tool_use');
  }

  // ── 信号 ②:ask sidecar 存在 ──
  if (io.askSidecarExists(ctx.askDir, ctx.sessionId)) {
    reasons.push('ask_sidecar');
  }

  // ── 信号 ④:statusline sidecar mtime 滑窗变 ──
  const sl = io.sidecarStat(ctx.statuslineDir, ctx.sessionId);
  if (sl) {
    if (state.lastStatuslineMtime > 0 && sl.mtimeMs > state.lastStatuslineMtime && now - sl.mtimeMs <= windowMs) {
      reasons.push('statusline_mtime');
    }
    state.lastStatuslineMtime = sl.mtimeMs;
  }

  // ── 信号 ⑤:pane hash 滑窗变 ──
  const hash = io.paneHash(ctx.tmuxName);
  if (hash !== null) {
    if (state.lastPaneHash !== null && hash !== state.lastPaneHash && now - state.lastPaneHashAt <= windowMs) {
      reasons.push('pane_hash');
    }
    if (state.lastPaneHash !== hash) {
      state.lastPaneHash = hash;
      state.lastPaneHashAt = now;
    }
  }

  const busy = reasons.length > 0;
  if (busy) state.lastBusyAt = now;
  return { busy, idleForMs: now - state.lastBusyAt, reasons };
}
