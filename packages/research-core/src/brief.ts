import { type ResearchGraph } from './graph';
import { type ResearchNode } from './schema';

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

function line(node: ResearchNode, depth: number): string {
  return `${'  '.repeat(depth)}${node.id} [${statusTag(node)}] ${node.title}`;
}

/** 遍历 contains 树缩进渲染;seen 去重 + 兜底孤儿。纯计算。 */
export function renderBrief(graph: ResearchGraph): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = graph.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    lines.push(line(node, depth));
    for (const child of graph.childrenOf(id).slice().sort()) visit(child, depth + 1);
  };
  const all = [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of all) if (!n.parent) visit(n.id, 0);
  for (const n of all) if (!seen.has(n.id)) visit(n.id, 0); // 兜底:parent 缺失的孤儿
  return lines.join('\n');
}
