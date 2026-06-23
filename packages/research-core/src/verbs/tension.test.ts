import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { contradictNodes, resolveContradiction } from './tension';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-tension-'));
  store = new NodeStore(root);
  addNode(root, store, { type: 'evidence', title: 'e1', result: 'positive', as: '005', now });
  addNode(root, store, { type: 'evidence', title: 'e2', result: 'negative', as: '009', now });
  addNode(root, store, { type: 'task', title: '隔离实验', as: '030', now });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('contradictNodes', () => {
  it('双向加 contradicts 边(state=open,可带 note)', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', note: '设置微差', now });
    expect(store.read('evidence/005').edges).toContainEqual({ to: 'evidence/009', label: 'contradicts', state: 'open', note: '设置微差' });
    expect(store.read('evidence/009').edges).toContainEqual({ to: 'evidence/005', label: 'contradicts', state: 'open', note: '设置微差' });
  });
});

describe('resolveContradiction', () => {
  it('双向 contradicts 翻 resolved', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', now });
    const e5 = store.read('evidence/005').edges.find((e) => e.label === 'contradicts');
    expect(e5?.state).toBe('resolved');
  });
  it('--by 时双方加 resolved-by 边指向 task', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', by: 'task/030', now });
    expect(store.read('evidence/005').edges).toContainEqual({ to: 'task/030', label: 'resolved-by' });
    expect(store.read('evidence/009').edges).toContainEqual({ to: 'task/030', label: 'resolved-by' });
  });
  it('反复 resolve --by 同一 task 不会重复加 resolved-by 边', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', by: 'task/030', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', by: 'task/030', now });
    const count = (id: string): number =>
      store.read(id).edges.filter((e) => e.label === 'resolved-by' && e.to === 'task/030').length;
    expect(count('evidence/005')).toBe(1);
    expect(count('evidence/009')).toBe(1);
  });
});
