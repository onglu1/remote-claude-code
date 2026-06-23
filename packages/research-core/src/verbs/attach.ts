import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';

export interface LinkCodeInput { id: string; path: string; now?: string; }
export function linkCode(store: NodeStore, input: LinkCodeInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'task') throw new Error('link-code 只接受 task');
  const now = input.now ?? new Date().toISOString();
  const code = node.code.includes(input.path) ? node.code : [...node.code, input.path];
  const updated: ResearchNode = { ...node, code, updatedAt: now };
  store.write(updated);
  return updated;
}

export interface LinkOutputInput { id: string; path: string; manifest?: string; now?: string; }
export function linkOutput(store: NodeStore, input: LinkOutputInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'evidence') throw new Error('link-output 只接受 evidence');
  const now = input.now ?? new Date().toISOString();
  const output = node.output.includes(input.path) ? node.output : [...node.output, input.path];
  const updated: ResearchNode = {
    ...node, output, updatedAt: now, ...(input.manifest ? { manifest: input.manifest } : {}),
  };
  store.write(updated);
  return updated;
}
