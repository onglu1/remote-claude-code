import { useEffect, useState, useCallback } from 'react';
import type { Project, ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { researchApi } from '../../lib/researchApi';
import { EmptyState } from './EmptyState';
import { MapView } from './MapView';
import { NextView } from './NextView';
import { AnalyzeView } from './AnalyzeView';
import { BriefView } from './BriefView';
import { NetworkView } from './NetworkView';
import { NodeDetail } from './NodeDetail';

type SubView = 'map' | 'next' | 'analyze' | 'brief' | 'network';

const SUB_LABEL: Record<SubView, string> = { map: '地图', network: '网络', next: '待办', analyze: '体检', brief: 'Brief' };

export function ResearchView({ project }: { project: Project }) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [nodes, setNodes] = useState<ResearchNode[] | null>(null);
  const [view, setView] = useState<SubView>('map');
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const s = await researchApi.initStatus(project.id);
      setInitialized(s.initialized);
      if (s.initialized) {
        const g = await researchApi.graph(project.id);
        setNodes(g.nodes);
      } else {
        setNodes([]);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [project.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // 自动同步:每 10 秒静默拉 graph,只在节点数或 max(updatedAt) 变化时才 re-render。
  useEffect(() => {
    if (initialized !== true) return;
    let alive = true;
    const handle = window.setInterval(async () => {
      if (!alive) return;
      try {
        const g = await researchApi.graph(project.id);
        if (!alive) return;
        const prevSig = nodes ? `${nodes.length}|${nodes.map((n) => n.updatedAt).sort().reverse()[0] ?? ''}` : '';
        const nextSig = `${g.nodes.length}|${g.nodes.map((n) => n.updatedAt).sort().reverse()[0] ?? ''}`;
        if (prevSig !== nextSig) setNodes(g.nodes);
      } catch { /* 静默,网络抖动等不打扰用户 */ }
    }, 10_000);
    return () => { alive = false; window.clearInterval(handle); };
  }, [initialized, nodes, project.id]);

  if (err) return <div className="research-err">{err}</div>;
  if (initialized === null) return <div className="research-loading">加载中…</div>;
  if (!initialized) return <EmptyState projectId={project.id} onInitialized={refresh} />;
  if (!nodes) return <div className="research-loading">加载中…</div>;

  const graph = new ResearchGraph(nodes);
  const focusedNode = focusedNodeId ? graph.get(focusedNodeId) : null;

  const goNode = (id: string) => { setFocusedNodeId(id); };
  const backFromNode = () => setFocusedNodeId(null);

  return (
    <div className="research-view">
      <div className="research-tabs">
        {(['map', 'network', 'next', 'analyze', 'brief'] as const).map((v) => (
          <button key={v} className={`segbtn ${view === v && !focusedNode ? 'active' : ''}`}
            onClick={() => { setFocusedNodeId(null); setView(v); }}>
            {SUB_LABEL[v]}
          </button>
        ))}
      </div>
      <div className="research-sync-hint">自动同步中(每 10 秒)</div>
      <div className="research-content">
        {focusedNode ? (
          <NodeDetail
            projectId={project.id}
            node={focusedNode}
            graph={graph}
            onClickNode={goNode}
            onBack={backFromNode}
            onAfterWrite={refresh}
          />
        ) : (
          <>
            {view === 'map' && <MapView projectId={project.id} graph={graph} onClickNode={goNode} onAfterWrite={refresh} />}
            {view === 'network' && <NetworkView graph={graph} onClickNode={goNode} />}
            {view === 'next' && <NextView graph={graph} onClickNode={goNode} />}
            {view === 'analyze' && <AnalyzeView graph={graph} />}
            {view === 'brief' && <BriefView graph={graph} />}
          </>
        )}
      </div>
    </div>
  );
}
