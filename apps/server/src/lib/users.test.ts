import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from './users';

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
