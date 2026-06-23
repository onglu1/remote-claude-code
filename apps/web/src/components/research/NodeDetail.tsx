import { useEffect, useState } from 'react';
import type { ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { StatusBadge } from './StatusBadge';
import { EdgeList } from './EdgeList';
import { NodeOpsDrawer } from './NodeOpsDrawer';
import { Markdown } from '../chat/markdown';
import { researchApi } from '../../lib/researchApi';

type Verb =
  | 'set' | 'link' | 'unlink' | 'status' | 'contain' | 'alias'
  | 'conclude' | 'supersede' | 'invalidate' | 'drop' | 'block' | 'unblock'
  | 'contradict' | 'resolve' | 'link-code' | 'link-output' | 'split' | 'merge';

const COMMON: Verb[] = ['set', 'link', 'unlink', 'status', 'contain', 'alias', 'invalidate', 'drop', 'supersede', 'contradict', 'resolve'];

function verbsFor(node: ResearchNode): Verb[] {
  if (node.type === 'task') return [...COMMON, 'conclude', 'block', 'unblock', 'link-code'];
  if (node.type === 'evidence') return [...COMMON, 'block', 'unblock', 'link-output'];
  if (node.type === 'idea') return [...COMMON, 'split', 'merge'];
  if (node.type === 'reference') return ['set', 'link', 'unlink', 'alias'];
  // thread
  return [...COMMON.filter((v) => v !== 'supersede' && v !== 'invalidate'), 'status'];
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function NodeDetail({
  projectId, node, graph, onClickNode, onBack, onAfterWrite,
}: {
  projectId: string;
  node: ResearchNode;
  graph: ResearchGraph;
  onClickNode: (id: string) => void;
  onBack: () => void;
  onAfterWrite: () => Promise<void> | void;
}) {
  const [drawer, setDrawer] = useState<{ verb: Verb } | null>(null);
  const [opsOpen, setOpsOpen] = useState(false);
  const [proseText, setProseText] = useState<string | null>(null);
  const [prosePath, setProsePath] = useState<string>('');
  const verbs = verbsFor(node);
  const inEdges = graph.inEdges(node.id);

  // 节点切换时拉取 research/text/<id>.md(若存在)
  useEffect(() => {
    let alive = true;
    setProseText(null);
    setProsePath('');
    researchApi.nodeText(projectId, node.id).then((r) => {
      if (!alive) return;
      setProsePath(r.path);
      setProseText(r.exists ? r.content : null);
    }).catch(() => {
      if (!alive) return;
      setProseText(null);
    });
    return () => { alive = false; };
  }, [projectId, node.id]);

  // contains 子节点(从图反向派生)
  const children: ResearchNode[] = [];
  for (const n of graph.nodes.values()) {
    if (n.parent === node.id) children.push(n);
  }

  return (
    <div className="node-detail">
      <button className="back" onClick={onBack}>‹ 返回</button>
      <div className="node-detail-head">
        <span className="node-detail-id">{node.id}</span>
        <span className={`node-type-pill nt-${node.type}`}>{node.type}</span>
        <StatusBadge node={node} />
      </div>
      <h2 className="node-detail-title">{node.title}</h2>

      {/* 主要内容:summary 用 Markdown 渲染保留排版 */}
      {node.summary && (
        <div className="node-summary-box">
          <Markdown>{node.summary}</Markdown>
        </div>
      )}

      {/* task 特有字段 */}
      {node.type === 'task' && node.expectation && (
        <div className="node-field-block">
          <div className="node-field-label">预期</div>
          <div className="node-field-body"><Markdown>{node.expectation}</Markdown></div>
        </div>
      )}

      {/* evidence 特有字段 */}
      {node.type === 'evidence' && (
        <div className="node-field-block">
          <div className="node-field-label">结果</div>
          <div className={`node-field-body evidence-result-pill r-${node.result}`}>{node.result}</div>
        </div>
      )}

      {/* reference 特有字段 */}
      {node.type === 'reference' && node.url && (
        <div className="node-field-block">
          <div className="node-field-label">链接</div>
          <a className="node-field-body link-like" href={node.url} target="_blank" rel="noreferrer">{node.url}</a>
        </div>
      )}
      {node.type === 'reference' && node.citekey && (
        <div className="node-field-block">
          <div className="node-field-label">citekey</div>
          <code className="node-field-body">{node.citekey}</code>
        </div>
      )}

      {/* 通用元数据 */}
      {node.kind.length > 0 && (
        <div className="node-field-block">
          <div className="node-field-label">kind</div>
          <div className="node-field-body kind-tags">
            {node.kind.map((k) => <span key={k} className="kind-tag-pill">{k}</span>)}
          </div>
        </div>
      )}
      {node.aliases.length > 0 && (
        <div className="node-field-block">
          <div className="node-field-label">别名</div>
          <div className="node-field-body">{node.aliases.map((a) => <code key={a} className="alias-pill">{a}</code>)}</div>
        </div>
      )}
      {node.parent && (
        <div className="node-field-block">
          <div className="node-field-label">归属</div>
          <a className="node-field-body link-like" onClick={() => onClickNode(node.parent!)}>{node.parent}</a>
        </div>
      )}
      {node.type === 'task' && node.code.length > 0 && (
        <div className="node-field-block">
          <div className="node-field-label">代码</div>
          <div className="node-field-body">{node.code.map((c) => <code key={c} className="path-pill">{c}</code>)}</div>
        </div>
      )}
      {node.type === 'evidence' && node.output.length > 0 && (
        <div className="node-field-block">
          <div className="node-field-label">产物</div>
          <div className="node-field-body">{node.output.map((c) => <code key={c} className="path-pill">{c}</code>)}</div>
        </div>
      )}
      {node.type === 'evidence' && node.manifest && (
        <div className="node-field-block">
          <div className="node-field-label">MANIFEST</div>
          <code className="node-field-body path-pill">{node.manifest}</code>
        </div>
      )}

      {/* lifecycle 信息 */}
      {node.lifecycle && (
        <div className="node-field-block lifecycle-block">
          <div className="node-field-label">生命周期</div>
          <div className="node-field-body">
            {node.lifecycle.supersededBy && <div>被 <a className="link-like" onClick={() => onClickNode(node.lifecycle!.supersededBy!)}>{node.lifecycle.supersededBy}</a> 取代{node.lifecycle.supersededReason ? `(${node.lifecycle.supersededReason})` : ''}</div>}
            {node.lifecycle.supersedes && <div>取代了 <a className="link-like" onClick={() => onClickNode(node.lifecycle!.supersedes!)}>{node.lifecycle.supersedes}</a></div>}
            {node.lifecycle.invalidatedReason && <div>作废原因:{node.lifecycle.invalidatedReason}</div>}
            {node.lifecycle.droppedReason && <div>丢弃原因:{node.lifecycle.droppedReason}</div>}
            {node.lifecycle.blockedOn && node.lifecycle.blockedOn.length > 0 && (
              <div>阻塞于:{node.lifecycle.blockedOn.map((b) => <a key={b} className="link-like" onClick={() => onClickNode(b)}>{b}</a>)}</div>
            )}
          </div>
        </div>
      )}

      {/* 时间戳(简洁置于元数据下方) */}
      <div className="node-timestamps">
        创建 {formatTimestamp(node.createdAt)} · 更新 {formatTimestamp(node.updatedAt)}
      </div>

      {/* 子节点(contains 反向) */}
      {children.length > 0 && (
        <div className="child-section">
          <h3>包含节点 ({children.length})</h3>
          {children.map((c) => (
            <div key={c.id} className="child-row" onClick={() => onClickNode(c.id)}>
              <span className="child-id">{c.id}</span>
              <span className="child-title">{c.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* 边关系 */}
      <EdgeList outEdges={node.edges} inEdges={inEdges} onClickNode={onClickNode} />

      {/* 散文 markdown(research/text/<id>.md 若存在) */}
      {proseText !== null && (
        <div className="prose-section">
          <h3>散文版 <code className="prose-path">{prosePath}</code></h3>
          <div className="prose-body">
            <Markdown>{proseText}</Markdown>
          </div>
        </div>
      )}
      {proseText === null && prosePath && (
        <div className="prose-section prose-empty">
          <h3>散文版</h3>
          <div className="prose-hint">
            可在 <code>{prosePath}</code> 写一份给人读的散文(rlab 不会解析它的结构,只是供展示)
          </div>
        </div>
      )}

      {/* 操作按钮折叠面板 */}
      <div className="node-ops-section">
        <button className="node-ops-toggle" onClick={() => setOpsOpen(!opsOpen)}>
          {opsOpen ? '▾' : '▸'} 操作 ({verbs.length})
        </button>
        {opsOpen && (
          <div className="node-ops">
            {verbs.map((v) => (
              <button key={v} className="op-btn" onClick={() => setDrawer({ verb: v })}>{v}</button>
            ))}
          </div>
        )}
      </div>

      {drawer && (
        <NodeOpsDrawer
          projectId={projectId}
          verb={drawer.verb}
          context={{ subject: node.id }}
          graph={graph}
          onClose={() => setDrawer(null)}
          onDone={async () => { setDrawer(null); await onAfterWrite(); }}
        />
      )}
    </div>
  );
}
