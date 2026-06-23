import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './conversations';

const newStore = () => new ConversationStore(join(mkdtempSync(join(tmpdir(), 'rcc-cv-')), 'c.json'));

describe('ConversationStore', () => {
  it('create 默认 effort=max', () => {
    const s = newStore();
    const c = s.create('p', '会话');
    expect(c.effort).toBe('max');
  });

  it('update 改 effort 并持久化', () => {
    const s = newStore();
    const c = s.create('p', '会话');
    const u = s.update(c.id, { effort: 'high' });
    expect(u?.effort).toBe('high');
    expect(s.get(c.id)?.effort).toBe('high');
  });

  it('update 不存在的会话返回 undefined', () => {
    const s = newStore();
    expect(s.update('nope', { effort: 'low' })).toBeUndefined();
  });

  it('softDelete 不真删,从常规列表消失但进垃圾箱', () => {
    const s = newStore();
    const c = s.create('p', '会话');
    s.softDelete(c.id);
    expect(s.listByProject('p')).toHaveLength(0);
    expect(s.listDeletedByProject('p')).toHaveLength(1);
    expect(s.get(c.id)?.deletedAt).toBeDefined();
  });

  it('restore 清掉 deletedAt,回到常规列表', () => {
    const s = newStore();
    const c = s.create('p', '会话');
    s.softDelete(c.id);
    s.restore(c.id);
    expect(s.listByProject('p')).toHaveLength(1);
    expect(s.listDeletedByProject('p')).toHaveLength(0);
    expect(s.get(c.id)?.deletedAt).toBeUndefined();
  });

  it('hardDelete 真删,从两个列表都消失', () => {
    const s = newStore();
    const c = s.create('p', '会话');
    s.softDelete(c.id);
    s.hardDelete(c.id);
    expect(s.listByProject('p')).toHaveLength(0);
    expect(s.listDeletedByProject('p')).toHaveLength(0);
    expect(s.get(c.id)).toBeUndefined();
  });

  it('create 带 sessionId 时直接用,不再随机', () => {
    const s = newStore();
    const c = s.create('p', '接续', 'ab12cd34-ef56-7890-abcd-1234567890ab');
    expect(c.sessionId).toBe('ab12cd34-ef56-7890-abcd-1234567890ab');
  });
});

describe('ConversationStore migrate 扩字段', () => {
  it('给老数据补 starred=false 和 lastActivityAt=createdAt', () => {
    const dir = join(tmpdir(), `rcc-conv-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    writeFileSync(file, JSON.stringify([
      { id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
        sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        effort: 'max', createdAt: '2026-01-01T00:00:00Z' },
    ], null, 2));

    const store = new ConversationStore(file);
    store.migrate();

    const loaded = store.listByProject('p');
    expect(loaded[0].starred).toBe(false);
    expect(loaded[0].lastActivityAt).toBe('2026-01-01T00:00:00Z');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConversationStore.markActivity', () => {
  it('更新 lastActivityAt 到当前 now', () => {
    const dir = join(tmpdir(), `rcc-conv-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    const store = new ConversationStore(file);
    const conv = store.create('p', '会话 X');

    const t1 = '2026-06-23T10:00:00.000Z';
    const updated = store.markActivity(conv.id, t1);

    expect(updated?.lastActivityAt).toBe(t1);
    rmSync(dir, { recursive: true, force: true });
  });
});
