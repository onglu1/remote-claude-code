import { describe, it, expect } from 'vitest';
import { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import { affectedBy } from './affected';

const T = '2026-06-22T00:00:00.000Z';
function mk(id: string, type: ResearchNode['type'], parent?: string, depends?: string[]): ResearchNode {
  const common = {
    id, title: id, parent, aliases: [], kind: [], createdAt: T, updatedAt: T,
    edges: (depends ?? []).map((to) => ({ to, label: 'depends-on' })),
  };
  if (type === 'task') return { ...common, type: 'task', status: 'todo' as const, code: [] };
  if (type === 'evidence') return { ...common, type: 'evidence', status: 'active' as const, result: 'positive' as const, output: [] };
  if (type === 'idea') return { ...common, type: 'idea', status: 'incubating' as const };
  if (type === 'thread') return { ...common, type: 'thread', status: 'open' as const };
  return { ...common, type: 'reference' };
}

describe('affectedBy', () => {
  it('单层反向:B depends-on A → affected-by(A) 含 B', () => {
    const g = new ResearchGraph([mk('task/001', 'task'), mk('task/002', 'task', undefined, ['task/001'])]);
    const r = affectedBy(g, 'task/001');
    expect(r.from).toBe('task/001');
    expect(r.downstream.map((d) => d.id)).toEqual(['task/002']);
    expect(r.downstream[0].path).toEqual(['task/001', 'task/002']);
  });
  it('多层反向闭包', () => {
    const g = new ResearchGraph([
      mk('task/001', 'task'),
      mk('task/002', 'task', undefined, ['task/001']),
      mk('task/003', 'task', undefined, ['task/002']),
    ]);
    const r = affectedBy(g, 'task/001');
    expect(r.downstream.map((d) => d.id).sort()).toEqual(['task/002', 'task/003']);
    const t3 = r.downstream.find((d) => d.id === 'task/003')!;
    expect(t3.path).toEqual(['task/001', 'task/002', 'task/003']);
  });
  it('忽略非 depends-on 边', () => {
    const g = new ResearchGraph([
      mk('task/001', 'task'),
      { ...mk('task/002', 'task'), edges: [{ to: 'task/001', label: 'motivated-by' }] },
    ]);
    expect(affectedBy(g, 'task/001').downstream).toEqual([]);
  });
  it('循环不死(同节点不重复访问)', () => {
    const g = new ResearchGraph([
      mk('task/001', 'task', undefined, ['task/002']),
      mk('task/002', 'task', undefined, ['task/001']),
    ]);
    const r = affectedBy(g, 'task/001');
    expect(r.downstream.map((d) => d.id)).toEqual(['task/002']);
  });
  it('不存在的 id 返回空 downstream', () => {
    const g = new ResearchGraph([mk('task/001', 'task')]);
    expect(affectedBy(g, 'task/999').downstream).toEqual([]);
  });
});
