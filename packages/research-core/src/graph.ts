import { type ResearchNode, type Edge, type NodeType } from './schema';

export interface InEdge {
  from: string;
  edge: Edge;
}

/** 全量节点构成的内存图:parent 反向(children)、边反向(inbound)、查询。 */
export class ResearchGraph {
  readonly nodes = new Map<string, ResearchNode>();
  private readonly children = new Map<string, string[]>();
  private readonly inbound = new Map<string, InEdge[]>();

  constructor(nodeList: ResearchNode[]) {
    for (const n of nodeList) this.nodes.set(n.id, n);
    for (const n of nodeList) {
      if (n.parent) {
        this.children.set(n.parent, [...(this.children.get(n.parent) ?? []), n.id]);
      }
      for (const e of n.edges) {
        this.inbound.set(e.to, [...(this.inbound.get(e.to) ?? []), { from: n.id, edge: e }]);
      }
    }
  }

  get(id: string): ResearchNode | undefined {
    return this.nodes.get(id);
  }
  childrenOf(id: string): string[] {
    return this.children.get(id) ?? [];
  }
  inEdges(id: string): InEdge[] {
    return this.inbound.get(id) ?? [];
  }
  outEdges(id: string): Edge[] {
    return this.nodes.get(id)?.edges ?? [];
  }

  roots(): ResearchNode[] {
    return [...this.nodes.values()].filter((n) => !n.parent);
  }
  listByType(type: NodeType): ResearchNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }
  listByStatus(status: string): ResearchNode[] {
    return [...this.nodes.values()].filter(
      (n) => 'status' in n && (n as { status?: string }).status === status,
    );
  }

  /** 子串匹配 id/title/summary/aliases/kind,大小写不敏感。 */
  find(query: string): ResearchNode[] {
    const q = query.toLowerCase();
    return [...this.nodes.values()].filter((n) => {
      const hay = [n.id, n.title, n.summary ?? '', ...n.aliases, ...n.kind].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  /** contains 子树(含自身),深度优先。 */
  subtree(id: string): ResearchNode[] {
    const out: ResearchNode[] = [];
    const visit = (cur: string): void => {
      const n = this.nodes.get(cur);
      if (!n) return;
      out.push(n);
      for (const c of this.childrenOf(cur)) visit(c);
    };
    visit(id);
    return out;
  }
}
