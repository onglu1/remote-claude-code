import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldResearchRepo } from './scaffold';
import { SCAFFOLD_DIRS } from './layout';

const tmpRoots: string[] = [];
function freshRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-research-'));
  tmpRoots.push(r);
  return r;
}
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('scaffoldResearchRepo', () => {
  it('创建全部规范目录与模板文件', () => {
    const root = freshRoot();
    const report = scaffoldResearchRepo(root, { projectName: 'Demo' });
    for (const d of SCAFFOLD_DIRS) {
      expect(fs.existsSync(path.join(root, d))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('Demo');
    expect(fs.existsSync(path.join(root, 'docs/overview.md'))).toBe(true);
    expect(report.created).toContain('CLAUDE.md');
  });

  it('空目录放 .gitkeep,但 .index 不放', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    expect(fs.existsSync(path.join(root, 'research/nodes/tasks/.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'research/.index/.gitkeep'))).toBe(false);
  });

  it('写入 .gitignore 片段', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('research/.index/');
  });

  it('幂等:再次运行不覆盖已存在文件,记入 skipped', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '我手改过');
    const report = scaffoldResearchRepo(root, { projectName: 'Demo' });
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('我手改过');
    expect(report.skipped).toContain('CLAUDE.md');
  });

  it('force=true 覆盖已存在模板文件', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '旧');
    scaffoldResearchRepo(root, { projectName: 'Demo', force: true });
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('Demo');
  });

  it('不重复追加 .gitignore 片段', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const occurrences = gi.split('research/.index/').length - 1;
    expect(occurrences).toBe(1);
  });

  it('已有 .gitignore 仅在注释里提到路径时仍追加片段', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, '.gitignore'), '# 备注: research/.index/ 是缓存\n');
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain('# --- research workflow ---');
  });

  it('init 同时写出 docs/CLAUDE.md 与 6 份 conventions(并都嵌入项目名)', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    const filesToCheck = [
      'docs/CLAUDE.md',
      'docs/conventions/collaboration.md',
      'docs/conventions/research-workflow.md',
      'docs/conventions/coding.md',
      'docs/conventions/experiments.md',
      'docs/conventions/git.md',
      'docs/conventions/writing.md',
    ];
    for (const p of filesToCheck) {
      const abs = path.join(root, p);
      expect(fs.existsSync(abs), `${p} 应被创建`).toBe(true);
      expect(fs.readFileSync(abs, 'utf8')).toContain('Demo');
    }
  });

  it('CLAUDE.md 入口版只指引读 docs,不再含 rlab 完整动词清单', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('必读文档');
    expect(claudeMd).toContain('docs/conventions/collaboration.md');
    expect(claudeMd).not.toContain('完整动词清单');
    // rlab 完整动词长串只在 research-workflow.md 里出现
    const rwMd = fs.readFileSync(path.join(root, 'docs/conventions/research-workflow.md'), 'utf8');
    expect(rwMd).toContain('完整动词清单');
    expect(rwMd).toContain('affected-by');
  });

  it('force=true 重刷会同时覆盖 CLAUDE.md 与 docs/conventions 下文件', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '旧');
    fs.writeFileSync(path.join(root, 'docs/conventions/coding.md'), '旧 coding');
    scaffoldResearchRepo(root, { projectName: 'Demo', force: true });
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain('Demo');
    expect(fs.readFileSync(path.join(root, 'docs/conventions/coding.md'), 'utf8')).toContain('类型标注');
  });
});
