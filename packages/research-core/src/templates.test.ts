import { describe, it, expect } from 'vitest';
import {
  renderClaudeMd,
  renderOverviewMd,
  renderDocsClaudeMd,
  renderConventionCollaboration,
  renderConventionCoding,
  renderConventionExperiments,
  renderConventionGit,
  renderConventionWriting,
  renderConventionResearchWorkflow,
  GITIGNORE_SNIPPET,
  TEMPLATE_FILES,
} from './templates';

describe('renderClaudeMd(入口指南版)', () => {
  it('嵌入项目名、含三权分立、不再含 rlab 完整动词清单', () => {
    const md = renderClaudeMd({ projectName: 'MyProj' });
    expect(md).toContain('MyProj');
    expect(md).toContain('三权分立');
    expect(md).toContain('research/nodes');
    expect(md).not.toContain('完整动词清单');
    expect(md).not.toContain('add | set | link');
  });
  it('不再包含「当前优先级」等会随项目演进的占位段', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).not.toContain('## 当前优先级');
    expect(md).not.toContain('由研究者随时改写');
  });
  it('明确声明本文件永不变 + 引导项目特定内容去 overview/conventions/rlab', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('永不');
    // 项目特定的研究主线/动机/约束去 overview
    expect(md).toContain('docs/overview.md');
    // 待办/优先级去 rlab next
    expect(md).toContain('rlab next');
  });
  it('指引 Agent 按顺序读 docs 必读文档', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('必读文档');
    expect(md).toContain('docs/overview.md');
    expect(md).toContain('docs/CLAUDE.md');
    expect(md).toContain('docs/conventions/collaboration.md');
    expect(md).toContain('docs/conventions/research-workflow.md');
    expect(md).toContain('docs/conventions/coding.md');
    expect(md).toContain('docs/conventions/experiments.md');
    expect(md).toContain('docs/conventions/git.md');
    expect(md).toContain('docs/conventions/writing.md');
  });
  it('保留「研究图是共享工作台」与 rlab brief 入门指引', () => {
    const md = renderClaudeMd({ projectName: 'Demo' });
    expect(md).toContain('research/nodes');
    expect(md).toContain('rlab brief');
    expect(md).toContain('绝不擅自');
  });
  it('含三类产物纪律边界(research/docs/src 各有职责)', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('research/');
    expect(md).toContain('docs/');
    expect(md).toContain('experiments/');
    expect(md).toContain('依赖方向单向');
  });
  it('含工作循环闭环(读图 → 判断 → 动手 → 结案)', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('工作循环');
    expect(md).toContain('判断力 > 执行力');
    expect(md).toContain('只增不毁');
    expect(md).toContain('AskUserQuestion');
  });
  it('含助手 vs 主权者边界(建议可给、执行需明示、不假装、拿不准就问)', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('助手');
    expect(md).toContain('主权者');
    expect(md).toContain('建议');
    expect(md).toContain('不假装');
    expect(md).toContain('拿不准就问');
  });
  it('含工程纪律(tmux 不用 nohup、临时文件别写 / 分区)', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('tmux');
    expect(md).toContain('nohup');
    expect(md).toContain('/mnt/');
  });
  it('CLAUDE.md 入口版保持紧凑(≤120 行)', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md.split('\n').length).toBeLessThanOrEqual(120);
  });
});

describe('renderOverviewMd', () => {
  it('是研究宪章骨架且含项目名与待填占位', () => {
    const md = renderOverviewMd({ projectName: 'MyProj' });
    expect(md).toContain('MyProj');
    expect(md).toContain('研究宪章');
    expect(md).toContain('<');
  });
});

describe('renderDocsClaudeMd(docs 子索引)', () => {
  it('含项目名、必读路线、6 份 conventions 文件引用', () => {
    const md = renderDocsClaudeMd({ projectName: 'P1' });
    expect(md).toContain('P1');
    expect(md).toContain('必读');
    expect(md).toContain('collaboration.md');
    expect(md).toContain('coding.md');
    expect(md).toContain('experiments.md');
    expect(md).toContain('git.md');
    expect(md).toContain('writing.md');
    expect(md).toContain('research-workflow.md');
  });
});

