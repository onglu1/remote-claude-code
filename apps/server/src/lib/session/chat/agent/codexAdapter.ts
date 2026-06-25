/**
 * codexAdapter:codex CLI 的 AgentAdapter 实现。
 *
 * 启动命令完全由用户提供(默认 `codex --yolo`);resume 固定模板
 * `codex resume --yolo <UUID>`——会话级 launchCommand 仅影响首次启动。
 * (resume 子命令语法不与首次启动 flags 通用,故不解析用户字符串。)
 *
 * codex 不能预先指定 session UUID(issue #13242),启动后扫
 * `<HOME>/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` 找最新一份提取。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, DiscoverSessionIdOpts, LaunchOpts, ResumeOpts, ToolUseEvent, TranscriptLike } from './adapter';
import { CodexTranscriptTail } from './codexTranscript';

export interface CodexAdapterOpts {
  serviceUser: string;
  /** 给一个 unix 用户名 → 其 HOME 目录;注入便于测试。 */
  homeFor: (unixUser: string) => string;
}

/** codex sessions 根目录:<HOME>/.codex/sessions/。 */
function codexSessionsRoot(home: string): string {
  return join(home, '.codex', 'sessions');
}

/** 扫描 YYYY/MM/DD 子目录里所有 rollout-*-<uuid>.jsonl,返回 {file,uuid,mtimeMs}。
 *  仅扫从 startedAt 起的"今天",大多数情况下够用;若需要跨日(午夜启动),sweep 前后几天。 */
function scanRollouts(home: string, daysWindow = 2): Array<{ file: string; uuid: string; mtimeMs: number }> {
  const root = codexSessionsRoot(home);
  if (!existsSync(root)) return [];
  const out: Array<{ file: string; uuid: string; mtimeMs: number }> = [];
  const today = new Date();
  for (let i = 0; i < daysWindow; i++) {
    const d = new Date(today.getTime() - i * 86400_000);
    const dir = join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      // rollout-<timestamp>-<uuid>.jsonl;UUID 用 36 字符标准格式
      const m = name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      if (!m) continue;
      const file = join(dir, name);
      try {
        const st = statSync(file);
        out.push({ file, uuid: m[1].toLowerCase(), mtimeMs: st.mtimeMs });
      } catch { /* 文件刚消失,跳过 */ }
    }
  }
  return out;
}

export function makeCodexAdapter(opts: CodexAdapterOpts): AgentAdapter {
  return {
    kind: 'codex',
    capabilities: {
      effort: false,
      askHook: false,
      hud: false,
      rewind: false,
      presetSessionId: false,
    },

    buildLaunchCmd(o: LaunchOpts): string {
      return o.launchCommand;
    },

    buildResumeCmd(o: ResumeOpts): string {
      return `codex resume --yolo ${o.sessionId}`;
    },

    locateTranscript(sessionId: string, unixUser: string, _cwd: string): string | null {
      const home = opts.homeFor(unixUser);
      const matches = scanRollouts(home, 30).filter((r) => r.uuid === sessionId.toLowerCase());
      if (matches.length === 0) return null;
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return matches[0].file;
    },

    makeTranscriptTail(sessionId: string, unixUser: string, _cwd: string): TranscriptLike {
      // 闭包内每次 getPath 调用都重新算,sessionId 回写后下次 ingest 会指向新文件。
      let currentSid = sessionId;
      const tail = new CodexTranscriptTail(() => {
        const home = opts.homeFor(unixUser);
        const matches = scanRollouts(home, 30).filter((r) => r.uuid === currentSid.toLowerCase());
        if (matches.length === 0) return null;
        matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return matches[0].file;
      });
      // 暴露 setSessionId 钩子(类型层强转;chatSession 回写时调用)
      (tail as TranscriptLike & { setSessionId?: (sid: string) => void }).setSessionId = (sid: string) => {
        if (sid !== currentSid) {
          currentSid = sid;
          tail.reset();  // 切到新文件需重读
        }
      };
      return tail;
    },

    async discoverSessionId(opts2: DiscoverSessionIdOpts): Promise<string | null> {
      const home = opts.homeFor(opts2.unixUser);
      const start = Date.now();
      const poll = 200;
      while (Date.now() - start < opts2.timeoutMs) {
        const matches = scanRollouts(home, 2).filter((r) => r.mtimeMs >= opts2.startedAt);
        if (matches.length > 0) {
          matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
          return matches[0].uuid;
        }
        await new Promise((r) => setTimeout(r, poll));
      }
      return null;
    },

    parseToolUseEvents(_text: string): ToolUseEvent[] {
      return [];  // codex 不接 ① 信号;IdleSweeper 靠 ③ transcript mtime / ⑤ pane hash
    },
  };
}
