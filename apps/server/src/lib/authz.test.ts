import { describe, it, expect } from 'vitest';
import { canSeeProject } from './authz';

// 多用户隔离设计后:canSeeProject 按 namespaceId(主账号=user.id,子用户=subUser.id)。
const admin = { role: 'admin' as const, namespaceId: 'admin-1' };
const alice = { role: 'user' as const, namespaceId: 'u-alice' };
const aliceDev = { role: 'user' as const, namespaceId: 's-alice-dev' };

describe('canSeeProject', () => {
  // 管理员降级 2026-06-25:admin 不再自动 bypass,跟普通用户一样只看自己 namespace。
  // 跨 namespace 的"管"由 /api/admin/projects/* 专用路由提供(那条路独立鉴权,绕过这层 view 过滤)。
  it('admin 只看自己 namespace 的项目(不再 bypass)', () => {
    expect(canSeeProject(admin, { ownerId: 'admin-1' })).toBe(true);
    expect(canSeeProject(admin, { ownerId: 'someone-else' })).toBe(false);
    expect(canSeeProject(admin, {})).toBe(false);
  });

  it('owner 看自己 namespace 的项目', () => {
    expect(canSeeProject(alice, { ownerId: 'u-alice' })).toBe(true);
  });

  it('非 owner 看不到', () => {
    expect(canSeeProject(alice, { ownerId: 'u-bob' })).toBe(false);
  });

  it('任何人都看不到无 owner 的项目(存量缺 ownerId 的需 migrate 兜底)', () => {
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
