import { useState } from 'react';
import type { ResearchNode, NodeType } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { ThreadCard } from './ThreadCard';
import { NodeCard } from './NodeCard';
import { StatusBadge } from './StatusBadge';
import { NodeOpsDrawer, type NodeOpsContext } from './NodeOpsDrawer';

const CHILD_TYPES: NodeType[] = ['task', 'idea', 'evidence', 'reference'];
const CHILD_LABEL: Record<NodeType, string> = {
  thread: 'thread', task: 'task', idea: 'idea', evidence: 'evidence', reference: 'reference',
};

export function MapView({
  projectId, graph, onClickNode, onAfterWrite,
}: {
  projectId: string;
  graph: ResearchGraph;
  onClickNode: (id: string) => void;
  onAfterWrite: () => Promise<void> | void;
}) {
  const [drawer, setDrawer] = useState<{ verb: string; context?: NodeOpsContext } | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);

  const threads = graph.listByType('thread').slice().sort((a, b) => a.id.localeCompare(b.id));
  const focused = focusedThread ? graph.get(focusedThread) : null;

  if (focused && focused.type === 'thread') {
    const subtree = graph.subtree(focused.id).filter((n) => n.id !== focused.id);
    const byType: Record<NodeType, ResearchNode[]> = { thread: [], task: [], idea: [], evidence: [], reference: [] };
    for (const n of subtree) byType[n.type].push(n);

    return (
      <div className="thread-detail">
        <button className="back" onClick={() => setFocusedThread(null)}>‹ 返回地图</button>
        <h2 className="thread-detail-title">{focused.id} {focused.title}</h2>
        <StatusBadge node={focused} />
        {focused.summary && <p className="thread-summary">{focused.summary}</p>}

        {CHILD_TYPES.map((t) => byType[t].length > 0 ? (
          <section key={t} className="child-section">
            <h3>{CHILD_LABEL[t]}({byType[t].length})</h3>
            {byType[t].slice().sort((a, b) => a.id.localeCompare(b.id)).map((n) => (
              <NodeCard key={n.id} node={n} onClick={() => onClickNode(n.id)} />
            ))}
          </section>
        ) : null)}

        <button className="fab" onClick={() => setDrawer({ verb: 'add', context: { parent: focused.id } })}>+</button>
        {drawer && (
          <NodeOpsDrawer
            projectId={projectId}
            verb={drawer.verb}
            context={drawer.context}
            graph={graph}
            onClose={() => setDrawer(null)}
            onDone={async () => { setDrawer(null); await onAfterWrite(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="map-view">
      {threads.length === 0 && (
        <div className="map-empty">还没有 thread。点击右下 + 建第一个研究方向。</div>
      )}
      {threads.map((t) => (
        <ThreadCard key={t.id} node={t} graph={graph} onClick={() => setFocusedThread(t.id)} />
      ))}
      <button className="fab" onClick={() => setDrawer({ verb: 'add' })}>+</button>
      {drawer && (
        <NodeOpsDrawer
          projectId={projectId}
          verb={drawer.verb}
          context={drawer.context}
          graph={graph}
          onClose={() => setDrawer(null)}
          onDone={async () => { setDrawer(null); await onAfterWrite(); }}
        />
      )}
    </div>
  );
}
