import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { linkCode, linkOutput } from './attach';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-attach-'));
  store = new NodeStore(root);
  addNode(root, store, { type: 'task', title: 't', as: '007', now });
  addNode(root, store, { type: 'evidence', title: 'e', result: 'positive', as: '005', now });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('linkCode', () => {
  it('给 task 加 code 路径(去重)', () => {
    linkCode(store, { id: 'task/007', path: 'experiments/007_x', now });
    const u = linkCode(store, { id: 'task/007', path: 'experiments/007_x', now });
    expect(u.type === 'task' && u.code).toEqual(['experiments/007_x']);
  });
  it('非 task → throw', () => {
    expect(() => linkCode(store, { id: 'evidence/005', path: 'x', now })).toThrow();
  });
});

describe('linkOutput', () => {
  it('给 evidence 加 output 路径并可设 manifest', () => {
    const u = linkOutput(store, { id: 'evidence/005', path: 'output/005', manifest: 'output/005/MANIFEST.json', now });
    expect(u.type === 'evidence' && u.output).toEqual(['output/005']);
    expect(u.type === 'evidence' && u.manifest).toBe('output/005/MANIFEST.json');
  });
  it('非 evidence → throw', () => {
    expect(() => linkOutput(store, { id: 'task/007', path: 'x', now })).toThrow();
  });
});
