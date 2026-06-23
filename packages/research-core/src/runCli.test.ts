import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './runCli';
import { scaffoldResearchRepo } from './scaffold';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-cli-'));
  scaffoldResearchRepo(root, { projectName: 'T' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('runCli 写读闭环', () => {
  it('add → conclude → brief 全链', () => {
    expect(runCli(['add', 'thread', '--title', '方向', '--as', '003'], root).code).toBe(0);
    expect(runCli(['add', 'task', '--title', '矩阵', '--as', '007', '--parent', 'thread/003'], root).code).toBe(0);
    expect(runCli(['conclude', 'task/007', '--result', 'positive', '--summary', '确认'], root).code).toBe(0);
    const b = runCli(['brief'], root);
    expect(b.stdout).toContain('thread/003');
    expect(b.stdout).toContain('task/007');
  });
  it('show --json 输出结构', () => {
    runCli(['add', 'idea', '--title', '灵感', '--as', '012'], root);
    const data = JSON.parse(runCli(['show', 'idea/012', '--json'], root).stdout);
    expect(data.node.id).toBe('idea/012');
  });
  it('find / list --type', () => {
    runCli(['add', 'task', '--title', '矩阵实验', '--as', '007'], root);
    expect(runCli(['find', '矩阵'], root).stdout).toContain('task/007');
    expect(runCli(['list', '--type', 'task'], root).stdout).toContain('task/007');
  });
  it('写动词后 .index 重建', () => {
    runCli(['add', 'task', '--title', 't', '--as', '007'], root);
    expect(fs.existsSync(path.join(root, 'research/.index/graph.json'))).toBe(true);
  });
  it('未知命令 → code 1', () => {
    expect(runCli(['bogus'], root).code).toBe(1);
  });
  it('动词出错(conclude 不存在 task)→ code 1 且不崩溃', () => {
    expect(runCli(['conclude', 'task/999', '--result', 'positive'], root).code).toBe(1);
  });
  it('doctor 在干净 scaffold → ok(code 0)', () => {
    expect(runCli(['doctor'], root).code).toBe(0);
  });
});

describe('洞察层 CLI 动词', () => {
  it('next 综合多维度', () => {
    runCli(['add', 'task', '--title', 'T', '--as', '001'], root);
    const r = runCli(['next'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task/001');
  });
  it('open 仅 open-task', () => {
    runCli(['add', 'task', '--title', 'T', '--as', '001'], root);
    const r = runCli(['open'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('task/001');
  });
  it('analyze 输出统计', () => {
    runCli(['add', 'thread', '--title', 'D', '--as', '003'], root);
    const r = runCli(['analyze', '--json'], root);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.byType.thread).toBe(1);
  });
  it('affected-by 单点反向闭包', () => {
    runCli(['add', 'task', '--title', 'A', '--as', '001'], root);
    runCli(['add', 'task', '--title', 'B', '--as', '002'], root);
    runCli(['link', 'task/002', 'task/001', '--label', 'depends-on'], root);
    const r = runCli(['affected-by', 'task/001', '--json'], root);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.downstream.map((d: { id: string }) => d.id)).toContain('task/002');
  });
  it('brief --rich 容器附 rollup', () => {
    runCli(['add', 'thread', '--title', 'D', '--as', '003'], root);
    runCli(['add', 'task', '--title', 'T', '--as', '001', '--parent', 'thread/003'], root);
    const r = runCli(['brief', '--rich'], root);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/thread\/003.*\(.*todo.*\)/);
  });
});
