import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('create 使用更长全局唯一 id,降低跨项目碰撞概率', () => {
    const s = newStore();
    const a = s.create('p1', 'A');
    const b = s.create('p2', 'B');
    expect(a.id).toMatch(/^[0-9a-f]{24}$/);
    expect(b.id).toMatch(/^[0-9a-f]{24}$/);
    expect(a.id).not.toBe(b.id);
  });

  it('getInProject / updateInProject 只命中指定项目,即使历史数据有重复 id', () => {
    const dir = join(tmpdir(), `rcc-conv-scope-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    writeFileSync(file, JSON.stringify([
      {
        id: 'dup',
        projectId: 'p1',
        name: 'P1',
        tmuxName: 'rcc-p1-dup',
        sessionId: '11111111-1111-1111-1111-111111111111',
        effort: 'max',
        starred: false,
        agentKind: 'claude',
        codexSessionDiscovered: false,
        createdAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'dup',
        projectId: 'p2',
        name: 'P2',
        tmuxName: 'rcc-p2-dup',
        sessionId: '22222222-2222-2222-2222-222222222222',
        effort: 'max',
        starred: false,
        agentKind: 'claude',
        codexSessionDiscovered: false,
        createdAt: '2026-01-01T00:00:00Z',
        lastActivityAt: '2026-01-01T00:00:00Z',
      },
    ], null, 2));

    const store = new ConversationStore(file);
    expect(store.getInProject('p2', 'dup')?.name).toBe('P2');
    store.updateInProject('p2', 'dup', { name: 'P2-new' });
    expect(store.getInProject('p1', 'dup')?.name).toBe('P1');
    expect(store.getInProject('p2', 'dup')?.name).toBe('P2-new');
    rmSync(dir, { recursive: true, force: true });
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

describe('ConversationStore.markActive', () => {
  it('清掉 closedAt 并刷新 lastActivityAt', () => {
    const dir = join(tmpdir(), `rcc-conv-active-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    const store = new ConversationStore(file);
    const conv = store.create('p', '休眠会话');
    store.update(conv.id, {
      closedAt: '2026-06-23T00:00:00.000Z',
      lastActivityAt: '2026-06-22T00:00:00.000Z',
    });

    const updated = store.markActive(conv.id, '2026-06-26T12:00:00.000Z');

    expect(updated?.closedAt).toBeUndefined();
    expect(updated?.lastActivityAt).toBe('2026-06-26T12:00:00.000Z');
    expect(store.get(conv.id)?.closedAt).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConversationStore.listAllAlive', () => {
  it('过滤掉 deletedAt 与 closedAt', () => {
    const dir = join(tmpdir(), `rcc-conv-alive-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    const store = new ConversationStore(file);

    const a = store.create('p', 'A');
    const b = store.create('p', 'B');
    const c = store.create('p', 'C');
    store.softDelete(b.id);
    store.update(c.id, { closedAt: '2026-06-23T00:00:00Z' });

    const alive = store.listAllAlive();
    expect(alive.map((x) => x.id)).toEqual([a.id]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConversationStore agentKind/launchCommand', () => {
  let store: ConversationStore;
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `rcc-conv-${Date.now()}-${Math.random()}`);
    store = new ConversationStore(path.join(tmp, 'conv.json'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('create 默认 agentKind=claude、launchCommand=undefined', () => {
    const c = store.create('p1', '');
    expect(c.agentKind).toBe('claude');
    expect(c.launchCommand).toBeUndefined();
    expect(c.codexSessionDiscovered).toBe(false);
  });

  it('create 显式 agentKind/launchCommand 落地', () => {
    const c = store.create('p1', '', undefined, { agentKind: 'codex', launchCommand: 'codex --yolo' });
    expect(c.agentKind).toBe('codex');
    expect(c.launchCommand).toBe('codex --yolo');
  });

  it('loadAll 对老数据缺字段做防御性补全', () => {
    // 手写一份"老格式"数据(没 agentKind / codexSessionDiscovered)
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'conv.json'),
      JSON.stringify([{
        id: 'old1', projectId: 'p1', name: 'legacy',
        tmuxName: 't', sessionId: '11111111-1111-1111-1111-111111111111',
        createdAt: '2026-06-20T00:00:00.000Z',
      }], null, 2),
    );
    const list = store.listByProject('p1');
    expect(list[0].agentKind).toBe('claude');
    expect(list[0].codexSessionDiscovered).toBe(false);
    expect(list[0].launchCommand).toBeUndefined();
    // starred/lastActivityAt 是 migrate() 一次性迁移覆盖的字段,但没跑过 migrate()
    // 就直接 loadAll() 时(比如手动改过 conversations.json 又没重启)也不该读出 undefined。
    expect(list[0].starred).toBe(false);
    expect(list[0].lastActivityAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('update 能改 sessionId 和 codexSessionDiscovered(codex 首次回写场景)', () => {
    const c = store.create('p1', '', undefined, { agentKind: 'codex' });
    const newSid = '22222222-2222-2222-2222-222222222222';
    const updated = store.update(c.id, { sessionId: newSid, codexSessionDiscovered: true });
    expect(updated?.sessionId).toBe(newSid);
    expect(updated?.codexSessionDiscovered).toBe(true);
  });
});