describe('renderConventionCollaboration', () => {
  it('含「判断力 > 执行力」「诚实第一」「AskUserQuestion」与项目特定补充占位', () => {
    const md = renderConventionCollaboration({ projectName: 'P' });
    expect(md).toContain('判断力 > 执行力');
    expect(md).toContain('诚实第一');
    expect(md).toContain('AskUserQuestion');
    expect(md).toContain('快速探针');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('renderConventionCoding', () => {
  it('含类型标注/显式 import/pathlib/logging 与 Python 示例代码块', () => {
    const md = renderConventionCoding({ projectName: 'P' });
    expect(md).toContain('类型标注');
    expect(md).toContain('显式 import');
    expect(md).toContain('pathlib');
    expect(md).toContain('logging');
    expect(md).toContain('```python');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('renderConventionExperiments', () => {
  it('含 MANIFEST.json 完整示例、中断安全、smoke 先行、JSON 代码块', () => {
    const md = renderConventionExperiments({ projectName: 'P' });
    expect(md).toContain('MANIFEST.json');
    expect(md).toContain('中断安全');
    expect(md).toContain('smoke');
    expect(md).toContain('广度优先');
    expect(md).toContain('```json');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('renderConventionGit', () => {
  it('含分支命名/提交前缀/禁止提交清单', () => {
    const md = renderConventionGit({ projectName: 'P' });
    expect(md).toContain('feat:');
    expect(md).toContain('fix:');
    expect(md).toContain('exp:');
    expect(md).toContain('分支命名');
    expect(md).toContain('禁止提交');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('renderConventionWriting', () => {
  it('含语言规则与 matplotlib 论文风格代码块', () => {
    const md = renderConventionWriting({ projectName: 'P' });
    expect(md).toContain('代码');
    expect(md).toContain('文档');
    expect(md).toContain('图表');
    expect(md).toContain('色盲友好');
    expect(md).toContain('```python');
    expect(md).toContain('matplotlib');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('renderConventionResearchWorkflow', () => {
  it('含「研究图共享工作台」必做/可做/不能做完整三段 + 完整动词清单', () => {
    const md = renderConventionResearchWorkflow({ projectName: 'P' });
    expect(md).toContain('rlab brief');
    expect(md).toContain('rlab add idea');
    expect(md).toContain('rlab conclude');
    expect(md).toContain('rlab next');
    expect(md).toContain('不许自驱重构');
    expect(md).toContain('完整动词清单');
    expect(md).toContain('## 项目特定补充');
  });
});

describe('TEMPLATE_FILES', () => {
  it('覆盖 9 份模板(CLAUDE.md + docs/CLAUDE.md + overview.md + 6 conventions)且 render 非空', () => {
    const paths = TEMPLATE_FILES.map((t) => t.path);
    expect(paths).toEqual([
      'CLAUDE.md',
      'docs/CLAUDE.md',
      'docs/overview.md',
      'docs/conventions/collaboration.md',
      'docs/conventions/research-workflow.md',
      'docs/conventions/coding.md',
      'docs/conventions/experiments.md',
      'docs/conventions/git.md',
      'docs/conventions/writing.md',
    ]);
    for (const t of TEMPLATE_FILES) {
      expect(t.render({ projectName: 'P' }).length).toBeGreaterThan(0);
    }
  });
  it('GITIGNORE_SNIPPET 忽略 output 与派生 index', () => {
    expect(GITIGNORE_SNIPPET).toContain('output/');
    expect(GITIGNORE_SNIPPET).toContain('!output/.gitkeep');
    expect(GITIGNORE_SNIPPET).toContain('research/.index/');
  });
});
