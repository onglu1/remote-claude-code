import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLegacyDocs, parseTableRows } from './parseLegacy';

const TASKS_INDEX = `# 任务池

| 编号 | 任务 | 优先级 | 来源 |
|---:|---|---|---|
| 003 | ~~[多模型对比](003-diff.md)~~ → 已完成，见 [evidence 003](../evidence/003-diff.md) | 高 | 实验 002 |
| 014 | [Ranger 质量分析](014-quality.md) | 高 | 静态分析 |
| 013 | ~~[倍数扫描](archive/013-sweep.md)~~ → **废弃** | 高 | 012 补充 |
`;

const EVIDENCE_INDEX = `# 证据

| 编号 | 实验 | 核心结论 |
|---:|---|---|
| 003 | [差异化 Ranger](003-diff.md) | H-Guard 优势条件化 |
| 005 | [激活统计](005-stats.md) | 排序确认 |
`;

describe('parseTableRows', () => {
  it('跳过表头与分隔行,只留数据行', () => {
    expect(parseTableRows(TASKS_INDEX)).toHaveLength(3);
    expect(parseTableRows(EVIDENCE_INDEX)).toHaveLength(2);
  });
});

describe('parseLegacyDocs', () => {
  it('解析 task: number/title/status/source/evidenceLinks', () => {
    const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-'));
    fs.mkdirSync(path.join(docsDir, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(docsDir, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'tasks', 'INDEX.md'), TASKS_INDEX);
    fs.writeFileSync(path.join(docsDir, 'evidence', 'INDEX.md'), EVIDENCE_INDEX);

    const r = parseLegacyDocs(docsDir);
    const t003 = r.tasks.find((t) => t.number === '003')!;
    expect(t003.title).toBe('多模型对比');
    expect(t003.status).toBe('done');
    expect(t003.evidenceLinks).toEqual(['003']);
    expect(t003.source).toBe('实验 002');

    const t014 = r.tasks.find((t) => t.number === '014')!;
    expect(t014.status).toBe('todo');

    const t013 = r.tasks.find((t) => t.number === '013')!;
    expect(t013.status).toBe('dropped');

    expect(r.evidence).toHaveLength(2);
    const e003 = r.evidence.find((e) => e.number === '003')!;
    expect(e003.conclusion).toContain('H-Guard');

    fs.rmSync(docsDir, { recursive: true, force: true });
  });

  it('不存在的目录返回空数组(不抛)', () => {
    const r = parseLegacyDocs('/non/existent/path');
    expect(r).toEqual({ tasks: [], evidence: [] });
  });
});
