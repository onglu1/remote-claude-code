import { describe, it, expect } from 'vitest';
import { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import { analyzeGraph } from './analyze';

const T = '2026-06-22T00:00:00.000Z';
const OLD = '2026-05-01T00:00:00.000Z';
const NOW = '2026-06-22T00:00:00.000Z';

function mk(id: string, type: ResearchNode['type'], opts: Partial<{
  parent: string; status: string; edges: { to: string; label: string; state?: 'open' | 'resolved' }[]; updatedAt: string;
}> = {}): ResearchNode {
  const common = {
    id, title: id, parent: opts.parent,
    edges: opts.edges ?? [], aliases: [], kind: [], createdAt: T, updatedAt: opts.updatedAt ?? T,
  };
  if (type === 'task') return { ...common, type: 'task', status: (opts.status as 'todo') ?? 'todo', code: [] };
  if (type === 'idea') return { ...common, type: 'idea', status: (opts.status as 'incubating') ?? 'incubating' };
  if (type === 'thread') return { ...common, type: 'thread', status: (opts.status as 'open') ?? 'open' };
  if (type === 'evidence') return { ...common, type: 'evidence', status: (opts.status as 'active') ?? 'active', result: 'positive', output: [] };
  return { ...common, type: 'reference' };
}

describe('analyzeGraph', () => {
  it('byType / byStatus / totals', () => {
    const g = new ResearchGraph([
      mk('thread/001', 'thread'),
      mk('task/001', 'task', { status: 'done' }),
      mk('task/002', 'task', { status: 'todo' }),
      mk('evidence/001', 'evidence', { status: 'active' }),
    ]);
    const s = analyzeGraph(g, { now: NOW });
    expect(s.byType).toEqual({ thread: 1, idea: 0, task: 2, evidence: 1, reference: 0 });
    expect(s.byStatus['done']).toBe(1);
    expect(s.byStatus['todo']).toBe(1);
    expect(s.totals.nodes).toBe(4);
  });
  it('orphans 排除 thread 与 reference', () => {
    const g = new ResearchGraph([
      mk('thread/001', 'thread'),
      mk('reference/k', 'reference'),
      mk('idea/002', 'idea', { status: 'incubating' }),
    ]);
    const s = analyzeGraph(g, { now: NOW });
    expect(s.orphans).toEqual(['idea/002']);
  });
  it('dangling 收指向不存在 id 的边', () => {
    const g = new ResearchGraph([
      mk('task/001', 'task', { edges: [{ to: 'task/999', label: 'depends-on' }] }),
    ]);
    const s = analyzeGraph(g, { now: NOW });
    expect(s.dangling).toEqual(['task/001 → task/999']);
  });
  it('openTensions 按对去重', () => {
    const a: ResearchNode = mk('evidence/001', 'evidence', {
      edges: [{ to: 'evidence/002', label: 'contradicts', state: 'open' }],
    });
    const b: ResearchNode = mk('evidence/002', 'evidence', {
      edges: [{ to: 'evidence/001', label: 'contradicts', state: 'open' }],
    });
    const s = analyzeGraph(new ResearchGraph([a, b]), { now: NOW });
    expect(s.openTensions).toBe(1);
  });
  it('stagnantThreads 用 updatedAt 与 now 比', () => {
    const t = mk('thread/001', 'thread', { status: 'open', updatedAt: OLD });
    const child = mk('task/001', 'task', { parent: 'thread/001', updatedAt: OLD });
    const s = analyzeGraph(new ResearchGraph([t, child]), { now: NOW, staleDays: 14 });
    expect(s.stagnantThreads).toEqual(['thread/001']);
  });
  it('totals.containsTrees = 无 parent 节点数', () => {
    const g = new ResearchGraph([
      mk('thread/001', 'thread'),
      mk('task/001', 'task', { parent: 'thread/001' }),
      mk('thread/002', 'thread'),
    ]);
    expect(analyzeGraph(g, { now: NOW }).totals.containsTrees).toBe(2);
  });
});
