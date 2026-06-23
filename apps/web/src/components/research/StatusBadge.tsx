import type { ResearchNode } from '@rcc/shared';

const COLOR: Record<string, string> = {
  // thread
  open: '#3b82f6', parked: '#a3a3a3', concluded: '#10b981',
  // idea
  incubating: '#f59e0b', crystallized: '#8b5cf6', dropped: '#737373',
  // task
  todo: '#94a3b8', active: '#3b82f6', done: '#10b981',
  superseded: '#a3a3a3', invalidated: '#ef4444', blocked: '#f97316',
};
const RESULT_SYM: Record<string, string> = { positive: '+', negative: '−', inconclusive: '?', mixed: '±' };

/** 节点状态色块。reference 用灰色 'ref',evidence 在 status 后附 result 符号。 */
export function StatusBadge({ node }: { node: ResearchNode }) {
  if (node.type === 'reference') {
    return <span className="status-badge" style={{ background: '#64748b' }}>ref</span>;
  }
  const color = COLOR[node.status] ?? '#64748b';
  const sym = node.type === 'evidence' ? ` ${RESULT_SYM[node.result] ?? ''}` : '';
  return (
    <span className="status-badge" style={{ background: color }}>
      {node.status}{sym}
    </span>
  );
}
