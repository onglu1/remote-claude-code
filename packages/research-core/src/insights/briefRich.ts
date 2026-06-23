import type { ResearchGraph } from '../graph';
import type { ResearchNode } from '../schema';
import type { RichBriefLine } from './types';

const RESULT_SYMBOL: Record<string, string> = {
  positive: '+', negative: '-', inconclusive: '?', mixed: '±',
};

function statusTag(node: ResearchNode): string {
  if (node.type === 'reference') return 'ref';
  if (node.type === 'evidence') {
    const sym = RESULT_SYMBOL[node.result] ?? '';
    return `${node.status} ${sym}`.trim();
  }
  return node.status;
}

/** 容器卷起:子树(不含自身)状态计数 / 未解张力数 / 最新 evidence 结果。 */
function buildRollup(graph: ResearchGraph, containerId: string): string | undefined {
  const sub = graph.subtree(containerId).filter((n) => n.id !== containerId);
  if (sub.length === 0) return undefined;
  const statusCount = new Map<string, number>();
  let openTensions = 0;
  let latest: { at: string; result: string } | null = null;
  for (const n of sub) {
    if (n.type !== 'reference') {
      statusCount.set(n.status, (statusCount.get(n.status) ?? 0) + 1);
    }
    for (const e of n.edges) {
      if (e.label === 'contradicts' && e.state === 'open') openTensions++;
    }
    if (n.type === 'evidence') {
      if (!latest || n.updatedAt > latest.at) latest = { at: n.updatedAt, result: n.result };
    }
  }
  const parts: string[] = [];
  if (statusCount.size > 0) {
    parts.push([...statusCount.entries()].map(([s, c]) => `${c} ${s}`).join(' / '));
  }
  if (openTensions > 0) parts.push(`${openTensions} 张力`);
  if (latest) parts.push(`最新 ${RESULT_SYMBOL[latest.result] ?? latest.result}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 派生富 brief 数据(纯)。 */
export function buildRichBrief(graph: ResearchGraph): RichBriefLine[] {
  const lines: RichBriefLine[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = graph.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    lines.push({
      id,
      depth,
      statusTag: statusTag(node),
      title: node.title,
      rollup: buildRollup(graph, id),
    });
    for (const c of graph.childrenOf(id).slice().sort()) visit(c, depth + 1);
  };
  const all = [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of all) if (!n.parent) visit(n.id, 0);
  for (const n of all) if (!seen.has(n.id)) visit(n.id, 0);
  return lines;
}

/** 渲染为文本,容器行后附 (rollup)。可选 maxBytes 截断。 */
export function renderBriefRich(graph: ResearchGraph, maxBytes?: number): string {
  const rawLines = buildRichBrief(graph).map((l) => {
    const indent = '  '.repeat(l.depth);
    const head = `${indent}${l.id} [${l.statusTag}] ${l.title}`;
    return l.rollup ? `${head}  (${l.rollup})` : head;
  });
  if (!maxBytes) return rawLines.join('\n');
  const out: string[] = [];
  const TAIL = '… (截断)';
  const tailBytes = Buffer.byteLength(TAIL + '\n', 'utf8');
  let bytes = 0;
  for (const line of rawLines) {
    const b = Buffer.byteLength(line + '\n', 'utf8');
    if (bytes + b + tailBytes > maxBytes) break;
    out.push(line);
    bytes += b;
  }
  if (out.length < rawLines.length) out.push(TAIL);
  return out.join('\n');
}
