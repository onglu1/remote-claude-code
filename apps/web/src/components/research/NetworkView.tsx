import { useEffect, useRef, useState } from 'react';
import type { ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';

/** 节点形状按类型(用 cytoscape 内置形状,不依赖额外插件)。 */
const TYPE_SHAPE: Record<string, string> = {
  thread: 'round-octagon',     // 主线方向:八边形,显眼
  idea: 'round-diamond',       // 想法:菱形
  task: 'round-rectangle',     // 任务:圆角矩形
  evidence: 'round-tag',       // 证据:tag 形(像便条)
  reference: 'ellipse',        // 文献:椭圆
};

/** 状态颜色:暖色=进行中、绿=完成、灰=待办、红=作废、紫=结晶。 */
const STATUS_COLOR: Record<string, string> = {
  open: '#3b82f6', active: '#3b82f6', incubating: '#f59e0b',
  done: '#10b981', concluded: '#10b981', crystallized: '#8b5cf6',
  todo: '#94a3b8', blocked: '#f97316',
  invalidated: '#ef4444', dropped: '#ef4444',
  superseded: '#a3a3a3', parked: '#cbd5e1',
};

function nodeColor(n: ResearchNode): string {
  if (n.type === 'reference') return '#64748b';
  return STATUS_COLOR[n.status] ?? '#94a3b8';
}

/** 节点尺寸:thread 最大、ref 最小。 */
function nodeSize(n: ResearchNode): { w: number; h: number } {
  if (n.type === 'thread') return { w: 140, h: 80 };
  if (n.type === 'reference') return { w: 90, h: 50 };
  return { w: 120, h: 65 };
}

interface BuildOpts {
  showReference: boolean;
}

function buildElements(graph: ResearchGraph, opts: BuildOpts): ElementDefinition[] {
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];
  const visible = new Set<string>();

  // 第一遍:收集可见节点 id(过滤掉 reference 如果不显示)
  for (const n of graph.nodes.values()) {
    if (n.type === 'reference' && !opts.showReference) continue;
    visible.add(n.id);
  }

  // 第二遍:输出 nodes + edges,但只画"可见 → 可见"的边
  for (const n of graph.nodes.values()) {
    if (!visible.has(n.id)) continue;
    const sz = nodeSize(n);
    // 标签:不截断,让 cytoscape text-wrap 自己处理
    nodes.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: n.title,
        nodeId: n.id,
        type: n.type,
        color: nodeColor(n),
        shape: TYPE_SHAPE[n.type] ?? 'ellipse',
        w: sz.w,
        h: sz.h,
      },
    });
    // parent → child via contains
    if (n.parent && visible.has(n.parent)) {
      edges.push({
        group: 'edges',
        data: { id: `contains-${n.parent}-${n.id}`, source: n.parent, target: n.id, label: '', kind: 'contains' },
      });
    }
    for (const e of n.edges) {
      if (!visible.has(e.to)) continue;
      let kind = e.label;
      if (e.label === 'contradicts') kind = e.state === 'open' ? 'contradicts-open' : 'contradicts-resolved';
      edges.push({
        group: 'edges',
        data: {
          id: `${n.id}-${e.label}-${e.to}-${edges.length}`,
          source: n.id,
          target: e.to,
          label: e.label,
          kind,
        },
      });
    }
  }
  return [...nodes, ...edges];
}

type LayoutName = 'breadthfirst' | 'cose' | 'concentric' | 'circle';

const LAYOUTS: { key: LayoutName; label: string }[] = [
  { key: 'breadthfirst', label: '树形' },
  { key: 'cose', label: '力导' },
  { key: 'concentric', label: '同心' },
  { key: 'circle', label: '环形' },
];

function makeLayout(name: LayoutName): cytoscape.LayoutOptions {
  if (name === 'breadthfirst') {
    return {
      name: 'breadthfirst',
      directed: true,
      padding: 30,
      spacingFactor: 1.4,
      avoidOverlap: true,
      animate: false,
      grid: false,
    } as cytoscape.LayoutOptions;
  }
  if (name === 'cose') {
    return {
      name: 'cose',
      animate: false,
      padding: 30,
      idealEdgeLength: () => 120,
      nodeOverlap: 20,
      nodeRepulsion: () => 8000,
      edgeElasticity: () => 100,
      gravity: 0.25,
    } as unknown as cytoscape.LayoutOptions;
  }
  if (name === 'concentric') {
    return {
      name: 'concentric',
      padding: 30,
      minNodeSpacing: 40,
      animate: false,
    } as cytoscape.LayoutOptions;
  }
  return { name: 'circle', padding: 30, animate: false } as cytoscape.LayoutOptions;
}

