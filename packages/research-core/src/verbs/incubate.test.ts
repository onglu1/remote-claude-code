import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { splitIdea, mergeIdeas } from './incubate';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-incub-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('splitIdea', () => {
  it('在原 idea 下建子 idea(parent 指向原 idea、递增编号)', () => {
    addNode(root, store, { type: 'idea', title: '模糊直觉', as: '001', now });
    const kids = splitIdea(root, store, { id: 'idea/001', into: ['子A', '子B'], now });
    expect(kids.map((k) => k.id)).toEqual(['idea/002', 'idea/003']);
    expect(kids.every((k) => k.parent === 'idea/001')).toBe(true);
    expect(kids[0].type).toBe('idea');
  });
  it('原 idea 不存在 → throw', () => {
    expect(() => splitIdea(root, store, { id: 'idea/099', into: ['x'], now })).toThrow();
  });
});

describe('mergeIdeas', () => {
  it('凝成 task,被并 idea 标 crystallized 并加 crystallized-into 边', () => {
    addNode(root, store, { type: 'idea', title: 'i1', as: '001', now });
    addNode(root, store, { type: 'idea', title: 'i2', as: '002', now });
    const task = mergeIdeas(root, store, { ids: ['idea/001', 'idea/002'], title: '凝成实验', now });
    expect(task.id).toBe('task/001');
    expect(task.type === 'task' && task.status).toBe('todo');
    const i1 = store.read('idea/001');
    expect(i1.type === 'idea' && i1.status).toBe('crystallized');
    expect(i1.edges).toContainEqual({ to: 'task/001', label: 'crystallized-into' });
  });
  it('被并含非 idea → throw,且不建出半成品 task', () => {
    addNode(root, store, { type: 'task', title: 't', as: '009', now });
    expect(() => mergeIdeas(root, store, { ids: ['task/009'], title: 'x', now })).toThrow();
    expect(store.exists('task/001')).toBe(false);
  });
  it('空 ids → throw', () => {
    expect(() => mergeIdeas(root, store, { ids: [], title: 'x', now })).toThrow();
  });
});
