import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
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
