import { type ResearchNode, type EvidenceResult, type Lifecycle } from '../schema';
import { NodeStore } from '../store';
import { addNode } from './create';

/** 只更新 lifecycle(不碰 status),类型安全。 */
function patchLifecycle(node: ResearchNode, patch: Partial<Lifecycle>, now: string): ResearchNode {
  return { ...node, updatedAt: now, lifecycle: { ...(node.lifecycle ?? {}), ...patch, at: now } };
}
/** 改 status + lifecycle;status 合法性交由 store.write 的 schema 校验。 */
function transition(node: ResearchNode, status: string, patch: Partial<Lifecycle>, now: string): ResearchNode {
  return { ...node, status, updatedAt: now, lifecycle: { ...(node.lifecycle ?? {}), ...patch, at: now } } as ResearchNode;
}

export interface ConcludeInput {
  task: string;
  result: EvidenceResult;
  summary?: string;
  manifest?: string;
  output?: string[];
  as?: string;
  now?: string;
}
export function concludeTask(
  root: string,
  store: NodeStore,
  input: ConcludeInput,
): { task: ResearchNode; evidence: ResearchNode } {
  const task = store.read(input.task);
  if (task.type !== 'task') throw new Error(`conclude 只接受 task: ${input.task}`);
  const now = input.now ?? new Date().toISOString();
  const ev = addNode(root, store, {
    type: 'evidence', title: `${task.title} · 结论`, summary: input.summary, result: input.result, as: input.as, now,
  });
  if (input.manifest !== undefined || (input.output && input.output.length > 0)) {
    store.write({ ...ev, manifest: input.manifest, output: input.output ?? [], updatedAt: now } as ResearchNode);
  }
  const updatedTask = {
    ...task, status: 'done', updatedAt: now, edges: [...task.edges, { to: ev.id, label: 'produces' }],
  } as ResearchNode;
  store.write(updatedTask);
  return { task: updatedTask, evidence: store.read(ev.id) };
}

export interface SupersedeInput { id: string; by: string; reason?: string; now?: string; }
export function supersedeNode(store: NodeStore, input: SupersedeInput): ResearchNode {
  const node = store.read(input.id);
  const by = store.read(input.by);
  const now = input.now ?? new Date().toISOString();
  const patch: Partial<Lifecycle> = { supersededBy: input.by };
  if (input.reason) patch.supersededReason = input.reason;
  const updated = transition(node, 'superseded', patch, now);
  store.write(updated);
  store.write(patchLifecycle(by, { supersedes: input.id }, now));
  return updated;
}

export interface InvalidateInput { id: string; reason: string; now?: string; }
export function invalidateNode(store: NodeStore, input: InvalidateInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'invalidated', { invalidatedReason: input.reason }, now);
  store.write(updated);
  return updated;
}

export interface DropInput { id: string; reason: string; now?: string; }
export function dropNode(store: NodeStore, input: DropInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'dropped', { droppedReason: input.reason }, now);
  store.write(updated);
  return updated;
}

export interface BlockInput { id: string; on: string[]; now?: string; }
/** 阻塞:仅 task 状态机里有 'blocked',故仅 task 适用。 */
export function blockNode(store: NodeStore, input: BlockInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'task') throw new Error(`block 仅支持 task,不支持 ${node.type}`);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'blocked', { blockedOn: input.on }, now);
  store.write(updated);
  return updated;
}

export interface UnblockInput { id: string; now?: string; }
/**
 * 解除阻塞:回 status=active、清 blockedOn。
 * 仅 task / evidence 适用(spec §2.4「task / evidence 可选挂载 lifecycle」)。
 * 其他类型(thread/idea/reference)的状态机里没有 active,显式拒绝。
 */
export function unblockNode(store: NodeStore, input: UnblockInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'task' && node.type !== 'evidence') {
    throw new Error(`unblock 仅支持 task / evidence,不支持 ${node.type}`);
  }
  const now = input.now ?? new Date().toISOString();
  const lifecycle: Lifecycle = { ...(node.lifecycle ?? {}) };
  delete lifecycle.blockedOn;
  const updated = { ...node, status: 'active', updatedAt: now, lifecycle: { ...lifecycle, at: now } } as ResearchNode;
  store.write(updated);
  return updated;
}

export interface StatusInput { id: string; set: string; now?: string; }
export function setStatus(store: NodeStore, input: StatusInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type === 'reference') throw new Error('reference 无状态');
  const updated = { ...node, status: input.set, updatedAt: input.now ?? new Date().toISOString() } as ResearchNode;
  store.write(updated); // schema 校验 status 是否对该 type 合法
  return updated;
}
