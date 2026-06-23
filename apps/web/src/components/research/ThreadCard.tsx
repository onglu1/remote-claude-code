import type { ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { StatusBadge } from './StatusBadge';

const RESULT_SYM: Record<string, string> = { positive: '+', negative: '−', inconclusive: '?', mixed: '±' };

function rollup(graph: ResearchGraph, threadId: string): string {
  const sub = graph.subtree(threadId).filter((n) => n.id !== threadId);
  if (sub.length === 0) return '空';
  const cnt = new Map<string, number>();
  let tens = 0;
  let latest: { at: string; result: string } | null = null;
  for (const n of sub) {
    if (n.type !== 'reference' && 'status' in n) {
      cnt.set(n.status, (cnt.get(n.status) ?? 0) + 1);
    }
    for (const e of n.edges) if (e.label === 'contradicts' && e.state === 'open') tens++;
    if (n.type === 'evidence' && (!latest || n.updatedAt > latest.at)) {
      latest = { at: n.updatedAt, result: n.result };
    }
  }
  const parts: string[] = [];
  if (cnt.size) parts.push([...cnt].map(([s, c]) => `${c} ${s}`).join(' / '));
  if (tens) parts.push(`${tens} 张力`);
  if (latest) parts.push(`最新 ${RESULT_SYM[latest.result] ?? ''}`);
  return parts.join(' · ') || '空';
}

export function ThreadCard({ node, graph, onClick }: { node: ResearchNode; graph: ResearchGraph; onClick?: () => void }) {
  return (
    <div className="thread-card" onClick={onClick} role="button">
      <div className="thread-card-head">
        <span className="thread-id">{node.id}</span>
        <StatusBadge node={node} />
      </div>
      <div className="thread-title">{node.title}</div>
      <div className="thread-rollup">{rollup(graph, node.id)}</div>
    </div>
  );
}
