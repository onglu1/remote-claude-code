import type { ResearchNode } from '@rcc/shared';
import { StatusBadge } from './StatusBadge';

export function NodeCard({ node, onClick }: { node: ResearchNode; onClick?: () => void }) {
  return (
    <div className="node-card" onClick={onClick} role="button">
      <div className="node-card-head">
        <span className="node-id">{node.id}</span>
        <StatusBadge node={node} />
      </div>
      <div className="node-title">{node.title}</div>
      {node.summary && <div className="node-summary">{node.summary}</div>}
    </div>
  );
}
