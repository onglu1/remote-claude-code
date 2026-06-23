/**
 * 拼"启动原生 claude code"的完整 bash 命令。被 chatSession.ensure 与 reflow 路由共用,
 * 保证两个路径用同一种方式拉起 claude(env 注入/hook settings/effort/resume 一致)。
 */
import type { EffortLevel } from '@rcc/shared';
import { effortFlag } from '../effort';

export interface BuildClaudeCmdOpts {
  /** 项目级 launchCommand,如 'Fable-yolo'(bash 别名)或 'claude'。 */
  launchCommand: string;
  /** claude 会话 UUID。 */
  sessionId: string;
  /** 思考强度,缺省 max。 */
  effort?: EffortLevel;
  /** 已有 transcript → --resume;否则 --session-id。 */
  hasTranscript: boolean;
  /** AskUserQuestion hook 注入:env 导出 + --settings 叠加。null/undefined 表示不注入。 */
  askLaunch?: { envExport: string; settingsArg: string };
}

/**
 * 拼 `<envExport><launchCommand> <effortFlag> <idFlag><settingsArg>`,
 * 给 tmux 的 bash -ic '<cmd>' 用。
 */
export function buildClaudeCmd(opts: BuildClaudeCmdOpts): string {
  const idFlag = opts.hasTranscript ? `--resume ${opts.sessionId}` : `--session-id ${opts.sessionId}`;
  const pre = opts.askLaunch?.envExport ?? '';
  const post = opts.askLaunch ? ` ${opts.askLaunch.settingsArg}` : '';
  return `${pre}${opts.launchCommand} ${effortFlag(opts.effort)} ${idFlag}${post}`;
}
