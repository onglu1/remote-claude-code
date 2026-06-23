import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubUserStore } from './subUsers';

describe('SubUserStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sub-'));
    file = path.join(dir, 'subusers.json');
  });

  it('文件不存在时返回空', () => {
    const s = new SubUserStore(file);
    expect(s.load()).toEqual([]);
    expect(s.count()).toBe(0);
  });

  it('add → get → findByUsername → load 往返', () => {
    const s = new SubUserStore(file);
    const added = s.add({
      parentId: 'u1',
      username: 'alice_dev',
      passwordHash: 'h',
      displayName: '开发',
    });
    expect(added.id).toBeTruthy();
    expect(added.settings.idleCloseHours).toBe(3);
    expect(s.findByUsername('alice_dev')?.id).toBe(added.id);
    expect(s.get(added.id)?.parentId).toBe('u1');
    expect(s.load().length).toBe(1);
  });

  it('拒绝重名子用户', () => {
    const s = new SubUserStore(file);
    s.add({ parentId: 'u1', username: 'dup', passwordHash: 'h', displayName: 'd' });
    expect(() =>
      s.add({ parentId: 'u2', username: 'dup', passwordHash: 'h', displayName: 'd' }),
    ).toThrow(/已存在/);
  });

  it('setPassword 只改 hash,其他字段保留', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'alice_dev', passwordHash: 'h1', displayName: 'd' });
    const updated = s.setPassword(a.id, 'h2');
    expect(updated?.passwordHash).toBe('h2');
    expect(updated?.username).toBe('alice_dev');
  });

  it('updateSettings 持久化 idleCloseHours', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'alice_dev', passwordHash: 'h', displayName: 'd' });
    const updated = s.updateSettings(a.id, { idleCloseHours: 12 });
    expect(updated?.settings.idleCloseHours).toBe(12);
  });

  it('rename 改 displayName', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'alice_dev', passwordHash: 'h', displayName: '老名' });
    const updated = s.rename(a.id, '新名');
    expect(updated?.displayName).toBe('新名');
  });

  it('remove 删除,listByParent 过滤', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'a', passwordHash: 'h', displayName: 'd' });
    s.add({ parentId: 'u2', username: 'b', passwordHash: 'h', displayName: 'd' });
    expect(s.listByParent('u1').length).toBe(1);
    s.remove(a.id);
    expect(s.listByParent('u1')).toEqual([]);
    expect(s.count()).toBe(1);
  });

  it('write 时落 .bak 备份', () => {
    const s = new SubUserStore(file);
    s.add({ parentId: 'u1', username: 'a', passwordHash: 'h', displayName: 'd' });
    s.add({ parentId: 'u1', username: 'b', passwordHash: 'h', displayName: 'd' });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });
});
