import { describe, it, expect } from 'vitest';
import { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import { buildRichBrief, renderBriefRich } from './briefRich';

const T = '2026-06-22T00:00:00.000Z';
function thread(id: string): ResearchNode {
  return { id, type: 'thread', title: id, status: 'open', edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T };
}
function task(id: string, status: 'todo' | 'done', parent?: string): ResearchNode {
  return { id, type: 'task', title: id, status, code: [], parent, edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T };
}
function evi(id: string, result: 'positive' | 'negative', parent?: string, updatedAt = T): ResearchNode {
  return { id, type: 'evidence', title: id, status: 'active', result, output: [], parent,
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt };
}

describe('buildRichBrief', () => {
  it('容器卷起子状态计数', () => {
    const g = new ResearchGraph([
      thread('thread/001'),
      task('task/001', 'done', 'thread/001'),
      task('task/002', 'todo', 'thread/001'),
    ]);
    const lines = buildRichBrief(g);
    const t = lines.find((l) => l.id === 'thread/001')!;
    expect(t.rollup).toContain('1 done');
    expect(t.rollup).toContain('1 todo');
  });
  it('容器卷起未解张力数', () => {
    const e1: ResearchNode = { ...evi('evidence/001', 'positive', 'thread/001'),
      edges: [{ to: 'evidence/002', label: 'contradicts', state: 'open' }] };
    const e2: ResearchNode = { ...evi('evidence/002', 'negative', 'thread/001'),
      edges: [{ to: 'evidence/001', label: 'contradicts', state: 'open' }] };
    const g = new ResearchGraph([thread('thread/001'), e1, e2]);
    const t = buildRichBrief(g).find((l) => l.id === 'thread/001')!;
    expect(t.rollup).toContain('张力');
  });
  it('容器卷起最新 evidence 结果(按 updatedAt)', () => {
    const g = new ResearchGraph([
      thread('thread/001'),
      evi('evidence/001', 'positive', 'thread/001', '2026-06-20T00:00:00.000Z'),
      evi('evidence/002', 'negative', 'thread/001', '2026-06-21T00:00:00.000Z'),
    ]);
    const t = buildRichBrief(g).find((l) => l.id === 'thread/001')!;
    expect(t.rollup).toContain('最新 -');
  });
  it('叶子节点无 rollup', () => {
    const g = new ResearchGraph([task('task/001', 'todo')]);
    expect(buildRichBrief(g)[0].rollup).toBeUndefined();
  });
});

describe('renderBriefRich', () => {
  it('每行 id + 状态 + 标题,容器附 rollup', () => {
    const g = new ResearchGraph([thread('thread/001'), task('task/001', 'done', 'thread/001')]);
    const out = renderBriefRich(g);
    expect(out).toContain('thread/001 [open] thread/001');
    expect(out).toMatch(/thread\/001.*\(.*1 done.*\)/);
    expect(out).toContain('  task/001 [done] task/001');
  });
  it('maxBytes 截断,留尾部省略提示', () => {
    const nodes: ResearchNode[] = [];
    for (let i = 1; i <= 30; i++) {
      nodes.push(task(`task/${String(i).padStart(3, '0')}`, 'todo'));
    }
    const out = renderBriefRich(new ResearchGraph(nodes), 200);
    expect(out).toContain('… (截断)');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200);
  });
});
