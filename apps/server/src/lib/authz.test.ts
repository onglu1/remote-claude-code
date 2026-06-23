import { describe, it, expect } from 'vitest';
import { canSeeProject } from './authz';

const admin = { id: 'admin-1', role: 'admin' as const };
const alice = { id: 'u-alice', role: 'user' as const };

describe('canSeeProject', () => {
  it('admin 看任意项目（含无 owner）', () => {
    expect(canSeeProject(admin, { ownerId: 'someone' })).toBe(true);
    expect(canSeeProject(admin, {})).toBe(true);
  });

  it('owner 看自己的项目', () => {
    expect(canSeeProject(alice, { ownerId: 'u-alice' })).toBe(true);
  });

  it('非 owner 看不到', () => {
    expect(canSeeProject(alice, { ownerId: 'u-bob' })).toBe(false);
  });

  it('普通用户看不到无 owner 的项目（仅 admin 可见）', () => {
    expect(canSeeProject(alice, {})).toBe(false);
    expect(canSeeProject(alice, { ownerId: undefined })).toBe(false);
  });
});
