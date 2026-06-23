import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldResearchRepo } from './scaffold';
import { checkResearchRepo } from './doctor';
import { NodeStore } from './store';
import type { ResearchNode } from './schema';

let root: string;
const T = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-doctor-'));
  scaffoldResearchRepo(root, { projectName: 'T' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('checkResearchRepo 增强', () => {
  it('干净 scaffold(无节点)→ ok', () => {
    expect(checkResearchRepo(root).ok).toBe(true);
  });
  it('schema 非法的节点 → invalidNodes', () => {
    fs.writeFileSync(path.join(root, 'research/nodes/tasks/007.json'), '{"id":"task/007","type":"task"}');
    const r = checkResearchRepo(root);
    expect(r.ok).toBe(false);
    expect(r.invalidNodes).toContain('research/nodes/tasks/007.json');
  });
  it('边指向不存在节点 → danglingRefs', () => {
    const store = new NodeStore(root);
    const task: ResearchNode = {
      id: 'task/007', type: 'task', title: 't', status: 'todo', code: [],
      edges: [{ to: 'evidence/999', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T,
    };
    store.write(task);
    const r = checkResearchRepo(root);
    expect(r.ok).toBe(false);
    expect(r.danglingRefs).toContain('task/007 → evidence/999');
  });
});
