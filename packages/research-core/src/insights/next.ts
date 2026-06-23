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
