import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderStore } from './folders';
import { ConversationStore } from './conversations';

let dir: string;
let foldersFile: string;
let convsFile: string;

beforeEach(() => {
  dir = join(tmpdir(), `rcc-folders-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  foldersFile = join(dir, 'folders.json');
  convsFile = join(dir, 'conversations.json');
});

describe('FolderStore', () => {
  it('create + listByProject 返回新文件夹', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', '工程');
    expect(f.name).toBe('工程');
    expect(f.id).toMatch(/^fld_/);
    expect(store.listByProject('proj', 'user1')).toHaveLength(1);
  });

  it('listByProject 按 ownerId 隔离', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    store.create('proj', 'user1', 'A');
    store.create('proj', 'user2', 'B');
    expect(store.listByProject('proj', 'user1')).toHaveLength(1);
    expect(store.listByProject('proj', 'user1')[0].name).toBe('A');
  });

  it('同项目同用户重名 → 抛 duplicate', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    store.create('proj', 'user1', '工程');
    expect(() => store.create('proj', 'user1', '工程')).toThrow(/duplicate/);
  });

  it('rename', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const updated = store.rename(f.id, 'B');
    expect(updated?.name).toBe('B');
  });

  it('remove 空文件夹 → reassigned=0', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const r = store.remove(f.id);
    expect(r.reassigned).toBe(0);
    expect(store.listByProject('proj', 'user1')).toHaveLength(0);
  });

  it('remove 非空文件夹 → 内部会话 folderId 置 null,返回 reassigned 数量', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const c1 = convs.create('proj', '会话1');
    const c2 = convs.create('proj', '会话2');
    convs.update(c1.id, { folderId: f.id });
    convs.update(c2.id, { folderId: f.id });

    const r = store.remove(f.id);
    expect(r.reassigned).toBe(2);
    expect(convs.get(c1.id)?.folderId).toBeNull();
    expect(convs.get(c2.id)?.folderId).toBeNull();
  });

  it('reorder 按传入顺序更新 sortOrder', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const a = store.create('proj', 'user1', 'A');
    const b = store.create('proj', 'user1', 'B');
    const c = store.create('proj', 'user1', 'C');
    store.reorder([c.id, a.id, b.id]);
    const list = store.listByProject('proj', 'user1');
    expect(list.map((f) => f.name)).toEqual(['C', 'A', 'B']);
  });

  it('文件不存在时 listByProject 返回空数组', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    expect(store.listByProject('p', 'u')).toEqual([]);
  });
});
