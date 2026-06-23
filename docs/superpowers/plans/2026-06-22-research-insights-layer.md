# 科研工作流 — 洞察层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在骨干层之上,加纯计算洞察能力(next/affected-by/brief 富版/analyze),让 CLI 能回答「我现在该看什么、哪里崩了」。

**Architecture:** 全部在 `packages/research-core/src/insights/` 新子目录,纯函数风格:输入 `ResearchGraph` + 参数,输出派生类型。`runCli.ts` 加 9 个新动词分发。不动 schema、不动骨干层写动词、不引 LLM。

**Tech Stack:** TypeScript ESM(无构建,tsx 直跑)、vitest(测试与源码共置)、复用已有 `ResearchGraph`/`NodeStore`/`schema`。

---

## 文件结构

新增(全在 `packages/research-core/src/insights/`):

- `types.ts` — `NextItem` / `AffectedReport` / `GraphStats` / `RichBriefLine` 接口 + `DEFAULT_STALE_DAYS=14` 常量。
- `age.ts` — `daysBetween(from,to)` / `isStale(updatedAt,now,days)` 纯函数。
- `affected.ts` — `affectedBy(graph, id)` 反向 depends-on BFS。
- `next.ts` — `nextOpenTasks` / `nextTensions` / `nextStale` / `nextOrphans` / `nextStagnantThreads` + 综合 `nextAll`。
- `briefRich.ts` — `buildRichBrief(graph)` 派生 + `renderBriefRich(graph, maxBytes?)` 渲染。
- `analyze.ts` — `analyzeGraph(graph, opts)` 全图统计。
- 各 `*.test.ts` 与源码共置。

修改:

- `packages/research-core/src/index.ts` — barrel 加 insights 导出。
- `packages/research-core/src/runCli.ts` — USAGE 加 9 个新动词、`runRead` 内 dispatch、加渲染函数。
- `packages/research-core/src/runCli.test.ts` — 加端到端断言。
- `packages/research-core/scripts/smoke-backbone.ts` — 尾部追加洞察层场景。

---

## Task 1: types.ts + age.ts(基础类型与时间工具)

**Files:**
- Create: `packages/research-core/src/insights/types.ts`
- Create: `packages/research-core/src/insights/age.ts`
- Test: `packages/research-core/src/insights/age.test.ts`

- [ ] **Step 1: 写 age.ts 的失败测试**

创建 `packages/research-core/src/insights/age.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { daysBetween, isStale } from './age';

describe('daysBetween', () => {
  it('正向跨天向下取整', () => {
    expect(daysBetween('2026-06-01T00:00:00.000Z', '2026-06-15T12:00:00.000Z')).toBe(14);
  });
  it('同一天为 0', () => {
    expect(daysBetween('2026-06-15T00:00:00.000Z', '2026-06-15T23:59:59.000Z')).toBe(0);
  });
  it('to 早于 from 返回 0(不为负)', () => {
    expect(daysBetween('2026-06-15T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(0);
  });
  it('非法时间字符串返回 0', () => {
    expect(daysBetween('not-a-date', '2026-06-15T00:00:00.000Z')).toBe(0);
  });
});

describe('isStale', () => {
  it('达到阈值即陈旧', () => {
    expect(isStale('2026-06-01T00:00:00.000Z', '2026-06-15T00:00:00.000Z', 14)).toBe(true);
  });
  it('差一天即未达阈值', () => {
    expect(isStale('2026-06-02T00:00:00.000Z', '2026-06-15T00:00:00.000Z', 14)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- age.test --reporter=basic`
Expected: FAIL 「Cannot find module './age'」

- [ ] **Step 3: 写 types.ts**

创建 `packages/research-core/src/insights/types.ts`:

```ts
import type { NodeType } from '../schema';

/** 单条"该关注的事"。 */
export interface NextItem {
  kind: 'open-task' | 'tension' | 'stale' | 'orphan' | 'stagnant-thread';
  id: string;
  title: string;
  reason: string;
  related?: string[];
  age?: number; // 距 updatedAt 的天数
}

/** affected-by 闭包结果。 */
export interface AffectedReport {
  from: string;
  downstream: { id: string; path: string[] }[];
}

/** 全图统计。 */
export interface GraphStats {
  byType: Record<NodeType, number>;
  byStatus: Record<string, number>;
  orphans: string[];
  dangling: string[];
  openTensions: number;
  stagnantThreads: string[];
  totals: { nodes: number; edges: number; containsTrees: number };
}

/** 富 brief 的一行(纯数据,渲染由 renderBriefRich)。 */
export interface RichBriefLine {
  id: string;
  depth: number;
  statusTag: string;
  title: string;
  rollup?: string;
}

/** 默认陈旧阈值:14 天(两周)。 */
export const DEFAULT_STALE_DAYS = 14;
```

