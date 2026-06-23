import type { EffortLevel } from '@rcc/shared';

/**
 * 启动/重启 claude 用的 effort 标志（终端与聊天两视图共用）。
 * 空值回落 max——聊天默认思考强度。
 */
export function effortFlag(level?: EffortLevel | null): string {
  return `--effort ${level ?? 'max'}`;
}
