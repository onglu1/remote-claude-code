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
