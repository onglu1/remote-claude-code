import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';

function touch(node: ResearchNode, now?: string): ResearchNode {
  return { ...node, updatedAt: now ?? new Date().toISOString() };
}

export interface LinkInput {
  from: string;
  to: string;
  label: string;
  note?: string;
  now?: string;
}
export function linkNodes(store: NodeStore, input: LinkInput): ResearchNode {
  const from = store.read(input.from);
  store.read(input.to); // 校验 to 存在
  const edge = input.note
    ? { to: input.to, label: input.label, note: input.note }
    : { to: input.to, label: input.label };
  const updated = { ...touch(from, input.now), edges: [...from.edges, edge] };
  store.write(updated);
  return updated;
}

export interface UnlinkInput {
  from: string;
  to: string;
  label?: string;
  now?: string;
}
export function unlinkNodes(store: NodeStore, input: UnlinkInput): ResearchNode {
  const from = store.read(input.from);
  const edges = from.edges.filter(
    (e) => !(e.to === input.to && (input.label === undefined || e.label === input.label)),
  );
  const updated = { ...touch(from, input.now), edges };
  store.write(updated);
  return updated;
}

export interface ContainInput {
  child: string;
  parent?: string; // undefined = 解除
  now?: string;
}
export function containNode(store: NodeStore, input: ContainInput): ResearchNode {
  const child = store.read(input.child);
  if (input.parent !== undefined) {
    if (input.parent === input.child) throw new Error('节点不能包含自身');
    store.read(input.parent); // 校验 parent 存在
  }
  const updated: ResearchNode = { ...touch(child, input.now), parent: input.parent };
  store.write(updated);
  return updated;
}

export interface AliasInput {
  id: string;
  name: string;
  now?: string;
}
export function aliasNode(store: NodeStore, input: AliasInput): ResearchNode {
  const node = store.read(input.id);
  if (node.aliases.includes(input.name)) return node;
  const updated = { ...touch(node, input.now), aliases: [...node.aliases, input.name] };
  store.write(updated);
  return updated;
}
