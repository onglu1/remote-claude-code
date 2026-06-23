import { describe, it, expect } from 'vitest';
import { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import { nextOpenTasks, nextTensions, nextStale, nextOrphans, nextStagnantThreads, nextAll } from './next';

const T = '2026-06-22T00:00:00.000Z';
const OLD = '2026-05-01T00:00:00.000Z'; // 51 天前
const NOW = '2026-06-22T00:00:00.000Z';

function task(id: string, status: 'todo' | 'active' | 'done', parent?: string, depends?: string[], updatedAt = T): ResearchNode {
  return { id, type: 'task', title: id, status, code: [], parent,
    edges: (depends ?? []).map((to) => ({ to, label: 'depends-on' })),
    aliases: [], kind: [], createdAt: T, updatedAt };
}
function idea(id: string, status: 'incubating' | 'crystallized', parent?: string): ResearchNode {
  return { id, type: 'idea', title: id, status, parent,
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T };
}
function thread(id: string, status: 'open' | 'concluded', updatedAt = T): ResearchNode {
  return { id, type: 'thread', title: id, status,
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt };
}
function evidence(id: string, status: 'active' | 'invalidated', result: 'positive' | 'negative', parent?: string): ResearchNode {
  return { id, type: 'evidence', title: id, status, result, output: [], parent,
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T };
}

describe('nextOpenTasks', () => {
  it('收 todo 和 active,丢 done', () => {
    const g = new ResearchGraph([task('task/001', 'todo'), task('task/002', 'active'), task('task/003', 'done')]);
    const items = nextOpenTasks(g);
    expect(items.map((x) => x.id).sort()).toEqual(['task/001', 'task/002']);
    expect(items[0].kind).toBe('open-task');
  });
});

describe('nextTensions', () => {
  it('按对去重 open 张力,resolved 不收', () => {
    const a: ResearchNode = { ...evidence('evidence/001', 'active', 'positive'),
      edges: [{ to: 'evidence/002', label: 'contradicts', state: 'open' },
              { to: 'evidence/003', label: 'contradicts', state: 'resolved' }] };
    const b: ResearchNode = { ...evidence('evidence/002', 'active', 'negative'),
      edges: [{ to: 'evidence/001', label: 'contradicts', state: 'open' }] };
    const c: ResearchNode = { ...evidence('evidence/003', 'active', 'negative'),
      edges: [{ to: 'evidence/001', label: 'contradicts', state: 'resolved' }] };
    const g = new ResearchGraph([a, b, c]);
    const items = nextTensions(g);
    expect(items.length).toBe(1);
    expect(items[0].related).toEqual(['evidence/002']);
  });
});

describe('nextStale', () => {
  it('上游 invalidated → 沿 depends-on 反向收下游', () => {
    const inv: ResearchNode = { ...evidence('evidence/001', 'invalidated', 'positive') };
    const t2 = task('task/005', 'todo', undefined, ['evidence/001']);
    const t3 = task('task/006', 'todo', undefined, ['task/005']);
    const g = new ResearchGraph([inv, t2, t3]);
    const items = nextStale(g);
    expect(items.map((x) => x.id).sort()).toEqual(['task/005', 'task/006']);
    expect(items[0].kind).toBe('stale');
    expect(items[0].related).toEqual(['evidence/001']);
  });
});

describe('nextOrphans', () => {
  it('incubating idea 无 parent 无入边 → 孤儿', () => {
    const g = new ResearchGraph([
      idea('idea/001', 'incubating'),
      idea('idea/002', 'incubating', 'thread/003'),
      idea('idea/003', 'crystallized'),
    ]);
    const items = nextOrphans(g);
    expect(items.map((x) => x.id)).toEqual(['idea/001']);
  });
});

describe('nextStagnantThreads', () => {
  it('open thread + 子树 max(updatedAt) 早于阈值', () => {
    const t = thread('thread/003', 'open', OLD);
    const child = task('task/007', 'todo', 'thread/003', undefined, OLD);
    const g = new ResearchGraph([t, child]);
    const items = nextStagnantThreads(g, NOW, 14);
    expect(items.map((x) => x.id)).toEqual(['thread/003']);
    expect(items[0].age).toBeGreaterThanOrEqual(14);
  });
  it('子树有新动作即不算停滞', () => {
    const t = thread('thread/003', 'open', OLD);
    const child = task('task/007', 'todo', 'thread/003', undefined, NOW);
    const g = new ResearchGraph([t, child]);
    expect(nextStagnantThreads(g, NOW, 14)).toEqual([]);
  });
});

describe('nextAll', () => {
  it('五维度并集', () => {
    const inv: ResearchNode = { ...evidence('evidence/001', 'invalidated', 'positive') };
    const stale = task('task/005', 'todo', undefined, ['evidence/001']);
    const orphan = idea('idea/010', 'incubating');
    const stagnant = thread('thread/099', 'open', OLD);
    const g = new ResearchGraph([inv, stale, orphan, stagnant]);
    const items = nextAll(g, { now: NOW, staleDays: 14 });
    const kinds = new Set(items.map((x) => x.kind));
    expect(kinds.has('open-task')).toBe(true);
    expect(kinds.has('stale')).toBe(true);
    expect(kinds.has('orphan')).toBe(true);
    expect(kinds.has('stagnant-thread')).toBe(true);
  });
  it('kinds 过滤只收指定维度', () => {
    const t = task('task/001', 'todo');
    const o = idea('idea/010', 'incubating');
    const g = new ResearchGraph([t, o]);
    const items = nextAll(g, { kinds: ['open-task'] });
    expect(items.every((x) => x.kind === 'open-task')).toBe(true);
  });
});
