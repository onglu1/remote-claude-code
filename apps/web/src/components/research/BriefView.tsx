import { useState } from 'react';
import { ResearchGraph, renderBrief, renderBriefRich } from '@rcc/research-core';

export function BriefView({ graph }: { graph: ResearchGraph }) {
  const [rich, setRich] = useState(true);
  const text = rich ? renderBriefRich(graph) : renderBrief(graph);
  return (
    <div className="brief-view">
      <div className="brief-toggle">
        <button className={`segbtn ${!rich ? 'active' : ''}`} onClick={() => setRich(false)}>最简</button>
        <button className={`segbtn ${rich ? 'active' : ''}`} onClick={() => setRich(true)}>富版</button>
      </div>
      <pre className="brief-text">{text || '(图为空)'}</pre>
    </div>
  );
}
