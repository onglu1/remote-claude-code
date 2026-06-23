import type { Edge } from '@rcc/shared';

export function EdgeList({
  outEdges, inEdges, onClickNode,
}: {
  outEdges: Edge[];
  inEdges: { from: string; edge: Edge }[];
  onClickNode: (id: string) => void;
}) {
  return (
    <div className="edge-list">
      <div className="edge-section">
        <div className="edge-section-head">出边</div>
        {outEdges.length === 0 && <div className="edge-empty">(无)</div>}
        {outEdges.map((e, i) => (
          <div key={i} className="edge-row" onClick={() => onClickNode(e.to)}>
            → {e.to} <span className="edge-label">({e.label}{e.state ? ', ' + e.state : ''}{e.note ? ': ' + e.note : ''})</span>
          </div>
        ))}
      </div>
      <div className="edge-section">
        <div className="edge-section-head">入边</div>
        {inEdges.length === 0 && <div className="edge-empty">(无)</div>}
        {inEdges.map((ie, i) => (
          <div key={i} className="edge-row" onClick={() => onClickNode(ie.from)}>
            ← {ie.from} <span className="edge-label">({ie.edge.label})</span>
          </div>
        ))}
      </div>
    </div>
  );
}
