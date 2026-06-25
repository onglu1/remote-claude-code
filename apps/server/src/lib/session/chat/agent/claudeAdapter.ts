/**
 * claudeAdapter:把既有 claude 路径(buildClaudeCmd / TranscriptTail /
 * locateTranscript / projectsDirFor / parseToolUseEvents)包到 AgentAdapter
 * 接口后面。零行为变化——只是抽象层注册入口。
 */
import { buildClaudeCmd } from '../launch';
import { locateTranscript, projectsDirFor, TranscriptTail } from '../transcript';
import { parseToolUseEvents as parseClaudeToolUseEvents } from '../../activity';
import type { AgentAdapter, LaunchOpts, ResumeOpts, ToolUseEvent, TranscriptLike, DiscoverSessionIdOpts } from './adapter';

/** 注:claude adapter 依赖外部 ServiceUser 解析 projects 目录;
 *  调用方在 context 里组装时传 serviceUser 进来。 */
export function makeClaudeAdapter(serviceUser: string): AgentAdapter {
  return {
    kind: 'claude',
    capabilities: {
      effort: true,
      askHook: true,
      hud: true,
      rewind: true,
      presetSessionId: true,
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
    locateTranscript(sessionId: string, unixUser: string, _cwd: string): string | null {
      return locateTranscript(sessionId, projectsDirFor(unixUser, serviceUser));
    },
    makeTranscriptTail(sessionId: string, unixUser: string, _cwd: string): TranscriptLike {
      return new TranscriptTail(() => locateTranscript(sessionId, projectsDirFor(unixUser, serviceUser)));
    },
    async discoverSessionId(opts: DiscoverSessionIdOpts): Promise<string | null> {
      // claude 是预指定 UUID,启动时已经传 --session-id,直接回原值。
      return opts.tentativeSessionId;
    },
    parseToolUseEvents(text: string): ToolUseEvent[] {
      return parseClaudeToolUseEvents(text);
    },
  };
}

/**
 * 默认实例(serviceUser 在 context 里组装时再绑;这里给一个"用 ServiceUser=当前进程用户"的兜底
 * 仅供单测用,生产代码请用 makeClaudeAdapter(ctx.config.serviceUser))。
 */
import os from 'node:os';
export const claudeAdapter: AgentAdapter = makeClaudeAdapter(os.userInfo().username);
