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
