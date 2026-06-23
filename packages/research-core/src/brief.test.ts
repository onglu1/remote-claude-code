import { describe, it, expect } from 'vitest';
import { ResearchGraph } from './graph';
import { renderBrief } from './brief';
import type { ResearchNode } from './schema';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open', edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵实验', status: 'done', parent: 'thread/003', code: [],
    edges: [{ to: 'evidence/005', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '排序确认', status: 'active', result: 'positive',
    output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'idea/012', type: 'idea', title: '激活统计', status: 'incubating', parent: 'thread/003',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];
const out = renderBrief(new ResearchGraph(nodes));

describe('renderBrief', () => {
  it('thread 下缩进列出 children', () => {
    expect(out).toContain('thread/003 [open] 错误危害方向');
    expect(out).toContain('  task/007 [done] 矩阵实验');
    expect(out).toContain('  idea/012 [incubating] 激活统计');
  });
  it('evidence 附 result 极性符号', () => {
    expect(out).toContain('evidence/005 [active +] 排序确认');
  });
  it('children 按 id 排序(idea 在 task 前)', () => {
    const lines = out.split('\n');
    expect(lines.findIndex((l) => l.includes('idea/012')))
      .toBeLessThan(lines.findIndex((l) => l.includes('task/007')));
  });
  it('每个节点只出现一次', () => {
    expect(out.split('\n').filter((l) => l.includes('task/007'))).toHaveLength(1);
  });
});
