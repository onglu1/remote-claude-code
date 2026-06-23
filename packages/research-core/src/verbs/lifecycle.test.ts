import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import {
  concludeTask, supersedeNode, invalidateNode, dropNode, blockNode, unblockNode, setStatus,
} from './lifecycle';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-life-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('concludeTask', () => {
  it('标 task done、建 evidence(result/summary)、连 produces 边', () => {
    addNode(root, store, { type: 'task', title: '矩阵', as: '007', now });
    const { task, evidence } = concludeTask(root, store, { task: 'task/007', result: 'positive', summary: '排序确认', now });
    expect(task.type === 'task' && task.status).toBe('done');
    expect(task.edges).toContainEqual({ to: evidence.id, label: 'produces' });
    expect(evidence.type === 'evidence' && evidence.result).toBe('positive');
    expect(evidence.summary).toBe('排序确认');
  });
  it('manifest / output 落到 evidence', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const { evidence } = concludeTask(root, store, { task: 'task/007', result: 'negative', manifest: 'output/007/MANIFEST.json', output: ['output/007'], now });
    expect(evidence.type === 'evidence' && evidence.manifest).toBe('output/007/MANIFEST.json');
    expect(evidence.type === 'evidence' && evidence.output).toEqual(['output/007']);
  });
  it('conclude 非 task → throw', () => {
    addNode(root, store, { type: 'idea', title: 'i', as: '001', now });
    expect(() => concludeTask(root, store, { task: 'idea/001', result: 'positive', now })).toThrow();
  });
});

describe('supersede / invalidate / drop / block / unblock', () => {
  beforeEach(() => {
    addNode(root, store, { type: 'task', title: 'v1', as: '013', now });
    addNode(root, store, { type: 'task', title: 'v2', as: '024', now });
  });
  it('supersede 改双方状态与指针', () => {
    const u = supersedeNode(store, { id: 'task/013', by: 'task/024', now });
    expect(u.type === 'task' && u.status).toBe('superseded');
    expect(u.lifecycle?.supersededBy).toBe('task/024');
    expect(store.read('task/024').lifecycle?.supersedes).toBe('task/013');
  });
  it('supersede --reason 写入 supersededReason(不再误用 invalidatedReason)', () => {
    const u = supersedeNode(store, { id: 'task/013', by: 'task/024', reason: '换更优设计', now });
    expect(u.lifecycle?.supersededReason).toBe('换更优设计');
    expect(u.lifecycle?.invalidatedReason).toBeUndefined();
  });
  it('invalidate 记原因', () => {
    const u = invalidateNode(store, { id: 'task/013', reason: 'fi_server 参数有误', now });
    expect(u.type === 'task' && u.status).toBe('invalidated');
    expect(u.lifecycle?.invalidatedReason).toBe('fi_server 参数有误');
  });
  it('drop 记原因(可对 idea,验证 lifecycle 公共字段)', () => {
    addNode(root, store, { type: 'idea', title: '弃', as: '001', now });
    const u = dropNode(store, { id: 'idea/001', reason: '方向不值得', now });
    expect(u.type === 'idea' && u.status).toBe('dropped');
    expect(u.lifecycle?.droppedReason).toBe('方向不值得');
  });
  it('block 记 blockedOn;unblock 回 active 并清除', () => {
    const b = blockNode(store, { id: 'task/013', on: ['task/024'], now });
    expect(b.type === 'task' && b.status).toBe('blocked');
    expect(b.lifecycle?.blockedOn).toEqual(['task/024']);
    const u = unblockNode(store, { id: 'task/013', now });
    expect(u.type === 'task' && u.status).toBe('active');
    expect(u.lifecycle?.blockedOn).toBeUndefined();
  });
  it('block / unblock 拒绝非 task 类型(thread/idea 状态机无 blocked/active)', () => {
    addNode(root, store, { type: 'idea', title: '想', as: '001', now });
    expect(() => blockNode(store, { id: 'idea/001', on: ['task/024'], now })).toThrow(/仅支持 task/);
    addNode(root, store, { type: 'thread', title: '向', as: '003', now });
    expect(() => unblockNode(store, { id: 'thread/003', now })).toThrow(/仅支持 task \/ evidence/);
  });
});

describe('setStatus', () => {
  it('合法推进 todo→active', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const u = setStatus(store, { id: 'task/007', set: 'active', now });
    expect(u.type === 'task' && u.status).toBe('active');
  });
  it('非法状态(task 设 incubating)→ throw', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    expect(() => setStatus(store, { id: 'task/007', set: 'incubating', now })).toThrow();
  });
  it('reference 无状态 → throw', () => {
    addNode(root, store, { type: 'reference', title: 'r', as: 'k2017', now });
    expect(() => setStatus(store, { id: 'reference/k2017', set: 'active', now })).toThrow();
  });
});
