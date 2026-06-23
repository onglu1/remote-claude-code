import { ResearchGraph, analyzeGraph } from '@rcc/research-core';

function Bar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export function AnalyzeView({ graph }: { graph: ResearchGraph }) {
  const s = analyzeGraph(graph);
  const statusTotal = Object.values(s.byStatus).reduce((a, b) => a + b, 0);
  return (
    <div className="analyze-view">
      <div className="analyze-totals">
        节点 <b>{s.totals.nodes}</b> · 边 <b>{s.totals.edges}</b> · contains 树 <b>{s.totals.containsTrees}</b>
      </div>

      <section className="analyze-section">
        <h3>类型分布</h3>
        {Object.entries(s.byType).map(([t, c]) => (
          <Bar key={t} label={t} value={c} total={s.totals.nodes} />
        ))}
      </section>

      <section className="analyze-section">
        <h3>状态分布</h3>
        {Object.entries(s.byStatus).map(([st, c]) => (
          <Bar key={st} label={st} value={c} total={statusTotal} />
        ))}
      </section>

      <section className="analyze-section">
        <h3>问题清单</h3>
        <div className="issue-row"><b>孤儿:</b> {s.orphans.length === 0 ? '(无)' : s.orphans.join(', ')}</div>
        <div className="issue-row"><b>断链:</b> {s.dangling.length === 0 ? '(无)' : s.dangling.join(', ')}</div>
        <div className="issue-row"><b>未解张力对:</b> {s.openTensions}</div>
        <div className="issue-row"><b>停滞方向:</b> {s.stagnantThreads.length === 0 ? '(无)' : s.stagnantThreads.join(', ')}</div>
      </section>
    </div>
  );
}
