import { describe, it, expect } from 'vitest';
import { SCAFFOLD_DIRS, REQUIRED_DIRS, REQUIRED_FILES } from './layout';

describe('目录规范常量', () => {
  it('scaffold 覆盖五类节点子目录与 text/index', () => {
    for (const d of [
      'research/nodes/threads',
      'research/nodes/ideas',
      'research/nodes/tasks',
      'research/nodes/evidence',
      'research/nodes/references',
      'research/text',
      'research/.index',
    ]) {
      expect(SCAFFOLD_DIRS).toContain(d);
    }
  });
  it('doctor 不强制 references 目录(reference 是可选节点类型)', () => {
    expect(REQUIRED_DIRS).not.toContain('research/nodes/references');
  });
  it('scaffold 覆盖代码三界', () => {
    for (const d of ['src', 'experiments', 'output', 'docs']) {
      expect(SCAFFOLD_DIRS).toContain(d);
    }
  });
  it('scaffold 覆盖 docs/conventions(共用规范目录)', () => {
    expect(SCAFFOLD_DIRS).toContain('docs/conventions');
  });
  it('doctor 必需目录不含派生的 .index', () => {
    expect(REQUIRED_DIRS).not.toContain('research/.index');
    expect(REQUIRED_DIRS).toContain('research/nodes/tasks');
  });
  it('doctor 必需文件含宪法、宪章与 docs 子索引', () => {
    expect(REQUIRED_FILES).toEqual(['CLAUDE.md', 'docs/overview.md', 'docs/CLAUDE.md']);
  });
  it('doctor 不强制 docs/conventions(用户可自由删改)', () => {
    expect(REQUIRED_DIRS).not.toContain('docs/conventions');
  });
});
