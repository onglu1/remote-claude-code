import { describe, it, expect } from 'vitest';
import { makeResolveUnixUser } from './resolveUnixUser';

const fakeUsers = {
  get: (id: string) =>
    id === 'u1' ? { id: 'u1', unixUser: 'alice' } :
    id === 'u2' ? { id: 'u2', unixUser: undefined } :   // 老数据:有 user 但缺 unixUser
    undefined,
};
const fakeSubUsers = {
  get: (id: string) =>
    id === 's1' ? { id: 's1', parentId: 'u1' } :
    id === 's2' ? { id: 's2', parentId: 'u2' } :        // 父 unixUser 也缺
    id === 's3' ? { id: 's3', parentId: 'missing' } :  // 孤儿子用户
    undefined,
};

describe('makeResolveUnixUser', () => {
  const resolve = makeResolveUnixUser(fakeUsers as never, fakeSubUsers as never, 'svc-user');

  it('主账号 → 自己的 unixUser', () => {
    expect(resolve('u1')).toBe('alice');
  });

  it('子用户 → 父的 unixUser', () => {
    expect(resolve('s1')).toBe('alice');
  });

  it('缺省 ownerId → ServiceUser', () => {
    expect(resolve(undefined)).toBe('svc-user');
  });

  it('未知 ownerId → ServiceUser(兜底)', () => {
    expect(resolve('unknown')).toBe('svc-user');
  });

  it('父 user 缺 unixUser → ServiceUser', () => {
    expect(resolve('u2')).toBe('svc-user');
    expect(resolve('s2')).toBe('svc-user');
  });

  it('孤儿子用户(parentId 找不到) → ServiceUser', () => {
    expect(resolve('s3')).toBe('svc-user');
  });
});
