import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from './store';
import { rebuildIndex, readIndex, indexPath } from './derivedIndex';
import type { ResearchNode } from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };
const task007: ResearchNode = {
  id: 'task/007', type: 'task', title: '矩阵', status: 'todo',
  edges: [], aliases: [], kind: [], code: [], ...base,
};

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-idx-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('derivedIndex', () => {
  it('rebuild 写出 .index/graph.json 且含全量节点与 builtAt', () => {
    store.write(task007);
    const data = rebuildIndex(root, store, base.updatedAt);
    expect(fs.existsSync(indexPath(root))).toBe(true);
    expect(data.nodes).toHaveLength(1);
    expect(data.builtAt).toBe(base.updatedAt);
  });
  it('readIndex 取回 rebuild 的数据', () => {
    store.write(task007);
    rebuildIndex(root, store, base.updatedAt);
    expect(readIndex(root)?.nodes[0].id).toBe('task/007');
  });
  it('readIndex 缺失 → null', () => {
    expect(readIndex(root)).toBeNull();
  });
  it('rebuild 反映 store 当前快照', () => {
    store.write(task007);
    rebuildIndex(root, store);
    store.write({ ...task007, id: 'task/008' });
    const data = rebuildIndex(root, store);
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['task/007', 'task/008']);
  });
});
