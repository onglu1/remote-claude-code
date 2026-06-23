import { type ResearchNode, type Edge } from '../schema';
import { NodeStore } from '../store';

export interface ContradictInput { a: string; b: string; note?: string; now?: string; }
export function contradictNodes(store: NodeStore, input: ContradictInput): { a: ResearchNode; b: ResearchNode } {
  const a = store.read(input.a);
  const b = store.read(input.b);
  const now = input.now ?? new Date().toISOString();
  const mk = (to: string): Edge =>
    input.note
      ? { to, label: 'contradicts', state: 'open', note: input.note }
      : { to, label: 'contradicts', state: 'open' };
  const ua: ResearchNode = { ...a, updatedAt: now, edges: [...a.edges, mk(input.b)] };
  const ub: ResearchNode = { ...b, updatedAt: now, edges: [...b.edges, mk(input.a)] };
  store.write(ua);
  store.write(ub);
  return { a: ua, b: ub };
}

export interface ResolveInput { a: string; b: string; by?: string; now?: string; }
export function resolveContradiction(store: NodeStore, input: ResolveInput): { a: ResearchNode; b: ResearchNode } {
  const now = input.now ?? new Date().toISOString();
  const flip = (node: ResearchNode, other: string): ResearchNode => {
    const edges: Edge[] = node.edges.map((e) =>
      e.label === 'contradicts' && e.to === other ? { ...e, state: 'resolved' } : e,
    );
    // 反复 resolve 不重复加同 (to,label) 的 resolved-by 边
    if (input.by && !edges.some((e) => e.label === 'resolved-by' && e.to === input.by)) {
      edges.push({ to: input.by, label: 'resolved-by' });
    }
    return { ...node, updatedAt: now, edges };
  };
  const a = flip(store.read(input.a), input.b);
  const b = flip(store.read(input.b), input.a);
  store.write(a);
  store.write(b);
  return { a, b };
}