- [ ] **Step 4: 写 age.ts**

创建 `packages/research-core/src/insights/age.ts`:

```ts
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 两个 ISO 时间戳的天数差(向下取整,负数取 0,非法输入取 0)。 */
export function daysBetween(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / MS_PER_DAY));
}

/** updatedAt 距 now 的天数 ≥ 阈值,即陈旧。 */
export function isStale(updatedAt: string, now: string, staleDays: number): boolean {
  return daysBetween(updatedAt, now) >= staleDays;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run -s --prefix packages/research-core test -- age.test --reporter=basic`
Expected: PASS(6 tests)

- [ ] **Step 6: typecheck**

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: 输出 `ok`

- [ ] **Step 7: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/insights/
git -C "$WT" commit -m "feat(research): 洞察层基础 — types(派生类型)与 age(时间工具)"
```

---

## Task 2: affected.ts(invalidate 连坐反向闭包)

**Files:**
- Create: `packages/research-core/src/insights/affected.ts`
- Test: `packages/research-core/src/insights/affected.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/research-core/src/insights/affected.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- affected.test --reporter=basic`
Expected: FAIL 「Cannot find module './affected'」

- [ ] **Step 3: 实现 affected.ts**

创建 `packages/research-core/src/insights/affected.ts`:

```ts
import type { ResearchGraph } from '../graph';
import type { AffectedReport } from './types';

/**
 * 反向 depends-on 闭包:从 id 出发,沿入边(label='depends-on')反向 BFS。
 * 每个下游节点附带 path:[from, ..., 该节点](depends-on 链)。
 * 同一节点不重复访问(防循环 / 防重复路径)。
 */
export function affectedBy(graph: ResearchGraph, id: string): AffectedReport {
  const visited = new Set<string>([id]);
  const downstream: { id: string; path: string[] }[] = [];
  const queue: { id: string; path: string[] }[] = [{ id, path: [id] }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const { from, edge } of graph.inEdges(cur.id)) {
      if (edge.label !== 'depends-on') continue;
      if (visited.has(from)) continue;
      visited.add(from);
      const path = [...cur.path, from];
      downstream.push({ id: from, path });
      queue.push({ id: from, path });
    }
  }
  return { from: id, downstream };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run -s --prefix packages/research-core test -- affected.test --reporter=basic`
Expected: PASS(5 tests)

- [ ] **Step 5: typecheck**

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/insights/affected.ts packages/research-core/src/insights/affected.test.ts
git -C "$WT" commit -m "feat(research): 洞察 affected-by — 反向 depends-on 闭包(连坐查询)"
```

---

## Task 3: next.ts(5 维度查询 + 综合)

**Files:**
- Create: `packages/research-core/src/insights/next.ts`
- Test: `packages/research-core/src/insights/next.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/research-core/src/insights/next.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- next.test --reporter=basic`
Expected: FAIL 「Cannot find module './next'」

- [ ] **Step 3: 实现 next.ts**

创建 `packages/research-core/src/insights/next.ts`:

