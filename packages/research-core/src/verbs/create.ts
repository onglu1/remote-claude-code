import { type ResearchNode, type NodeType, type EvidenceResult } from '../schema';
import { NodeStore } from '../store';
import { nextNumber } from '../numbering';

export interface AddInput {
  type: NodeType;
  title: string;
  parent?: string;
  summary?: string;
  expectation?: string; // task
  result?: EvidenceResult; // evidence(直接 add 时)
  url?: string; // reference
  as?: string; // 显式编号 / citekey;reference 必填
  status?: string;
  now?: string;
}

const DEFAULT_STATUS: Record<NodeType, string | undefined> = {
  thread: 'open',
  idea: 'incubating',
  task: 'todo',
  evidence: 'active',
  reference: undefined,
};

export function addNode(root: string, store: NodeStore, input: AddInput): ResearchNode {
  let number = input.as;
  if (!number) {
    if (input.type === 'reference') throw new Error('reference 必须用 --as 指定 citekey');
    number = nextNumber(root, input.type);
  }
  const id = `${input.type}/${number}`;
  if (store.exists(id)) throw new Error(`节点已存在: ${id}`);
  const now = input.now ?? new Date().toISOString();
  const common = {
    id,
    title: input.title,
    summary: input.summary,
    parent: input.parent,
    edges: [],
    aliases: [],
    kind: [],
    createdAt: now,
    updatedAt: now,
  };
  const status = input.status ?? DEFAULT_STATUS[input.type];
  let node: ResearchNode;
  switch (input.type) {
    case 'thread':
    case 'idea':
      node = { ...common, type: input.type, status } as ResearchNode;
      break;
    case 'task':
      node = { ...common, type: 'task', status, code: [], expectation: input.expectation } as ResearchNode;
      break;
    case 'evidence':
      node = { ...common, type: 'evidence', status, result: input.result, output: [] } as ResearchNode;
      break;
    case 'reference':
      node = { ...common, type: 'reference', url: input.url, citekey: number } as ResearchNode;
      break;
  }
  store.write(node); // schema 校验把关(如 evidence 缺 result → throw)
  return node;
}

export interface SetInput {
  id: string;
  title?: string;
  summary?: string;
  expectation?: string;
  text?: string; // 指向散文文件路径(如 research/text/tasks/007.md);散文内容由人/AI 自由写,CLI 只存指向
  now?: string;
}

export function setNode(store: NodeStore, input: SetInput): ResearchNode {
  const node = store.read(input.id);
  const updated: ResearchNode = { ...node, updatedAt: input.now ?? new Date().toISOString() };
  if (input.title !== undefined) updated.title = input.title;
  if (input.summary !== undefined) updated.summary = input.summary;
  if (input.text !== undefined) updated.text = input.text;
  if (input.expectation !== undefined && updated.type === 'task') updated.expectation = input.expectation;
  store.write(updated);
  return updated;
}