export function NetworkView({
  graph, onClickNode,
}: { graph: ResearchGraph; onClickNode: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [showReference, setShowReference] = useState(false);
  const [layoutName, setLayoutName] = useState<LayoutName>('breadthfirst');

  useEffect(() => {
    if (!containerRef.current) return;
    const cy = cytoscape({
      container: containerRef.current,
      elements: buildElements(graph, { showReference }),
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'shape': 'data(shape)' as never,
            'label': 'data(label)',
            // 标签样式:小字号 + 自动换行 + 不超过节点宽度
            'font-size': 10,
            'font-weight': 500,
            'text-wrap': 'wrap',
            'text-max-width': 'data(w)' as never,
            'text-valign': 'center',
            'text-halign': 'center',
            'color': '#fff',
            'text-outline-color': 'data(color)',
            'text-outline-width': 1,
            // 节点尺寸跟随类型(由 data.w/h 控制)
            'width': 'data(w)' as never,
            'height': 'data(h)' as never,
            'border-width': 2,
            'border-color': '#fff',
            'border-opacity': 0.5,
            'padding': '4px' as never,
          },
        },
        {
          selector: 'node[type = "thread"]',
          style: { 'font-size': 12, 'font-weight': 600 } as never,
        },
        {
          selector: 'node:selected',
          style: { 'border-color': '#1d4ed8', 'border-width': 4, 'border-opacity': 1 } as never,
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.9,
            'line-color': '#d4d4d8',
            'target-arrow-color': '#d4d4d8',
            'width': 1.5,
            'font-size': 9,
            'color': '#737373',
            'text-background-color': '#fff',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px' as never,
          },
        },
        { selector: 'edge[kind = "contains"]',           style: { 'line-color': '#52525b', 'target-arrow-color': '#52525b', 'width': 2 } },
        { selector: 'edge[kind = "depends-on"]',         style: { 'line-color': '#737373', 'target-arrow-color': '#737373', 'line-style': 'dashed' } },
        { selector: 'edge[kind = "produces"]',           style: { 'line-color': '#10b981', 'target-arrow-color': '#10b981', 'width': 2.5 } },
        { selector: 'edge[kind = "contradicts-open"]',   style: { 'line-color': '#ef4444', 'target-arrow-color': '#ef4444', 'width': 2, 'line-style': 'dashed' } },
        { selector: 'edge[kind = "contradicts-resolved"]', style: { 'line-color': '#fca5a5', 'target-arrow-color': '#fca5a5' } },
        { selector: 'edge[kind = "motivated-by"]',       style: { 'line-color': '#8b5cf6', 'target-arrow-color': '#8b5cf6' } },
        { selector: 'edge[kind = "supports"]',           style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e' } },
        { selector: 'edge[kind = "refutes"]',            style: { 'line-color': '#f97316', 'target-arrow-color': '#f97316' } },
      ],
      layout: makeLayout(layoutName),
      minZoom: 0.15,
      maxZoom: 3.0,
      // 鼠标滚轮缩放灵敏度。cytoscape 默认 1.0;原来设 0.2 在电脑端滚轮一格几乎看不到变化,
      // 拉高到 1.5 让滚轮一拨明显缩放。手机端走 pinch 不受 wheelSensitivity 影响。
      wheelSensitivity: 1.5,
    });
    cy.on('tap', 'node', (evt) => onClickNode(evt.target.data('nodeId') as string));

    // 关键:layout 完成后,根据容器实际宽高比自动调整布局朝向 + fit。
    // - breadthfirst 默认 TB(top-down):层级竖向、每层节点水平铺开,landscape 容器友好
    // - 但本网页常在 portrait 容器下显示(手机/窄电脑窗口),TB 会让 7 个 task 横向溢出被压扁
    // - 此时把整个布局旋转 90 度(swap x/y),变成 LR 风格,层级横向、每层节点纵向铺开,充分利用竖向空间
    // 力导(cose)、同心、环形是自适应形状的,不需要旋转。
    const fitWithAspect = () => {
      const container = containerRef.current;
      if (!container) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      // 容器明显竖长(高/宽 > 1.2)且当前是 breadthfirst,做 90 度旋转让节点纵向铺开
      const shouldRotate = ch > cw * 1.2 && layoutName === 'breadthfirst';
      if (shouldRotate) {
        cy.batch(() => {
          cy.nodes().forEach((n) => {
            const p = n.position();
            n.position({ x: p.y, y: p.x });
          });
        });
      }
      // fit 时留 5% 边距,让节点尽量铺开
      const pad = Math.max(20, Math.min(cw, ch) * 0.05);
      cy.fit(undefined, pad);
    };
    // 每次 layout 完成都跑一次(初始化 + "重排"按钮都会触发)
    cy.on('layoutstop', fitWithAspect);

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [graph, onClickNode, showReference, layoutName]);

  const refit = () => {
    const cy = cyRef.current;
    const container = containerRef.current;
    if (!cy || !container) return;
    const pad = Math.max(20, Math.min(container.clientWidth, container.clientHeight) * 0.05);
    cy.fit(undefined, pad);
  };
  const relayout = () => cyRef.current?.layout(makeLayout(layoutName)).run();

  return (
    <div className="network-view">
      <div className="network-toolbar">
        <button className="segbtn" onClick={refit}>居中</button>
        <button className="segbtn" onClick={relayout}>重排</button>
        <span className="network-toolbar-sep" />
        <label className="network-checkbox">
          <input
            type="checkbox"
            checked={showReference}
            onChange={(e) => setShowReference(e.target.checked)}
          />
          <span>文献</span>
        </label>
        <span className="network-toolbar-sep" />
        <span className="network-layout-group">
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              className={`segbtn ${layoutName === l.key ? 'active' : ''}`}
              onClick={() => setLayoutName(l.key)}
            >
              {l.label}
            </button>
          ))}
        </span>
        <span className="network-hint">点节点跳详情 · 拖动 · 缩放</span>
      </div>
      <div ref={containerRef} className="network-canvas" />
      <div className="network-legend">
        <span className="legend-item"><span className="legend-dot" style={{ background: '#3b82f6' }} />进行中</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: '#f59e0b' }} />incubating</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: '#10b981' }} />完成</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: '#94a3b8' }} />todo</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: '#ef4444' }} />作废/弃</span>
        <span className="legend-item">
          <span className="legend-edge legend-edge-produces" />produces
        </span>
        <span className="legend-item">
          <span className="legend-edge legend-edge-depends" />depends-on
        </span>
      </div>
    </div>
  );
}
