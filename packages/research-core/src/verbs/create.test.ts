import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode, setNode } from './create';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-create-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('addNode', () => {
  it('add task 分配 001、默认 todo、落盘', () => {
    const n = addNode(root, store, { type: 'task', title: '矩阵', now });
    expect(n.id).toBe('task/001');
    expect(n.type === 'task' && n.status).toBe('todo');
    expect(store.exists('task/001')).toBe(true);
  });
  it('连续 add 递增编号', () => {
    addNode(root, store, { type: 'task', title: 'a', now });
    expect(addNode(root, store, { type: 'task', title: 'b', now }).id).toBe('task/002');
  });
  it('add reference 必须 --as(citekey)', () => {
    expect(() => addNode(root, store, { type: 'reference', title: 'Attn', now })).toThrow();
    const r = addNode(root, store, { type: 'reference', title: 'Attn', as: 'vaswani2017', url: 'http://x', now });
    expect(r.id).toBe('reference/vaswani2017');
  });
  it('add 已存在 id → throw', () => {
    addNode(root, store, { type: 'task', title: 'a', as: '007', now });
    expect(() => addNode(root, store, { type: 'task', title: 'b', as: '007', now })).toThrow();
  });
  it('add evidence 缺 result → schema 拒绝', () => {
    expect(() => addNode(root, store, { type: 'evidence', title: 'e', now })).toThrow();
  });
  it('add evidence 带 result 合法', () => {
    const e = addNode(root, store, { type: 'evidence', title: 'e', result: 'negative', now });
    expect(e.type === 'evidence' && e.result).toBe('negative');
  });
  it('parent / summary 落入节点', () => {
    const n = addNode(root, store, { type: 'idea', title: 'i', parent: 'thread/003', summary: '一句话', now });
    expect(n.parent).toBe('thread/003');
    expect(n.summary).toBe('一句话');
  });
});

describe('setNode', () => {
  it('改 title/summary 并刷新 updatedAt', () => {
    addNode(root, store, { type: 'task', title: '旧', as: '007', now });
    const later = '2026-06-23T00:00:00.000Z';
    const u = setNode(store, { id: 'task/007', title: '新', summary: '摘要', text: 'research/text/tasks/007.md', now: later });
    expect(u.title).toBe('新');
    expect(u.summary).toBe('摘要');
    expect(u.text).toBe('research/text/tasks/007.md');
    expect(u.updatedAt).toBe(later);
  });
  it('expectation 仅对 task 生效', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const u = setNode(store, { id: 'task/007', expectation: '预期阳性', now });
    expect(u.type === 'task' && u.expectation).toBe('预期阳性');
  });
});