```ts
import type { ResearchGraph } from '../graph';
import type { NextItem } from './types';
import { DEFAULT_STALE_DAYS } from './types';
import { affectedBy } from './affected';
import { isStale, daysBetween } from './age';

/** open-task: status=todo|active 的 task。 */
export function nextOpenTasks(graph: ResearchGraph): NextItem[] {
  const out: NextItem[] = [];
  for (const n of graph.listByType('task')) {
    if (n.type !== 'task') continue;
    if (n.status !== 'todo' && n.status !== 'active') continue;
    out.push({
      kind: 'open-task',
      id: n.id,
      title: n.title,
      reason: `open task,等待你推进(${n.status})`,
    });
  }
  return out;
}

/** tensions: contradicts state=open 的边,按对去重。 */
export function nextTensions(graph: ResearchGraph): NextItem[] {
  const seen = new Set<string>();
  const out: NextItem[] = [];
  for (const n of graph.nodes.values()) {
    for (const e of n.edges) {
      if (e.label !== 'contradicts' || e.state !== 'open') continue;
      const pair = [n.id, e.to].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      const other = graph.get(e.to);
      out.push({
        kind: 'tension',
        id: n.id,
        title: n.title,
        reason: `未解张力:与 ${e.to}${other ? ' "' + other.title + '"' : ''} 结论相反`,
        related: [e.to],
      });
    }
  }
  return out;
}

/** stale: 所有 invalidated 节点的 affected-by 闭包之并集。 */
export function nextStale(graph: ResearchGraph): NextItem[] {
  const collected = new Map<string, string>(); // id → upstream id
  for (const n of graph.nodes.values()) {
    if (!('status' in n) || (n as { status?: string }).status !== 'invalidated') continue;
    for (const d of affectedBy(graph, n.id).downstream) {
      if (!collected.has(d.id)) collected.set(d.id, n.id);
    }
  }
  const out: NextItem[] = [];
  for (const [id, upstreamId] of collected) {
    const node = graph.get(id);
    if (!node) continue;
    const up = graph.get(upstreamId);
    out.push({
      kind: 'stale',
      id,
      title: node.title,
      reason: `上游 ${upstreamId}${up ? ' "' + up.title + '"' : ''} 已作废,可能需要复查`,
      related: [upstreamId],
    });
  }
  return out;
}

/** orphans: incubating idea + 无 parent + 无入边。 */
export function nextOrphans(graph: ResearchGraph): NextItem[] {
  const out: NextItem[] = [];
  for (const n of graph.listByType('idea')) {
    if (n.type !== 'idea') continue;
    if (n.status !== 'incubating') continue;
    if (n.parent) continue;
    if (graph.inEdges(n.id).length > 0) continue;
    out.push({
      kind: 'orphan',
      id: n.id,
      title: n.title,
      reason: '无归属 idea,需决定方向或丢弃',
    });
  }
  return out;
}

/** stagnant-thread: open thread + 子树 max(updatedAt) 早于阈值。 */
export function nextStagnantThreads(graph: ResearchGraph, now: string, staleDays: number): NextItem[] {
  const out: NextItem[] = [];
  for (const t of graph.listByType('thread')) {
    if (t.type !== 'thread' || t.status !== 'open') continue;
    const subtree = graph.subtree(t.id);
    const maxUpdated = subtree.map((n) => n.updatedAt).sort().reverse()[0];
    if (!maxUpdated || !isStale(maxUpdated, now, staleDays)) continue;
    const age = daysBetween(maxUpdated, now);
    out.push({
      kind: 'stagnant-thread',
      id: t.id,
      title: t.title,
      reason: `方向静默 ${age} 天`,
      age,
    });
  }
  return out;
}

export interface NextOptions {
  now?: string;
  staleDays?: number;
  kinds?: NextItem['kind'][];
}

/** 综合 next:5 维度并集。 */
export function nextAll(graph: ResearchGraph, opts: NextOptions = {}): NextItem[] {
  const now = opts.now ?? new Date().toISOString();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const includes = (k: NextItem['kind']): boolean => !opts.kinds || opts.kinds.includes(k);
  const items: NextItem[] = [];
  if (includes('open-task')) items.push(...nextOpenTasks(graph));
  if (includes('tension')) items.push(...nextTensions(graph));
  if (includes('stale')) items.push(...nextStale(graph));
  if (includes('orphan')) items.push(...nextOrphans(graph));
  if (includes('stagnant-thread')) items.push(...nextStagnantThreads(graph, now, staleDays));
  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run -s --prefix packages/research-core test -- next.test --reporter=basic`
Expected: PASS(8 tests)

- [ ] **Step 5: typecheck**

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/insights/next.ts packages/research-core/src/insights/next.test.ts
git -C "$WT" commit -m "feat(research): 洞察 next — 5 维度查询(open/tensions/stale/orphans/stagnant)+ 综合"
```

---

## Task 4: briefRich.ts(富版 brief:状态卷积)

**Files:**
- Create: `packages/research-core/src/insights/briefRich.ts`
- Test: `packages/research-core/src/insights/briefRich.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/research-core/src/insights/briefRich.test.ts`:

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- briefRich.test --reporter=basic`
Expected: FAIL 「Cannot find module './briefRich'」

