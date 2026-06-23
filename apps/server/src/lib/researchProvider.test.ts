import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchProviderRegistry } from './researchProvider';
import { scaffoldResearchRepo, addNode } from '@rcc/research-core';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-rp-'));
  scaffoldResearchRepo(root, { projectName: 'Demo' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ResearchProviderRegistry', () => {
  it('store(path) 返回同一个 NodeStore 实例(惰性建,缓存)', () => {
    const reg = new ResearchProviderRegistry();
    const s1 = reg.store(root);
    const s2 = reg.store(root);
    expect(s1).toBe(s2);
  });
  it('graph(path) 全量加载并缓存', () => {
    const reg = new ResearchProviderRegistry();
    addNode(root, reg.store(root), { type: 'thread', title: 'T1', as: '001' });
    const g1 = reg.graph(root);
    const g2 = reg.graph(root);
    expect(g1).toBe(g2);
    expect(g1.get('thread/001')?.title).toBe('T1');
  });
  it('invalidate 后下次 graph() 重新加载', () => {
    const reg = new ResearchProviderRegistry();
    const store = reg.store(root);
    addNode(root, store, { type: 'thread', title: 'T1', as: '001' });
    const g1 = reg.graph(root);
    addNode(root, store, { type: 'task', title: 'T2', as: '001' });
    reg.invalidate(root);
    const g2 = reg.graph(root);
    expect(g2).not.toBe(g1);
    expect(g2.nodes.size).toBe(2);
  });
  it('initialized(path):scaffold 后 true,不存在路径 false', () => {
    const reg = new ResearchProviderRegistry();
    expect(reg.initialized(root)).toBe(true);
    expect(reg.initialized('/nonexistent-/x/y/z')).toBe(false);
  });
});
