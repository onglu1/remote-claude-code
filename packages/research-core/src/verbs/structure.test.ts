import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import type { ResearchNode } from '../schema';
import { linkNodes, unlinkNodes, containNode, aliasNode } from './structure';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '方向', status: 'open', edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵', status: 'todo', edges: [], aliases: [], kind: [], code: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '结论', status: 'active', result: 'positive', output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-struct-'));
  store = new NodeStore(root);
  for (const n of nodes) store.write(n);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('linkNodes', () => {
  it('在 from 加自由语义边(含 note)', () => {
    const u = linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', note: '产出', now: T });
    expect(u.edges).toContainEqual({ to: 'evidence/005', label: 'produces', note: '产出' });
  });
  it('to 不存在 → throw', () => {
    expect(() => linkNodes(store, { from: 'task/007', to: 'evidence/999', label: 'x', now: T })).toThrow();
  });
});

describe('unlinkNodes', () => {
  it('删指向 to 的边;带 label 只删该 label', () => {
    linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', now: T });
    linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'supports', now: T });
    const u = unlinkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', now: T });
    expect(u.edges).toEqual([{ to: 'evidence/005', label: 'supports' }]);
  });
});

describe('containNode', () => {
  it('设 parent', () => {
    const u = containNode(store, { child: 'task/007', parent: 'thread/003', now: T });
    expect(u.parent).toBe('thread/003');
  });
  it('--out 解除 parent', () => {
    containNode(store, { child: 'task/007', parent: 'thread/003', now: T });
    const u = containNode(store, { child: 'task/007', now: T });
    expect(u.parent).toBeUndefined();
  });
  it('自包含 → throw', () => {
    expect(() => containNode(store, { child: 'task/007', parent: 'task/007', now: T })).toThrow();
  });
  it('parent 不存在 → throw', () => {
    expect(() => containNode(store, { child: 'task/007', parent: 'thread/999', now: T })).toThrow();
  });
});

describe('aliasNode', () => {
  it('加别名;重复不重复加', () => {
    aliasNode(store, { id: 'task/007', name: 'ORS', now: T });
    const u = aliasNode(store, { id: 'task/007', name: 'ORS', now: T });
    expect(u.aliases).toEqual(['ORS']);
  });
});