- [ ] **Step 3: 实现 briefRich.ts**

创建 `packages/research-core/src/insights/briefRich.ts`:

```ts
import type { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import type { RichBriefLine } from './types';

const RESULT_SYMBOL: Record<string, string> = {
  positive: '+', negative: '-', inconclusive: '?', mixed: '±',
};

function statusTag(node: ResearchNode): string {
  if (node.type === 'reference') return 'ref';
  if (node.type === 'evidence') {
    const sym = RESULT_SYMBOL[node.result] ?? '';
    return `${node.status} ${sym}`.trim();
  }
  return node.status;
}

/** 容器卷起:子树(不含自身)状态计数 / 未解张力数 / 最新 evidence 结果。 */
function buildRollup(graph: ResearchGraph, containerId: string): string | undefined {
  const sub = graph.subtree(containerId).filter((n) => n.id !== containerId);
  if (sub.length === 0) return undefined;
  const statusCount = new Map<string, number>();
  let openTensions = 0;
  let latest: { at: string; result: string } | null = null;
  for (const n of sub) {
    if (n.type !== 'reference') {
      statusCount.set(n.status, (statusCount.get(n.status) ?? 0) + 1);
    }
    for (const e of n.edges) {
      if (e.label === 'contradicts' && e.state === 'open') openTensions++;
    }
    if (n.type === 'evidence') {
      if (!latest || n.updatedAt > latest.at) latest = { at: n.updatedAt, result: n.result };
    }
  }
  const parts: string[] = [];
  if (statusCount.size > 0) {
    parts.push([...statusCount.entries()].map(([s, c]) => `${c} ${s}`).join(' / '));
  }
  if (openTensions > 0) parts.push(`${openTensions} 张力`);
  if (latest) parts.push(`最新 ${RESULT_SYMBOL[latest.result] ?? latest.result}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 派生富 brief 数据(纯) — 与 graph.ts/brief.ts 的遍历策略一致。 */
export function buildRichBrief(graph: ResearchGraph): RichBriefLine[] {
  const lines: RichBriefLine[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = graph.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    lines.push({
      id,
      depth,
      statusTag: statusTag(node),
      title: node.title,
      rollup: buildRollup(graph, id),
    });
    for (const c of graph.childrenOf(id).slice().sort()) visit(c, depth + 1);
  };
  const all = [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of all) if (!n.parent) visit(n.id, 0);
  for (const n of all) if (!seen.has(n.id)) visit(n.id, 0);
  return lines;
}

