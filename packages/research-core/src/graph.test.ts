import { describe, it, expect } from 'vitest';
import { ResearchGraph } from './graph';
import type { ResearchNode } from './schema';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵实验', status: 'done', parent: 'thread/003', code: [],
    edges: [{ to: 'evidence/005', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '排序确认', status: 'active', result: 'positive',
    output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'idea/012', type: 'idea', title: '激活统计', status: 'incubating', parent: 'thread/003',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];
const g = new ResearchGraph(nodes);

describe('ResearchGraph', () => {
  it('get 取节点', () => {
    expect(g.get('task/007')?.title).toBe('矩阵实验');
    expect(g.get('task/999')).toBeUndefined();
  });
  it('childrenOf 按 parent 反向', () => {
    expect(g.childrenOf('thread/003').sort()).toEqual(['idea/012', 'task/007']);
  });
  it('inEdges 反向邻接', () => {
    expect(g.inEdges('evidence/005')).toEqual([
      { from: 'task/007', edge: { to: 'evidence/005', label: 'produces' } },
    ]);
  });
  it('outEdges 出边', () => {
    expect(g.outEdges('task/007')).toEqual([{ to: 'evidence/005', label: 'produces' }]);
  });
  it('roots = 无 parent(evidence/005 无 parent,故也是 root)', () => {
    expect(g.roots().map((x) => x.id).sort()).toEqual(['evidence/005', 'thread/003']);
  });
  it('listByType / listByStatus', () => {
    expect(g.listByType('idea').map((x) => x.id)).toEqual(['idea/012']);
    expect(g.listByStatus('done').map((x) => x.id)).toEqual(['task/007']);
  });
  it('find 子串匹配(大小写不敏感,跨 id/title)', () => {
    expect(g.find('矩阵').map((x) => x.id)).toEqual(['task/007']);
    expect(g.find('THREAD/003').map((x) => x.id)).toEqual(['thread/003']);
  });
  it('subtree 含自身与全部后代', () => {
    expect(g.subtree('thread/003').map((x) => x.id).sort())
      .toEqual(['idea/012', 'task/007', 'thread/003']);
  });
});
