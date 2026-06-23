import { describe, it, expect } from 'vitest';
import { effortFlag } from './effort';

describe('effortFlag', () => {
  it('给级别拼 --effort', () => {
    expect(effortFlag('xhigh')).toBe('--effort xhigh');
  });
  it('空值默认 max（聊天默认）', () => {
    expect(effortFlag(undefined)).toBe('--effort max');
    expect(effortFlag(null)).toBe('--effort max');
  });
});