/** 渲染为文本,容器行后附 (rollup)。可选 maxBytes 截断。 */
export function renderBriefRich(graph: ResearchGraph, maxBytes?: number): string {
  const rawLines = buildRichBrief(graph).map((l) => {
    const indent = '  '.repeat(l.depth);
    const head = `${indent}${l.id} [${l.statusTag}] ${l.title}`;
    return l.rollup ? `${head}  (${l.rollup})` : head;
  });
  if (!maxBytes) return rawLines.join('\n');
  const out: string[] = [];
  const TAIL = '… (截断)';
  const tailBytes = Buffer.byteLength(TAIL + '\n', 'utf8');
  let bytes = 0;
  for (const line of rawLines) {
    const b = Buffer.byteLength(line + '\n', 'utf8');
    if (bytes + b + tailBytes > maxBytes) break;
    out.push(line);
    bytes += b;
  }
  if (out.length < rawLines.length) out.push(TAIL);
  return out.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run -s --prefix packages/research-core test -- briefRich.test --reporter=basic`
Expected: PASS(6 tests)

- [ ] **Step 5: typecheck**

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/insights/briefRich.ts packages/research-core/src/insights/briefRich.test.ts
git -C "$WT" commit -m "feat(research): 洞察 briefRich — 富版 brief(容器卷积:计数/张力/最新结果)"
```

---

## Task 5: analyze.ts(全图统计)

**Files:**
- Create: `packages/research-core/src/insights/analyze.ts`
- Test: `packages/research-core/src/insights/analyze.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/research-core/src/insights/analyze.test.ts`:

```ts
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
      mk('thread/001', 'thread'),                       // 无 parent 无入边但是 thread → 非孤儿
      mk('reference/k', 'reference'),                   // reference → 非孤儿
      mk('idea/002', 'idea', { status: 'incubating' }), // 真孤儿
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- analyze.test --reporter=basic`
Expected: FAIL 「Cannot find module './analyze'」

- [ ] **Step 3: 实现 analyze.ts**

创建 `packages/research-core/src/insights/analyze.ts`:

```ts
import type { ResearchGraph } from '../graph';
import type { NodeType } from '../schema';
import type { GraphStats } from './types';
import { DEFAULT_STALE_DAYS } from './types';
import { isStale } from './age';

export interface AnalyzeOptions {
  now?: string;
  staleDays?: number;
}

/** 全图统计:类型/状态分布 + 孤儿 + 断链 + 张力 + 停滞方向 + 总量。 */
export function analyzeGraph(graph: ResearchGraph, opts: AnalyzeOptions = {}): GraphStats {
  const now = opts.now ?? new Date().toISOString();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const byType: Record<NodeType, number> = {
    thread: 0, idea: 0, task: 0, evidence: 0, reference: 0,
  };
  const byStatus: Record<string, number> = {};
  const orphans: string[] = [];
  const dangling: string[] = [];
  const tensions = new Set<string>();
  let edges = 0;
  let containsTrees = 0;
  for (const n of graph.nodes.values()) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    if (n.type !== 'reference') byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
    if (!n.parent) containsTrees++;
    if (!n.parent && graph.inEdges(n.id).length === 0
        && n.type !== 'thread' && n.type !== 'reference') {
      orphans.push(n.id);
    }
    edges += n.edges.length;
    for (const e of n.edges) {
      if (!graph.get(e.to)) dangling.push(`${n.id} → ${e.to}`);
      if (e.label === 'contradicts' && e.state === 'open') {
        tensions.add([n.id, e.to].sort().join('|'));
      }
    }
  }
  const stagnantThreads: string[] = [];
  for (const t of graph.listByType('thread')) {
    if (t.type !== 'thread' || t.status !== 'open') continue;
    const sub = graph.subtree(t.id);
    const maxUpdated = sub.map((n) => n.updatedAt).sort().reverse()[0];
    if (maxUpdated && isStale(maxUpdated, now, staleDays)) stagnantThreads.push(t.id);
  }
  return {
    byType,
    byStatus,
    orphans,
    dangling,
    openTensions: tensions.size,
    stagnantThreads,
    totals: { nodes: graph.nodes.size, edges, containsTrees },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run -s --prefix packages/research-core test -- analyze.test --reporter=basic`
Expected: PASS(6 tests)

- [ ] **Step 5: typecheck**

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/insights/analyze.ts packages/research-core/src/insights/analyze.test.ts
git -C "$WT" commit -m "feat(research): 洞察 analyze — 全图统计(byType/byStatus/孤儿/断链/张力/停滞/总量)"
```

---

## Task 6: runCli 接入新动词 + barrel 导出 + CLI 端到端

**Files:**
- Modify: `packages/research-core/src/index.ts`(barrel)
- Modify: `packages/research-core/src/runCli.ts`(USAGE + 渲染函数 + runRead 加 9 case)
- Modify: `packages/research-core/src/runCli.test.ts`(端到端断言)

- [ ] **Step 1: 写失败的 CLI 端到端测试**

修改 `packages/research-core/src/runCli.test.ts`,在文件末尾(最后一个 `});` 之前)追加:

```ts
describe('洞察层 CLI 动词', () => {
  it('next 综合多维度', async () => {
    const root = await mk();
    runCli(['init'], root);
    runCli(['add', 'task', '--title', 'T', '--as', '001'], root);
    const r = runCli(['next'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task/001');
  });
  it('open 仅 open-task', async () => {
    const root = await mk();
    runCli(['init'], root);
    runCli(['add', 'task', '--title', 'T', '--as', '001'], root);
    const r = runCli(['open'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task/001');
  });
  it('analyze 输出统计', async () => {
    const root = await mk();
    runCli(['init'], root);
    runCli(['add', 'thread', '--title', 'D', '--as', '003'], root);
    const r = runCli(['analyze', '--json'], root);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.byType.thread).toBe(1);
  });
  it('affected-by 单点反向闭包', async () => {
    const root = await mk();
    runCli(['init'], root);
    runCli(['add', 'task', '--title', 'A', '--as', '001'], root);
    runCli(['add', 'task', '--title', 'B', '--as', '002'], root);
    runCli(['link', 'task/002', 'task/001', '--label', 'depends-on'], root);
    const r = runCli(['affected-by', 'task/001', '--json'], root);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.downstream.map((d: { id: string }) => d.id)).toContain('task/002');
  });
  it('brief --rich 容器附 rollup', async () => {
    const root = await mk();
    runCli(['init'], root);
    runCli(['add', 'thread', '--title', 'D', '--as', '003'], root);
    runCli(['add', 'task', '--title', 'T', '--as', '001', '--parent', 'thread/003'], root);
    const r = runCli(['brief', '--rich'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/thread\/003.*\(.*todo.*\)/);
  });
});
```

注意:上方测试假设 `runCli.test.ts` 顶部已有 `mk()`/`runCli` 导入。若缺少,改用既有的 fixture 设置(查看文件头)。

- [ ] **Step 2: 跑端到端测试确认失败**

Run: `npm run -s --prefix packages/research-core test -- runCli.test --reporter=basic`
Expected: FAIL(各新 case 因「未知命令」或空输出而失败)

- [ ] **Step 3: barrel 导出**

编辑 `packages/research-core/src/index.ts`,在末尾追加:

```ts
export * from './insights/types';
export * from './insights/age';
export * from './insights/affected';
export * from './insights/next';
export * from './insights/briefRich';
export * from './insights/analyze';
```

- [ ] **Step 4: runCli.ts USAGE 与导入**

编辑 `packages/research-core/src/runCli.ts`:

(a) 顶部导入区追加:

```ts
import { nextAll, nextOpenTasks, nextTensions, nextStale, nextOrphans, nextStagnantThreads } from './insights/next';
import { affectedBy } from './insights/affected';
import { renderBriefRich } from './insights/briefRich';
import { analyzeGraph } from './insights/analyze';
import { DEFAULT_STALE_DAYS } from './insights/types';
import type { NextItem } from './insights/types';
```

(b) `USAGE` 常量数组里,在 `'读图:    rlab brief | show <id> [--deep] | find <query> | list [--type T] [--status S]',` 之前插入两行:

```ts
  '洞察:    rlab next [--stale-days N] [--kind K1,K2] | open | tensions | stale | orphans | stagnant',
  '         rlab affected-by <id> | analyze | brief --rich [--max-bytes N]',
```

- [ ] **Step 5: runCli.ts 加渲染函数**

在 `runRead` 函数之前(`renderShow` 之后)追加:

```ts
function renderNext(items: NextItem[]): string {
  if (items.length === 0) return '(无)';
  return items
    .map((it) => `[${it.kind}] ${it.id}  ${it.title}\n  → ${it.reason}`)
    .join('\n');
}
```

- [ ] **Step 6: runCli.ts 加 9 个 case**

修改 `runRead` 的 switch 块,在 `default:` 之前追加:

```ts
    case 'next': {
      const items = nextAll(graph, {
        staleDays: s(flags, 'stale-days') ? parseInt(s(flags, 'stale-days')!, 10) : undefined,
        kinds: csv(flags, 'kind') as NextItem['kind'][] | undefined,
      });
      return emit(flags, renderNext(items), items);
    }
    case 'open':
      return emit(flags, renderNext(nextOpenTasks(graph)), nextOpenTasks(graph));
    case 'tensions':
      return emit(flags, renderNext(nextTensions(graph)), nextTensions(graph));
    case 'stale':
      return emit(flags, renderNext(nextStale(graph)), nextStale(graph));
    case 'orphans':
      return emit(flags, renderNext(nextOrphans(graph)), nextOrphans(graph));
    case 'stagnant': {
      const days = s(flags, 'stale-days') ? parseInt(s(flags, 'stale-days')!, 10) : DEFAULT_STALE_DAYS;
      const items = nextStagnantThreads(graph, new Date().toISOString(), days);
      return emit(flags, renderNext(items), items);
    }
    case 'affected-by': {
      const report = affectedBy(graph, pos[0] ?? '');
      const human = report.downstream.length === 0
        ? `${report.from} 无下游 depends-on`
        : report.downstream.map((d) => `${d.id}  路径: ${d.path.join(' → ')}`).join('\n');
      return emit(flags, human, report);
    }
    case 'analyze': {
      const stats = analyzeGraph(graph);
      const human = [
        `节点: ${stats.totals.nodes} · 边: ${stats.totals.edges} · contains 树: ${stats.totals.containsTrees}`,
        `按类型: ${Object.entries(stats.byType).filter(([, c]) => c > 0).map(([t, c]) => `${t}=${c}`).join(' ')}`,
        `按状态: ${Object.entries(stats.byStatus).map(([s2, c]) => `${s2}=${c}`).join(' ')}`,
        `孤儿: ${stats.orphans.join(', ') || '(无)'}`,
        `断链: ${stats.dangling.join(', ') || '(无)'}`,
        `未解张力对: ${stats.openTensions}`,
        `停滞方向: ${stats.stagnantThreads.join(', ') || '(无)'}`,
      ].join('\n');
      return emit(flags, human, stats);
    }
```

- [ ] **Step 7: brief 加 `--rich` 分支**

修改现有的 `case 'brief':`,替换为:

```ts
    case 'brief': {
      if (flags.rich) {
        const max = s(flags, 'max-bytes') ? parseInt(s(flags, 'max-bytes')!, 10) : undefined;
        const text = renderBriefRich(graph, max);
        return emit(flags, text, { brief: text });
      }
      return emit(flags, renderBrief(graph), { brief: renderBrief(graph) });
    }
```

- [ ] **Step 8: 跑全套测试 + typecheck**

Run: `npm run -s --prefix packages/research-core test -- --reporter=basic`
Expected: PASS(全部绿,含新增的 5 个 CLI 端到端)

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 9: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/src/index.ts packages/research-core/src/runCli.ts packages/research-core/src/runCli.test.ts
git -C "$WT" commit -m "feat(research): runCli 接入洞察 9 动词 + barrel 导出"
```

---

## Task 7: 真实集成冒烟扩展(洞察层端到端)

**Files:**
- Modify: `packages/research-core/scripts/smoke-backbone.ts`(尾部追加场景)

- [ ] **Step 1: 在冒烟脚本末尾追加洞察层场景**

打开 `packages/research-core/scripts/smoke-backbone.ts`,在 `run(['doctor'])` 之后、最后一行 `process.stdout.write('✅ 骨干层冒烟通过...')` 之前,追加:

```ts
// === 洞察层场景 ===
run(['add', 'task', '--title', '依赖被作废的实验', '--as', '011']);
run(['link', 'task/011', 'evidence/002', '--label', 'depends-on']);
run(['affected-by', 'evidence/002']);  // 应列出 task/011
run(['next']);                          // 应含 open-task/stale/orphan/...
run(['analyze']);                       // 全图统计
run(['brief', '--rich']);               // 含 rollup
run(['open']);
run(['tensions']);
run(['stale']);
run(['orphans']);
run(['stagnant', '--stale-days', '1']);
```

并把最后一行的提示文字改成:

```ts
process.stdout.write('✅ 骨干 + 洞察层冒烟通过(全流程绿)\n');
```

- [ ] **Step 2: 跑冒烟脚本**

Run: `npm run -s --prefix packages/research-core smoke`
Expected: 末尾输出 `✅ 骨干 + 洞察层冒烟通过(全流程绿)`,所有 `$ rlab ...` 命令 exit code 0

- [ ] **Step 3: 全套测试 + typecheck**

Run: `npm run -s --prefix packages/research-core test -- --reporter=basic`
Expected: 全部 PASS

Run: `npm run -s --prefix packages/research-core typecheck`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-backbone
git -C "$WT" add packages/research-core/scripts/smoke-backbone.ts
git -C "$WT" commit -m "test(research): smoke 扩展洞察层场景(affected-by/next/analyze/brief --rich)"
```

---

## 自审清单(写完计划后,我已检查的)

- ✅ 所有 spec §4 五件套 + §5 模块拆分都有对应 task
- ✅ 所有 CLI 动词(§5 表 9 条)都有 runCli case
- ✅ 无 placeholder / TBD
- ✅ 类型/函数命名一致(NextItem.kind / AffectedReport.downstream / GraphStats.totals 等在跨任务里保持同字段)
- ✅ TDD 节奏:每个 task 都是失败测试 → 实现 → 通过 → 提交
