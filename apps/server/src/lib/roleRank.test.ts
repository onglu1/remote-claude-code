import { describe, it, expect } from 'vitest';
import { canHaveRole, minRole, roleRank } from './roleRank';

describe('roleRank', () => {
  it('admin > user', () => {
    expect(roleRank('admin')).toBeGreaterThan(roleRank('user'));
  });
});

describe('canHaveRole', () => {
  it('父 admin 可挂 user / admin 子用户', () => {
    expect(canHaveRole('admin', 'user')).toBe(true);
    expect(canHaveRole('admin', 'admin')).toBe(true);
  });
  it('父 user 只能挂 user 子用户', () => {
    expect(canHaveRole('user', 'user')).toBe(true);
    expect(canHaveRole('user', 'admin')).toBe(false);
  });
});

describe('minRole', () => {
  it('返回 rank 较小的那个(更弱)', () => {
    expect(minRole('admin', 'user')).toBe('user');
    expect(minRole('user', 'admin')).toBe('user');
    expect(minRole('user', 'user')).toBe('user');
    expect(minRole('admin', 'admin')).toBe('admin');
  });
});
