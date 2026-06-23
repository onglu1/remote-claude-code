import { describe, it, expect } from 'vitest';
import {
  NodeTypeSchema,
  EvidenceResultSchema,
  EdgeSchema,
  LifecycleSchema,
  ResearchNodeSchema,
} from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };

describe('NodeTypeSchema', () => {
  it('接受五类节点', () => {
    for (const t of ['thread', 'idea', 'task', 'evidence', 'reference']) {
      expect(NodeTypeSchema.parse(t)).toBe(t);
    }
  });
  it('拒绝未知类型', () => {
    expect(() => NodeTypeSchema.parse('paper')).toThrow();
  });
});

describe('EdgeSchema', () => {
  it('自由语义边:to + label,note 可选', () => {
    const e = EdgeSchema.parse({ to: 'evidence/005', label: 'motivated-by' });
    expect(e.to).toBe('evidence/005');
    expect(e.note).toBeUndefined();
  });
  it('张力边带 state', () => {
    const e = EdgeSchema.parse({ to: 'evidence/009', label: 'contradicts', state: 'open' });
    expect(e.state).toBe('open');
  });
  it('拒绝空 to / 空 label', () => {
    expect(() => EdgeSchema.parse({ to: '', label: 'x' })).toThrow();
    expect(() => EdgeSchema.parse({ to: 'x', label: '' })).toThrow();
  });
});

describe('LifecycleSchema', () => {
  it('全部字段可选', () => {
    expect(LifecycleSchema.parse({})).toEqual({});
    const l = LifecycleSchema.parse({ supersededBy: 'task/024', at: '2026-06-22T00:00:00.000Z' });
    expect(l.supersededBy).toBe('task/024');
  });
});

describe('EvidenceResultSchema', () => {
  it('四值极性', () => {
    for (const r of ['positive', 'negative', 'inconclusive', 'mixed']) {
      expect(EvidenceResultSchema.parse(r)).toBe(r);
    }
    expect(() => EvidenceResultSchema.parse('maybe')).toThrow();
  });
});

describe('ResearchNodeSchema 判别联合', () => {
  it('thread 合法 + 默认空数组', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open',
    });
    expect(n.type).toBe('thread');
    expect(n.edges).toEqual([]);
    expect(n.aliases).toEqual([]);
    expect(n.kind).toEqual([]);
  });

  it('idea 合法', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'idea/012', type: 'idea', title: '激活值统计特征', status: 'incubating',
    });
    expect(n.type).toBe('idea');
    if (n.type === 'idea') expect(n.status).toBe('incubating');
  });

  it('task 合法,可带 expectation / code / lifecycle,无 result', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'task/007', type: 'task', title: '错误类型×位置矩阵', status: 'todo',
      expectation: '预期高层注入危害更大', code: ['experiments/007_x'],
    });
    expect(n.type).toBe('task');
    if (n.type === 'task') {
      expect(n.expectation).toBe('预期高层注入危害更大');
      expect(n.code).toEqual(['experiments/007_x']);
      expect('result' in n).toBe(false);
    }
  });

  it('evidence 合法,result 必填', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'evidence/005', type: 'evidence', title: '危害排序确认',
      status: 'active', result: 'positive', output: ['output/005_x'],
    });
    expect(n.type).toBe('evidence');
    if (n.type === 'evidence') expect(n.result).toBe('positive');
  });

  it('evidence 缺 result → 拒绝', () => {
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'evidence/006', type: 'evidence', title: 'x', status: 'active',
    })).toThrow();
  });

  it('reference 合法,带 url / citekey,无 status', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'reference/vaswani2017', type: 'reference', title: 'Attention Is All You Need',
      citekey: 'vaswani2017', url: 'https://arxiv.org/abs/1706.03762',
    });
    expect(n.type).toBe('reference');
    if (n.type === 'reference') expect(n.citekey).toBe('vaswani2017');
  });

  it('task 非法 status → 拒绝', () => {
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'task/008', type: 'task', title: 'x', status: 'incubating',
    })).toThrow();
  });

  it('携带边与生命周期', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'task/024', type: 'task', title: 'v2 重做', status: 'active',
      edges: [{ to: 'evidence/005', label: 'motivated-by', note: '排序需受控验证' }],
      lifecycle: { supersedes: 'task/013', at: base.updatedAt },
    });
    expect(n.edges[0].note).toBe('排序需受控验证');
    if (n.type === 'task') expect(n.lifecycle?.supersedes).toBe('task/013');
  });
});

describe('title 长度约束', () => {
  it('非 reference 节点 title 上限 80,超出 → 拒绝', () => {
    const tooLong = 'x'.repeat(81);
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'task/099', type: 'task', title: tooLong, status: 'todo',
    })).toThrow(/80/);
  });
  it('非 reference 节点 title 80 边界 → 通过', () => {
    const exact80 = 'a'.repeat(80);
    const n = ResearchNodeSchema.parse({
      ...base, id: 'task/099', type: 'task', title: exact80, status: 'todo',
    });
    expect(n.title.length).toBe(80);
  });
  it('reference 节点 title 上限 120(论文标题放宽)', () => {
    const exact120 = 'a'.repeat(120);
    const tooLong121 = 'a'.repeat(121);
    const n = ResearchNodeSchema.parse({
      ...base, id: 'reference/long', type: 'reference', title: exact120,
    });
    expect(n.title.length).toBe(120);
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'reference/longer', type: 'reference', title: tooLong121,
    })).toThrow(/120/);
  });
  it('reference 不受 80 字符约束(即 81-120 通过)', () => {
    const len100 = 'a'.repeat(100);
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'reference/r1', type: 'reference', title: len100,
    })).not.toThrow();
    // 但同样 100 字符的 task 会被拒
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'task/t1', type: 'task', title: len100, status: 'todo',
    })).toThrow(/80/);
  });
});
