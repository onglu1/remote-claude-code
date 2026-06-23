import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { scaffoldResearchRepo } from '../scaffold';
import { importLegacy } from './importLegacy';
import { parseLegacyDocs } from './parseLegacy';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-imp-'));
  scaffoldResearchRepo(root, { projectName: 'Demo' });
  fs.mkdirSync(path.join(root, 'docs', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks', 'INDEX.md'),
    `| 编号 | 任务 | 优先级 | 来源 |\n|---:|---|---|---|\n| 003 | ~~[t](003.md)~~ → 已完成, [evidence 003](../evidence/003.md) | 高 | 实验 002 |\n| 014 | [质量分析](014.md) | 高 | 静态 |\n`);
  fs.writeFileSync(path.join(root, 'docs', 'evidence', 'INDEX.md'),
    `| 编号 | 实验 | 核心结论 |\n|---:|---|---|\n| 003 | [差异化](003.md) | H-Guard 优势 |\n`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('importLegacy', () => {
  it('新建 task + evidence + produces 边', () => {
    const parsed = parseLegacyDocs(path.join(root, 'docs'));
    const store = new NodeStore(root);
    const report = importLegacy(root, store, parsed);

    expect(report.createdTasks.sort()).toEqual(['task/003', 'task/014']);
    expect(report.createdEvidence).toEqual(['evidence/003']);
    expect(report.linksAdded).toBe(1);

    const t003 = store.read('task/003');
    expect(t003.type === 'task' && t003.status).toBe('done');
    expect(t003.summary).toContain('实验 002');
    expect(t003.edges).toContainEqual(expect.objectContaining({ to: 'evidence/003', label: 'produces' }));
  });
  it('幂等:再跑一次全部跳过', () => {
    const parsed = parseLegacyDocs(path.join(root, 'docs'));
    const store = new NodeStore(root);
    importLegacy(root, store, parsed);
    const second = importLegacy(root, store, parsed);
    expect(second.createdTasks).toEqual([]);
    expect(second.createdEvidence).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});
