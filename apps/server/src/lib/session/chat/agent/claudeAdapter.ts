/**
 * claudeAdapter:把既有 claude 路径(buildClaudeCmd / TranscriptTail /
 * locateTranscript / projectsDirFor / parseToolUseEvents)包到 AgentAdapter
 * 接口后面。零行为变化——只是抽象层注册入口。
 */
import { buildClaudeCmd } from '../launch';
import { locateTranscript, projectsDirFor, TranscriptTail, parseClaudeChain } from '../transcript';
import { parseToolUseEvents as parseClaudeToolUseEvents } from '../../activity';
import type { AgentAdapter, LaunchOpts, ResumeOpts, ToolUseEvent, TranscriptLike, DiscoverSessionIdOpts } from './adapter';

/**
 * 唯一出口。serviceUser 由 context 在组装时显式传入(`ctx.config.serviceUser`)。
 *
 * **为什么必须传 serviceUser**:多用户隔离下,跨 unix 用户的 transcript 在对方
 * `~/.claude/projects/*` 下(`projectsDirFor(unixUser, serviceUser)` 解析),
 * 若误用进程用户作 serviceUser,在单用户机上"碰巧正确",到多用户机上则永久
 * 找不到 transcript / 串号到 ServiceUser 那份(实证 bug)。故不提供任何
 * "默认值"实例——强制调用方显式传一次。
 */
export function makeClaudeAdapter(serviceUser: string): AgentAdapter {
  return {
    kind: 'claude',
    capabilities: {
      effort: true,
      askHook: true,
      hud: true,
      rewind: true,
      presetSessionId: true,
      paneRunningSignal: true,
    },
    buildLaunchCmd(opts: LaunchOpts): string {
      return buildClaudeCmd({
        launchCommand: opts.launchCommand,
        sessionId: opts.sessionId,
        effort: opts.effort,
        hasTranscript: false,
        askLaunch: opts.askLaunch,
      });
    },
    buildResumeCmd(opts: ResumeOpts): string {
      return buildClaudeCmd({
        launchCommand: opts.launchCommand,
        sessionId: opts.sessionId,
        effort: opts.effort,
        hasTranscript: true,
        askLaunch: opts.askLaunch,
      });
    },
    // claude 用全局 sessionId 在 ~/.claude/projects/* 扫描,不依赖 cwd
    // (codex 才需要 cwd,见 codexAdapter)。故 _cwd 在此层故意忽略。
    locateTranscript(sessionId: string, unixUser: string, _cwd: string): string | null {
      return locateTranscript(sessionId, projectsDirFor(unixUser, serviceUser));
    },
    makeTranscriptTail(sessionId: string, unixUser: string, _cwd: string): TranscriptLike {
      return new TranscriptTail(() => locateTranscript(sessionId, projectsDirFor(unixUser, serviceUser)));
    },
    async discoverSessionId(opts: DiscoverSessionIdOpts): Promise<string | null> {
      // claude 是预指定 UUID,启动时已经传 --session-id,直接回原值。
      // 其余参数(unixUser/cwd/timeoutMs/startedAt)仅 codex adapter 用。
      return opts.tentativeSessionId;
    },
    parseToolUseEvents(text: string): ToolUseEvent[] {
      return parseClaudeToolUseEvents(text);
    },
    parseTranscriptText(text: string, _sessionId: string): Array<{ role: 'user' | 'assistant'; ts: string; content: string }> {
      // claude jsonl 是 self-contained 的:整段文本里有所有 uuid/parentUuid。
      // 复用 transcript.ts 的纯函数,与 TranscriptTail.activeChain 同一份逻辑。
      return parseClaudeChain(text);
    },
  };
}
