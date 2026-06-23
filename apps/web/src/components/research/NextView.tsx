import { useState } from 'react';
import type { NextItem } from '@rcc/shared';
import { ResearchGraph, nextAll } from '@rcc/research-core';

const KIND_LABEL: Record<NextItem['kind'] | 'all', string> = {
  all: '全部',
  'open-task': '待办 task',
  tension: '张力',
  stale: '受拖累',
  orphan: '孤儿',
  'stagnant-thread': '停滞',
};

export function NextView({ graph, onClickNode }: { graph: ResearchGraph; onClickNode: (id: string) => void }) {
  const [kind, setKind] = useState<NextItem['kind'] | 'all'>('all');
  const items = nextAll(graph, kind === 'all' ? {} : { kinds: [kind] });

  return (
    <div className="next-view">
      <div className="kind-chips">
        {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((k) => (
          <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {items.length === 0 && <div className="next-empty">(没有该维度的待办)</div>}
      {items.map((it, i) => (
        <div key={i} className="next-row" onClick={() => onClickNode(it.id)} role="button">
          <span className={`kind-tag k-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
          <span className="next-id">{it.id}</span>
          <span className="next-title">{it.title}</span>
          <div className="next-reason">→ {it.reason}</div>
        </div>
      ))}
    </div>
  );
}
