import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from './users';
import { SubUserStore } from './subUsers';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-users-'));
  file = path.join(dir, 'users.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('UserStore', () => {
  it('文件不存在时返回空数组（不扫描）', () => {
    const s = new UserStore(file);
    expect(s.load()).toEqual([]);
    expect(s.count()).toBe(0);
  });

  it('add 后可 load 回来，含 id/createdAt', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'alice', passwordHash: 'h1', role: 'user' });
    expect(u.id).toBeTruthy();
    expect(u.createdAt).toBeTruthy();
    expect(s.load()).toHaveLength(1);
    expect(s.count()).toBe(1);
  });

  it('findByUsername / get 命中', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'bob', passwordHash: 'h', role: 'admin' });
    expect(s.findByUsername('bob')?.id).toBe(u.id);
    expect(s.get(u.id)?.username).toBe('bob');
    expect(s.findByUsername('nope')).toBeUndefined();
    expect(s.get('nope')).toBeUndefined();
  });

  it('拒绝重复用户名', () => {
    const s = new UserStore(file);
    s.add({ username: 'dup', passwordHash: 'h', role: 'user' });
    expect(() => s.add({ username: 'dup', passwordHash: 'h2', role: 'user' })).toThrow();
  });

  it('setPassword 改哈希并持久化', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'c', passwordHash: 'old', role: 'user' });
    const r = s.setPassword(u.id, 'new');
    expect(r?.passwordHash).toBe('new');
    expect(s.get(u.id)?.passwordHash).toBe('new');
  });

  it('setPassword 不存在返回 undefined', () => {
    const s = new UserStore(file);
    expect(s.setPassword('nope', 'x')).toBeUndefined();
  });

  it('remove 删除条目', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'd', passwordHash: 'h', role: 'user' });
    s.remove(u.id);
    expect(s.load()).toEqual([]);
  });

  it('第二次写回生成 .bak', () => {
    const s = new UserStore(file);
    s.add({ username: 'a', passwordHash: 'h', role: 'user' });
    s.add({ username: 'b', passwordHash: 'h', role: 'user' });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });
});

describe('UserStore.migrate(fallbackUnixUser)', () => {
  it('给缺 unixUser 的存量回填', () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'u1', username: 'alice', passwordHash: 'h', role: 'admin', createdAt: '2026-01-01' },
      ]),
    );
    const s = new UserStore(file);
    s.migrate('wangleyan');
    expect(s.get('u1')?.unixUser).toBe('wangleyan');
  });

  it('幂等:已有 unixUser 不动', () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'u1', username: 'alice', passwordHash: 'h', role: 'admin',
          createdAt: '2026-01-01', unixUser: 'alice',
        },
      ]),
    );
    const s = new UserStore(file);
    s.migrate('wangleyan');
    expect(s.get('u1')?.unixUser).toBe('alice');
  });
});

describe('全局 username 唯一(主账号/子用户互查)', () => {
  it('UserStore.add 拒绝与子用户重名', () => {
    const subFile = path.join(dir, 'subusers.json');
    const subs = new SubUserStore(subFile);
    subs.add({ parentId: 'u1', username: 'taken', passwordHash: 'h', displayName: 'd' });
    const users = new UserStore(file, subs);
    expect(() =>
      users.add({ username: 'taken', passwordHash: 'h', role: 'user' }),
    ).toThrow(/已存在/);
  });

  it('SubUserStore.add 拒绝与主账号重名', () => {
    const users = new UserStore(file);
    users.add({ username: 'taken', passwordHash: 'h', role: 'user' });
    const subFile = path.join(dir, 'subusers.json');
    const subs = new SubUserStore(subFile, users);
    expect(() =>
      subs.add({ parentId: 'u1', username: 'taken', passwordHash: 'h', displayName: 'd' }),
    ).toThrow(/已存在/);
  });
});

describe('UserStore settings', () => {
  it('add 创建用户带默认 settings.idleCloseHours=3', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'alice', passwordHash: 'h', role: 'admin' });
    expect(u.settings.idleCloseHours).toBe(3);
  });

  it('updateSettings 改 idleCloseHours', () => {
    const s = new UserStore(file);
    const u = s.add({ username: 'alice', passwordHash: 'h', role: 'admin' });
    const updated = s.updateSettings(u.id, { idleCloseHours: 6 });
    expect(updated?.settings.idleCloseHours).toBe(6);
  });
});
