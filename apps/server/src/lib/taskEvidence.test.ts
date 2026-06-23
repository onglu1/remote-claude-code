import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskEvidenceStore, parseTableRows } from './taskEvidence';

let docs: string;

const TASKS_INDEX = `# 待验证任务池

| 编号 | 任务 | 优先级 | 来源 |
|---:|---|---|---|
| 003 | ~~[多模型对比](003-diff.md)~~ → 已完成，见 [evidence 003](../evidence/003-diff.md) | 高 | 实验 002 |
| 014 | [Ranger 质量分析](014-quality.md) | 高 | 静态分析 |
| 013 | ~~[倍数扫描](archive/013-sweep.md)~~ → **废弃** | 高 | 012 补充 |
`;

const EVIDENCE_INDEX = `# 实验证据索引

| 编号 | 实验 | 核心结论 |
|---:|---|---|
| 003 | [差异化 Ranger](003-diff.md) | H-Guard 优势条件化 |
`;

beforeEach(() => {
  docs = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-te-'));
  fs.mkdirSync(path.join(docs, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(docs, 'tasks', 'INDEX.md'), TASKS_INDEX);
  fs.writeFileSync(path.join(docs, 'evidence', 'INDEX.md'), EVIDENCE_INDEX);
});

afterEach(() => fs.rmSync(docs, { recursive: true, force: true }));

describe('parseTableRows', () => {
  it('跳过表头与分隔行', () => {
    expect(parseTableRows(TASKS_INDEX)).toHaveLength(3);
  });
});

describe('TaskEvidenceStore', () => {
  it('解析 task 编号/标题/状态/链接', () => {
    const tasks = new TaskEvidenceStore(docs).getTasks();
    const t003 = tasks.find((t) => t.number === '003')!;
    expect(t003.title).toBe('多模型对比');
    expect(t003.status).toBe('done');
    expect(t003.evidenceLinks).toContain('003');
    const t014 = tasks.find((t) => t.number === '014')!;
    expect(t014.status).toBe('todo');
    const t013 = tasks.find((t) => t.number === '013')!;
    expect(t013.status).toBe('dropped');
  });

  it('evidence 反向关联 task', () => {
    const ev = new TaskEvidenceStore(docs).getEvidence();
    expect(ev.find((e) => e.number === '003')!.taskLinks).toContain('003');
  });

  it('patchTask 写侧车并覆盖状态，正文不变', () => {
    const before = fs.readFileSync(path.join(docs, 'tasks', 'INDEX.md'), 'utf8');
    const store = new TaskEvidenceStore(docs);
    store.patchTask('014', { status: 'doing', tags: ['priority'] });
    const t014 = store.getTasks().find((t) => t.number === '014')!;
    expect(t014.status).toBe('doing');
    expect(t014.tags).toContain('priority');
    // INDEX.md 原文未被改动
    expect(fs.readFileSync(path.join(docs, 'tasks', 'INDEX.md'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(docs, '.rcc-meta.json'))).toBe(true);
  });
});
