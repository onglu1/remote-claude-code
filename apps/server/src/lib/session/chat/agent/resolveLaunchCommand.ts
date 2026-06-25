/**
 * 把"会话级 launchCommand 覆盖、缺省走 agent 默认"这个二级回退逻辑收敛到一处,
 * 三处启动路径(聊天 WS spec、resume、reflow、终端 WS)共用避免分叉。
 */
import type { AgentKind } from '@rcc/shared';

/** codex 全局默认启动命令(用户没填会话级时用)。 */
export const CODEX_DEFAULT_LAUNCH = 'codex --yolo';

export interface ConvForLaunch {
  agentKind: AgentKind;
  launchCommand?: string;
}

export interface ProjectForLaunch {
  launchCommand: string;
}

export function resolveLaunchCommand(conv: ConvForLaunch, project: ProjectForLaunch): string {
  if (conv.launchCommand) return conv.launchCommand;
  if (conv.agentKind === 'codex') return CODEX_DEFAULT_LAUNCH;
  return project.launchCommand;
}
