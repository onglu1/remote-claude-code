const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 两个 ISO 时间戳的天数差(向下取整,负数取 0,非法输入取 0)。 */
export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / MS_PER_DAY));
}

/** updatedAt 距 now 的天数 ≥ 阈值,即陈旧。 */
export function isStale(updatedAt: string, now: string, staleDays: number): boolean {
  return daysBetween(updatedAt, now) >= staleDays;
}
