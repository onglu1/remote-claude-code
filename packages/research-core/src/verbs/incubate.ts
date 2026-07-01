import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';
import { addNode } from './create';

export interface SplitInput {
  id: string;
  into: string[];
  now?: string;
}
export function splitIdea(root: string, store: NodeStore, input: SplitInput): ResearchNode[] {
  const origin = store.read(input.id);
  if (origin.type !== 'idea') throw new Error(`split 只接受 idea: ${input.id}`);
  const created: ResearchNode[] = [];
  for (const title of input.into) {
    created.push(addNode(root, store, { type: 'idea', title, parent: input.id, now: input.now }));
  }
  return created;
}

export interface MergeInput {
  ids: string[];
  title: string;
  now?: string;
}
export function mergeIdeas(root: string, store: NodeStore, input: MergeInput): ResearchNode {
  if (input.ids.length === 0) throw new Error('merge 至少需要一个 idea');
  // 先全量校验(失败则不建 task,保持原子)
  const ideas = input.ids.map((id) => {
    const n = store.read(id);
    if (n.type !== 'idea') throw new Error(`merge 只接受 idea: ${id}`);
    return n;
  });
  const now = input.now ?? new Date().toISOString();
  const task = addNode(root, store, { type: 'task', title: input.title, now });
  for (const idea of ideas) {
    store.write({
      ...idea,
      status: 'crystallized',
      updatedAt: now,
      edges: [...idea.edges, { to: task.id, label: 'crystallized-into' }],
    });
  }
  return task;
}
