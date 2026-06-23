import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from './store';
import type { ResearchNode } from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };
const task007: ResearchNode = {
  id: 'task/007', type: 'task', title: '错误类型×位置矩阵', status: 'todo',
  edges: [], aliases: [], kind: [], code: [], ...base,
};
const thread003: ResearchNode = {
  id: 'thread/003', type: 'thread', title: '方向', status: 'open',
  edges: [], aliases: [], kind: [], ...base,
};

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-store-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('NodeStore 往返', () => {
  it('write 后 exists/read 取回等值', () => {
    store.write(task007);
    expect(store.exists('task/007')).toBe(true);
    expect(store.read('task/007').title).toBe('错误类型×位置矩阵');
  });
  it('落盘路径符合 idToPath', () => {
    store.write(task007);
    expect(fs.existsSync(path.join(root, 'research/nodes/tasks/007.json'))).toBe(true);
  });
  it('覆盖写产生 .bak,内容更新', () => {
    store.write(task007);
    store.write({ ...task007, title: '改名' });
    expect(fs.existsSync(path.join(root, 'research/nodes/tasks/007.json.bak'))).toBe(true);
    expect(store.read('task/007').title).toBe('改名');
  });
  it('read 不存在 → throw', () => {
    expect(() => store.read('task/999')).toThrow();
  });
  it('tryRead 不存在 → null', () => {
    expect(store.tryRead('task/999')).toBeNull();
  });
  it('write 非法节点(evidence 缺 result) → throw', () => {
    const bad = { id: 'evidence/005', type: 'evidence', title: 'x', status: 'active',
      edges: [], aliases: [], kind: [], output: [], ...base } as unknown as ResearchNode;
    expect(() => store.write(bad)).toThrow();
  });
});

describe('NodeStore 列举', () => {
  it('list / listByType', () => {
    store.write(task007);
    store.write(thread003);
    expect(store.list()).toHaveLength(2);
    expect(store.listByType('task')).toHaveLength(1);
    expect(store.listByType('idea')).toHaveLength(0);
  });
});
