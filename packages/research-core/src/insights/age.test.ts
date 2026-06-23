import { describe, it, expect } from 'vitest';
import { daysBetween, isStale } from './age';

describe('daysBetween', () => {
  it('正向跨天向下取整', () => {
    expect(daysBetween('2026-06-01T00:00:00.000Z', '2026-06-15T12:00:00.000Z')).toBe(14);
  });
  it('同一天为 0', () => {
    expect(daysBetween('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.000Z')).toBe(0);
  });
  it('to 早于 from 返回 0(不为负)', () => {
    expect(daysBetween('2026-06-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(0);
  });
  it('非法时间字符串返回 0', () => {
    expect(daysBetween('not-a-date', '2026-06-15T00:00:00.000Z')).toBe(0);
  });
});

describe('isStale', () => {
  it('达到阈值即陈旧', () => {
    expect(isStale('2026-06-01T00:00:00.000Z', '2026-06-15T00:00:00.000Z', 14)).toBe(true);
  });
  it('差一天即未达阈值', () => {
    expect(isStale('2026-06-02T00:00:00.000Z', '2026-06-15T00:00:00.000Z', 14)).toBe(false);
  });
});
