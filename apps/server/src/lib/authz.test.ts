import { describe, it, expect } from 'vitest';
import { canSeeProject } from './authz';

// 多用户隔离设计后:canSeeProject 按 namespaceId(主账号=user.id,子用户=subUser.id)。
const admin = { role: 'admin' as const, namespaceId: 'admin-1' };
const alice = { role: 'user' as const, namespaceId: 'u-alice' };
const aliceDev = { role: 'user' as const, namespaceId: 's-alice-dev' };

describe('canSeeProject', () => {
  it('admin 看任意项目(含无 owner)', () => {
    expect(canSeeProject(admin, { ownerId: 'someone' })).toBe(true);
    expect(canSeeProject(admin, {})).toBe(true);
  });

  it('owner 看自己 namespace 的项目', () => {
    expect(canSeeProject(alice, { ownerId: 'u-alice' })).toBe(true);
  });

  it('非 owner 看不到', () => {
    expect(canSeeProject(alice, { ownerId: 'u-bob' })).toBe(false);
  });

  it('普通用户看不到无 owner 的项目(仅 admin 可见)', () => {
    expect(canSeeProject(alice, {})).toBe(false);
    expect(canSeeProject(alice, { ownerId: undefined })).toBe(false);
  });

  it('子用户与父主账号 namespace 独立:看不到对方的项目', () => {
    // alice 主账号建的项目 ownerId=u-alice;alice 的子用户 alice_dev 看不到
    expect(canSeeProject(aliceDev, { ownerId: 'u-alice' })).toBe(false);
    // alice_dev 自建的项目 ownerId=s-alice-dev;alice 主账号也看不到
    expect(canSeeProject(alice, { ownerId: 's-alice-dev' })).toBe(false);
  });

  it('同主账号下不同子用户也彼此隔离', () => {
    const aliceRs = { role: 'user' as const, namespaceId: 's-alice-rs' };
    expect(canSeeProject(aliceDev, { ownerId: 's-alice-rs' })).toBe(false);
    expect(canSeeProject(aliceRs, { ownerId: 's-alice-dev' })).toBe(false);
  });
});
