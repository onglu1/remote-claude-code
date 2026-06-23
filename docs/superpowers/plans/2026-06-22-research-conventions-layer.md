# 科研工作流·约定层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 remote-cc monorepo 里新增 `@rcc/research-core` 包，提供 `research init`（脚手架出合规科研目录）与 `research doctor`（校验目录是否合规），并落地 CLAUDE.md/overview 模板与目录规范。

**Architecture:** 新建一个纯 TS workspace 包 `@rcc/research-core`，被未来的 CLI 与 remote-cc 后端共用。领域逻辑（目录规范常量、模板、scaffold、doctor、CLI dispatch）做成小而专注的纯函数，直接用 `node:fs`（沿用本仓库 `taskEvidence.ts` 的既有写法），测试用真实临时目录跑真实 fs。CLI 经 `tsx` 入口暴露，本层只做 `init` / `doctor` 两个动词；完整知识图存储与其余动词留给后续「骨干层」。

**Tech Stack:** TypeScript（ESM，`moduleResolution: Bundler`，无构建步、tsx 直跑）、zod（draft schema）、vitest（`*.test.ts` 与源码共置）。

---

## 设计参照（来自 spec）

依据 `docs/superpowers/specs/2026-06-22-research-workflow-system-design.md`：

- 目录规范（§5）：`research/nodes/{threads,ideas,tasks,evidence}` + `research/text` + `research/.index` + `docs/` + `src/` + `experiments/` + `output/` + `CLAUDE.md`。
- 结构与文本分离（§2.2）：结构真值在 `research/nodes/**.json`，散文在 `research/text/**.md`，CLI 绝不从 md 解析结构。
- CLAUDE.md = 宪法（§2.2 三权分立、判断>执行、src/experiments 纪律、只增不毁）。
- 本计划只覆盖 spec §10 的「约定层」；schema 只做够用的草案（§3 词汇），完整 schema 与节点存储属「骨干层」。

## 文件结构（本层产出）

```
packages/research-core/
  package.json            # @rcc/research-core:type module, exports ./src/index.ts, dep zod, script test/typecheck/research(tsx)
  tsconfig.json           # extends ../../tsconfig.base.json, noEmit, types node, include src
  src/
    index.ts              # barrel 导出
    schema.ts             # 草案词汇:NodeType / 各类 status / Edge / ResearchNode(draft)
    schema.test.ts
    layout.ts             # 目录规范常量:SCAFFOLD_DIRS / REQUIRED_DIRS / REQUIRED_FILES
    layout.test.ts
    templates.ts          # renderClaudeMd / renderOverviewMd / GITIGNORE_SNIPPET / TEMPLATE_FILES
    templates.test.ts
    scaffold.ts           # scaffoldResearchRepo(root, opts) -> ScaffoldReport
    scaffold.test.ts
    doctor.ts             # checkResearchRepo(root) -> DoctorReport
    doctor.test.ts
    runCli.ts             # runCli(argv, cwd) -> { code, stdout }
    runCli.test.ts
    cli.ts                # 进程入口:把 process.argv/cwd 接到 runCli
```

并修改根 `package.json`：把 `packages/research-core` 加进 `workspaces`、`test`、`typecheck`。

**跨任务共享的类型契约（在 Task 2/3/5/6 中定义，后续任务复用，命名必须一致）：**

```ts
// schema.ts
type NodeType = 'thread' | 'idea' | 'task' | 'evidence' | 'reference';
// scaffold.ts
interface ScaffoldOptions { projectName: string; force?: boolean; }
interface ScaffoldReport { created: string[]; skipped: string[]; }
function scaffoldResearchRepo(root: string, opts: ScaffoldOptions): ScaffoldReport;
// doctor.ts
interface DoctorReport { ok: boolean; missingDirs: string[]; missingFiles: string[]; }
function checkResearchRepo(root: string): DoctorReport;
// runCli.ts
function runCli(argv: string[], cwd: string): { code: number; stdout: string };
```

---

## Task 1: 新建 `@rcc/research-core` 包骨架并接入 workspace

**Files:**
- Create: `packages/research-core/package.json`
- Create: `packages/research-core/tsconfig.json`
- Create: `packages/research-core/src/index.ts`
- Modify: `package.json`（根，workspaces + test + typecheck）

- [ ] **Step 1: 写 package.json**

Create `packages/research-core/package.json`：

```json
{
  "name": "@rcc/research-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "research": "tsx src/cli.ts"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

Create `packages/research-core/tsconfig.json`（镜像 `apps/server/tsconfig.json`，因为要用 node 类型）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 写空 barrel**

Create `packages/research-core/src/index.ts`：

```ts
export {};
```

- [ ] **Step 4: 接入根 workspace 与脚本**

Modify 根 `package.json`：

把
```json
  "workspaces": ["packages/shared", "apps/server", "apps/web"],
```
改为
```json
  "workspaces": ["packages/shared", "packages/research-core", "apps/server", "apps/web"],
```

把
```json
    "test": "npm -w @rcc/shared run test --if-present && npm -w @rcc/server run test --if-present",
    "typecheck": "npm -w @rcc/shared run typecheck && npm -w @rcc/server run typecheck && npm -w @rcc/web run typecheck"
```
改为
```json
    "test": "npm -w @rcc/shared run test --if-present && npm -w @rcc/research-core run test --if-present && npm -w @rcc/server run test --if-present",
    "typecheck": "npm -w @rcc/shared run typecheck && npm -w @rcc/research-core run typecheck && npm -w @rcc/server run typecheck && npm -w @rcc/web run typecheck"
```

- [ ] **Step 5: 安装并验证 workspace 已链接**

Run: `npm install`
Expected: 成功，`node_modules/@rcc/research-core` 出现（symlink 到 `packages/research-core`）。

- [ ] **Step 6: typecheck 通过**

Run: `npm -w @rcc/research-core run typecheck`
Expected: 无报错退出 0。

- [ ] **Step 7: Commit**

```bash
git add packages/research-core/package.json packages/research-core/tsconfig.json packages/research-core/src/index.ts package.json package-lock.json
git commit -m "feat(research): 新建 @rcc/research-core 包骨架并接入 workspace"
```

---

## Task 2: 草案 schema（节点词汇）

**Files:**
- Create: `packages/research-core/src/schema.ts`
- Create: `packages/research-core/src/schema.test.ts`
- Modify: `packages/research-core/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/schema.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import {
  NodeTypeSchema,
  TaskStatusSchema,
  IdeaStatusSchema,
  EvidenceResultSchema,
  ResearchNodeSchema,
} from './schema';

describe('NodeTypeSchema', () => {
  it('接受五种节点类型', () => {
    for (const t of ['thread', 'idea', 'task', 'evidence', 'reference']) {
      expect(NodeTypeSchema.parse(t)).toBe(t);
    }
  });
  it('拒绝未知类型', () => {
    expect(() => NodeTypeSchema.parse('paper')).toThrow();
  });
});

describe('status 枚举', () => {
  it('task 状态含异常终态', () => {
    expect(TaskStatusSchema.parse('invalidated')).toBe('invalidated');
    expect(TaskStatusSchema.parse('superseded')).toBe('superseded');
  });
  it('idea 状态独立于 task', () => {
    expect(IdeaStatusSchema.parse('incubating')).toBe('incubating');
    expect(() => IdeaStatusSchema.parse('todo')).toThrow();
  });
  it('evidence result 含负结果', () => {
    expect(EvidenceResultSchema.parse('negative')).toBe('negative');
  });
});

describe('ResearchNodeSchema（草案）', () => {
  it('解析一个最小 task 节点', () => {
    const n = ResearchNodeSchema.parse({
      id: 'task/007',
      type: 'task',
      title: 'demo',
      status: 'todo',
      edges: [{ to: 'evidence/005', label: 'motivated-by', note: 'x' }],
    });
    expect(n.id).toBe('task/007');
    expect(n.edges[0].label).toBe('motivated-by');
    expect(n.kind).toEqual([]);
    expect(n.aliases).toEqual([]);
  });
  it('edges/kind/aliases 有默认空数组', () => {
    const n = ResearchNodeSchema.parse({ id: 'idea/1', type: 'idea', title: 't', status: 'incubating' });
    expect(n.edges).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- schema`
Expected: FAIL（`Cannot find module './schema'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/schema.ts`：

```ts
import { z } from 'zod';

/**
 * 草案 schema：仅覆盖约定层需要的节点词汇，供后续「骨干层」扩展为完整节点存储。
 * 故意保持最小，不做完整校验（如按 type 区分 status 的联合体留给骨干层）。
 */

export const NodeTypeSchema = z.enum(['thread', 'idea', 'task', 'evidence', 'reference']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const TaskStatusSchema = z.enum([
  'todo',
  'active',
  'done',
  'superseded',
  'invalidated',
  'dropped',
  'blocked',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const IdeaStatusSchema = z.enum(['incubating', 'parked', 'crystallized', 'dropped']);
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;

export const EvidenceStatusSchema = z.enum(['active', 'superseded', 'invalidated']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceResultSchema = z.enum(['positive', 'negative', 'inconclusive']);
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const EdgeSchema = z.object({
  to: z.string(),
  label: z.string(),
  note: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

/** 节点结构记录（草案）。status 暂用宽松 string，骨干层再按 type 收紧。 */
export const ResearchNodeSchema = z.object({
  id: z.string(),
  type: NodeTypeSchema,
  title: z.string(),
  status: z.string(),
  result: EvidenceResultSchema.nullable().optional(),
  kind: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  parent: z.string().optional(),
  summary: z.string().optional(),
  edges: z.array(EdgeSchema).default([]),
  text: z.string().optional(),
  code: z.array(z.string()).default([]),
  output: z.array(z.string()).default([]),
  manifest: z.string().optional(),
});
export type ResearchNode = z.infer<typeof ResearchNodeSchema>;
```

- [ ] **Step 4: 导出**

Modify `packages/research-core/src/index.ts`：

```ts
export * from './schema';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- schema`
Expected: PASS（5 个 it 全绿）。

- [ ] **Step 6: Commit**

```bash
git add packages/research-core/src/schema.ts packages/research-core/src/schema.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): 草案节点词汇 schema(NodeType/status/Edge/ResearchNode)"
```

---

## Task 3: 目录规范常量

**Files:**
- Create: `packages/research-core/src/layout.ts`
- Create: `packages/research-core/src/layout.test.ts`
- Modify: `packages/research-core/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/layout.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { SCAFFOLD_DIRS, REQUIRED_DIRS, REQUIRED_FILES } from './layout';

describe('目录规范常量', () => {
  it('scaffold 覆盖四类节点子目录与 text/index', () => {
    for (const d of [
      'research/nodes/threads',
      'research/nodes/ideas',
      'research/nodes/tasks',
      'research/nodes/evidence',
      'research/text',
      'research/.index',
    ]) {
      expect(SCAFFOLD_DIRS).toContain(d);
    }
  });
  it('scaffold 覆盖代码三界', () => {
    for (const d of ['src', 'experiments', 'output', 'docs']) {
      expect(SCAFFOLD_DIRS).toContain(d);
    }
  });
  it('doctor 必需目录不含派生的 .index', () => {
    expect(REQUIRED_DIRS).not.toContain('research/.index');
    expect(REQUIRED_DIRS).toContain('research/nodes/tasks');
  });
  it('doctor 必需文件含宪法与宪章', () => {
    expect(REQUIRED_FILES).toEqual(['CLAUDE.md', 'docs/overview.md']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- layout`
Expected: FAIL（`Cannot find module './layout'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/layout.ts`：

```ts
/**
 * 科研仓库目录规范。所有路径相对仓库根，正斜杠分隔（跨平台由调用方 join）。
 */

/** init 会创建的目录（含派生的 .index 运行时目录）。 */
export const SCAFFOLD_DIRS: string[] = [
  'research/nodes/threads',
  'research/nodes/ideas',
  'research/nodes/tasks',
  'research/nodes/evidence',
  'research/text',
  'research/.index',
  'docs',
  'src',
  'experiments',
  'output',
];

/** doctor 视为「合规必需」的目录（排除派生/可空的 .index）。 */
export const REQUIRED_DIRS: string[] = [
  'research/nodes/threads',
  'research/nodes/ideas',
  'research/nodes/tasks',
  'research/nodes/evidence',
  'research/text',
  'docs',
  'src',
  'experiments',
  'output',
];

/** doctor 视为「合规必需」的文件。 */
export const REQUIRED_FILES: string[] = ['CLAUDE.md', 'docs/overview.md'];

/** init 会放 .gitkeep 占位的空目录（让 git 跟踪；.index 被 gitignore 故排除）。 */
export const GITKEEP_DIRS: string[] = SCAFFOLD_DIRS.filter((d) => d !== 'research/.index');
```

- [ ] **Step 4: 导出**

Modify `packages/research-core/src/index.ts`，追加一行：

```ts
export * from './layout';
```

（此时 index.ts 内容为：`export * from './schema';` 与 `export * from './layout';` 两行。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- layout`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/research-core/src/layout.ts packages/research-core/src/layout.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): 目录规范常量(SCAFFOLD_DIRS/REQUIRED_DIRS/REQUIRED_FILES)"
```

## Task 4: 模板（CLAUDE.md 宪法 + overview 宪章 + gitignore）

**Files:**
- Create: `packages/research-core/src/templates.ts`
- Create: `packages/research-core/src/templates.test.ts`
- Modify: `packages/research-core/src/index.ts`

> 注：模板正文内**不使用反引号行内代码**（改用「」与单引号），避免后续在 TS 模板字符串里转义，也避免与本计划的代码块冲突。

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/templates.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { renderClaudeMd, renderOverviewMd, GITIGNORE_SNIPPET, TEMPLATE_FILES } from './templates';

describe('renderClaudeMd', () => {
  it('嵌入项目名且含三权分立与判断>执行', () => {
    const md = renderClaudeMd({ projectName: 'MyProj' });
    expect(md).toContain('MyProj');
    expect(md).toContain('三权分立');
    expect(md).toContain('判断 > 执行');
    expect(md).toContain('research/nodes');
  });
  it('声明结构只走 CLI、绝不从 md 解析结构', () => {
    const md = renderClaudeMd({ projectName: 'X' });
    expect(md).toContain('research/text');
    expect(md).toContain('绝不');
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

describe('TEMPLATE_FILES', () => {
  it('覆盖 CLAUDE.md 与 docs/overview.md 且 render 产出非空', () => {
    const paths = TEMPLATE_FILES.map((t) => t.path);
    expect(paths).toEqual(['CLAUDE.md', 'docs/overview.md']);
    for (const t of TEMPLATE_FILES) {
      expect(t.render({ projectName: 'P' }).length).toBeGreaterThan(0);
    }
  });
  it('GITIGNORE_SNIPPET 忽略 output 与派生 index', () => {
    expect(GITIGNORE_SNIPPET).toContain('output/');
    expect(GITIGNORE_SNIPPET).toContain('research/.index/');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- templates`
Expected: FAIL（`Cannot find module './templates'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/templates.ts`：

```ts
import type { ScaffoldOptions } from './scaffold';

/** CLAUDE.md —— 科研仓库宪法。 */
export function renderClaudeMd(opts: ScaffoldOptions): string {
  return [
    '# ' + opts.projectName + ' — 科研项目宪法（CLAUDE.md）',
    '',
    '> 本文件是本科研仓库的最高约定。开工前**必须先读** docs/overview.md（研究宪章）与 research brief（全局图景）。',
    '',
    '## 工作模式',
    '',
    '- 本项目是「带类型的知识库 + 一个 CLI」。知识图的真值在 research/nodes/**.json，**只能通过 research CLI 改**；绝不手改这些 JSON，也**绝不**从 research/text/**.md 解析结构。',
    '- research/text/**.md 是给人和 AI 读的散文，可自由编写。',
    '',
    '## 三权分立（必须遵守）',
    '',
    '1. **结构主权属于研究者本人**：方向/实验的增删、拆分合并、连边、作废，由人发起（网页操作，或用自然语言让 Agent 代劳）。Agent **绝不擅自重构**知识图。',
    '2. **Agent 的职责**：基于知识库与人对话、回答问题、在人的指令下写代码/跑实验/记录证据。',
    '3. **CLI 守不变量**：schema 校验、只增不毁、传播规则由它保证。',
    '',
    '## 判断 > 执行（最重要）',
    '',
    '出现「核心假设被数据推翻」「方法过于简单」「方向有根本问题」等信号时，**立刻停下**，诚实报告并列出可选方向交研究者决定。绝不因为「算力空着」「之前说过继续」就在有问题的方向上硬跑。',
    '',
    '## 代码两界',
    '',
    '- src/：稳定核心库，质量优先，被所有实验依赖。',
    '- experiments/NNN_*/：一次性实验，忠于实验目的即可，复杂度无所谓。',
    '- 依赖方向单向：experiments 可 import src，src **绝不**反向依赖 experiments。',
    '',
    '## 只增不毁',
    '',
    '没有东西被真删：作废用 research invalidate、取代用 research supersede，永远留下「为什么」。',
    '',
    '## 语言',
    '',
    '文档（docs/、research/text/）用中文；代码标识符与注释用英文；图表文字用英文。',
    '',
  ].join('\n');
}

/** docs/overview.md —— 研究宪章（含待研究者填写的占位）。 */
export function renderOverviewMd(opts: ScaffoldOptions): string {
  return [
    '# ' + opts.projectName + ' — 研究宪章（overview）',
    '',
    '> 这是 AI 必读的项目大背景。把"研究什么、为什么、有哪些约束、当前有哪些方向"讲清楚。',
    '',
    '## 现象 / 研究主线',
    '',
    '<一句话讲清楚本项目在研究什么现象、主线是什么>',
    '',
    '## 为什么值得做',
    '',
    '<动机：解决什么问题、对谁有价值、相比已有工作的新意>',
    '',
    '## 约束',
    '',
    '<环境/算力/数据/方法上的硬约束，AI 行动必须贴合>',
    '',
    '## 当前方向（threads）',
    '',
    '<列出当前正在推进的研究方向；正式方向由 research CLI 维护，这里只做人读概览>',
    '',
  ].join('\n');
}

/** 追加进 .gitignore 的片段。 */
export const GITIGNORE_SNIPPET: string = [
  '# --- research workflow ---',
  'output/',
  'research/.index/',
  '*.bak',
  '',
].join('\n');

export interface TemplateFile {
  path: string;
  render: (opts: ScaffoldOptions) => string;
}

/** 需写入仓库的模板文件（path 相对仓库根）。 */
export const TEMPLATE_FILES: TemplateFile[] = [
  { path: 'CLAUDE.md', render: renderClaudeMd },
  { path: 'docs/overview.md', render: renderOverviewMd },
];
```

- [ ] **Step 4: 导出**

Modify `packages/research-core/src/index.ts`，追加：

```ts
export * from './templates';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- templates`
Expected: PASS。

> 说明：`templates.ts` 从 `./scaffold` 仅做 `import type { ScaffoldOptions }`（类型导入，运行时无副作用），即便 scaffold.ts 尚未实现，vitest/tsx 也能跑（类型在运行时被擦除）。Task 5 会补上 `scaffold.ts`，typecheck 在 Task 5 之后整体通过。

- [ ] **Step 6: Commit**

```bash
git add packages/research-core/src/templates.ts packages/research-core/src/templates.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): CLAUDE.md 宪法与 overview 宪章模板 + gitignore 片段"
```

---

## Task 5: scaffold（`research init` 的核心）

**Files:**
- Create: `packages/research-core/src/scaffold.ts`
- Create: `packages/research-core/src/scaffold.test.ts`
- Modify: `packages/research-core/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/scaffold.test.ts`：

```ts
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
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- scaffold`
Expected: FAIL（`Cannot find module './scaffold'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/scaffold.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { SCAFFOLD_DIRS, GITKEEP_DIRS } from './layout';
import { TEMPLATE_FILES, GITIGNORE_SNIPPET } from './templates';

export interface ScaffoldOptions {
  projectName: string;
  force?: boolean;
}

export interface ScaffoldReport {
  created: string[];
  skipped: string[];
}

/**
 * 在 root 处脚手架一个合规科研仓库。幂等：已存在的模板文件默认跳过（force 才覆盖）。
 * 直接用 node:fs（同步），与本仓库 taskEvidence.ts 的写法一致。
 */
export function scaffoldResearchRepo(root: string, opts: ScaffoldOptions): ScaffoldReport {
  const report: ScaffoldReport = { created: [], skipped: [] };

  for (const dir of SCAFFOLD_DIRS) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  for (const dir of GITKEEP_DIRS) {
    const keep = path.join(root, dir, '.gitkeep');
    if (!fs.existsSync(keep)) {
      fs.writeFileSync(keep, '');
      report.created.push(path.posix.join(dir, '.gitkeep'));
    }
  }

  for (const tpl of TEMPLATE_FILES) {
    const abs = path.join(root, tpl.path);
    if (fs.existsSync(abs) && !opts.force) {
      report.skipped.push(tpl.path);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, tpl.render(opts));
    report.created.push(tpl.path);
  }

  ensureGitignore(root, report);
  return report;
}

function ensureGitignore(root: string, report: ScaffoldReport): void {
  const gi = path.join(root, '.gitignore');
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (existing.includes('research/.index/')) {
    report.skipped.push('.gitignore');
    return;
  }
  const next = existing.length > 0 ? existing.replace(/\n*$/, '\n\n') + GITIGNORE_SNIPPET : GITIGNORE_SNIPPET;
  fs.writeFileSync(gi, next);
  report.created.push('.gitignore');
}
```

- [ ] **Step 4: 导出**

Modify `packages/research-core/src/index.ts`，追加：

```ts
export * from './scaffold';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- scaffold`
Expected: PASS（6 个 it 全绿）。

- [ ] **Step 6: 整体 typecheck**

Run: `npm -w @rcc/research-core run typecheck`
Expected: 退出 0（此时 templates.ts 的 `import type { ScaffoldOptions }` 已能解析）。

- [ ] **Step 7: Commit**

```bash
git add packages/research-core/src/scaffold.ts packages/research-core/src/scaffold.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): scaffoldResearchRepo —— 幂等脚手架(目录+模板+gitignore)"
```

## Task 6: doctor（合规校验）

**Files:**
- Create: `packages/research-core/src/doctor.ts`
- Create: `packages/research-core/src/doctor.test.ts`
- Modify: `packages/research-core/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/doctor.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkResearchRepo } from './doctor';
import { scaffoldResearchRepo } from './scaffold';

const tmpRoots: string[] = [];
function freshRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-research-'));
  tmpRoots.push(r);
  return r;
}
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('checkResearchRepo', () => {
  it('脚手架后判定合规', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    const report = checkResearchRepo(root);
    expect(report.ok).toBe(true);
    expect(report.missingDirs).toEqual([]);
    expect(report.missingFiles).toEqual([]);
  });

  it('空目录列出缺失的目录与文件', () => {
    const root = freshRoot();
    const report = checkResearchRepo(root);
    expect(report.ok).toBe(false);
    expect(report.missingDirs).toContain('research/nodes/tasks');
    expect(report.missingFiles).toContain('CLAUDE.md');
  });

  it('缺少 docs/overview.md 即不合规', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    fs.rmSync(path.join(root, 'docs/overview.md'));
    const report = checkResearchRepo(root);
    expect(report.ok).toBe(false);
    expect(report.missingFiles).toEqual(['docs/overview.md']);
  });

  it('文件占位但不是目录时算缺目录', () => {
    const root = freshRoot();
    scaffoldResearchRepo(root, { projectName: 'Demo' });
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'src'), 'not a dir');
    const report = checkResearchRepo(root);
    expect(report.missingDirs).toContain('src');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- doctor`
Expected: FAIL（`Cannot find module './doctor'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/doctor.ts`：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_DIRS, REQUIRED_FILES } from './layout';

export interface DoctorReport {
  ok: boolean;
  missingDirs: string[];
  missingFiles: string[];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 校验 root 是否符合科研仓库目录规范。 */
export function checkResearchRepo(root: string): DoctorReport {
  const missingDirs = REQUIRED_DIRS.filter((d) => !isDir(path.join(root, d)));
  const missingFiles = REQUIRED_FILES.filter((f) => !isFile(path.join(root, f)));
  return { ok: missingDirs.length === 0 && missingFiles.length === 0, missingDirs, missingFiles };
}
```

- [ ] **Step 4: 导出**

Modify `packages/research-core/src/index.ts`，追加：

```ts
export * from './doctor';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- doctor`
Expected: PASS（4 个 it 全绿）。

- [ ] **Step 6: Commit**

```bash
git add packages/research-core/src/doctor.ts packages/research-core/src/doctor.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): checkResearchRepo —— 目录合规校验"
```

---

## Task 7: CLI dispatch（`init` / `doctor` / `help`）+ 进程入口

**Files:**
- Create: `packages/research-core/src/runCli.ts`
- Create: `packages/research-core/src/runCli.test.ts`
- Create: `packages/research-core/src/cli.ts`
- Modify: `packages/research-core/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/research-core/src/runCli.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './runCli';

const tmpRoots: string[] = [];
function freshRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-research-'));
  tmpRoots.push(r);
  return r;
}
afterEach(() => {
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('runCli', () => {
  it('init <dir> 脚手架并返回 0', () => {
    const root = freshRoot();
    const target = path.join(root, 'proj');
    const r = runCli(['init', target, '--name', 'MyProj'], root);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(target, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toContain('MyProj');
    expect(r.stdout).toContain('created');
  });

  it('init 缺省 --name 时用目录名', () => {
    const root = freshRoot();
    const r = runCli(['init', '.'], root);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(path.basename(root));
  });

  it('doctor 合规返回 0、不合规返回 1', () => {
    const root = freshRoot();
    expect(runCli(['doctor', '.'], root).code).toBe(1);
    runCli(['init', '.'], root);
    const ok = runCli(['doctor', '.'], root);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('ok');
  });

  it('doctor 不合规时列出缺失项', () => {
    const root = freshRoot();
    const r = runCli(['doctor', '.'], root);
    expect(r.stdout).toContain('CLAUDE.md');
    expect(r.stdout).toContain('research/nodes/tasks');
  });

  it('help / 无参 返回用法且 code 0', () => {
    expect(runCli([], '/tmp').stdout).toContain('research');
    expect(runCli(['--help'], '/tmp').code).toBe(0);
  });

  it('未知命令返回 1', () => {
    const r = runCli(['frobnicate'], '/tmp');
    expect(r.code).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/research-core run test -- runCli`
Expected: FAIL（`Cannot find module './runCli'`）。

- [ ] **Step 3: 写最小实现**

Create `packages/research-core/src/runCli.ts`：

```ts
import path from 'node:path';
import { scaffoldResearchRepo } from './scaffold';
import { checkResearchRepo } from './doctor';

export interface CliResult {
  code: number;
  stdout: string;
}

const USAGE = [
  'research —— 科研工作流 CLI（约定层）',
  '',
  '用法:',
  '  research init [dir] [--name <名称>] [--force]   在 dir(默认当前目录)脚手架合规科研仓库',
  '  research doctor [dir]                            校验 dir 是否符合目录规范',
  '  research --help                                  显示本帮助',
  '',
].join('\n');

/** 极简 flag 解析：返回位置参数与已知 flag。 */
function parseArgs(rest: string[]): { positionals: string[]; name?: string; force: boolean } {
  const positionals: string[] = [];
  let name: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--force') force = true;
    else if (a === '--name') name = rest[++i];
    else positionals.push(a);
  }
  return { positionals, name, force };
}

export function runCli(argv: string[], cwd: string): CliResult {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return { code: 0, stdout: USAGE };
  }

  if (cmd === 'init') {
    const { positionals, name, force } = parseArgs(rest);
    const root = path.resolve(cwd, positionals[0] ?? '.');
    const projectName = name ?? path.basename(root);
    const report = scaffoldResearchRepo(root, { projectName, force });
    const lines = [
      'research init: ' + root,
      'created: ' + (report.created.length ? report.created.join(', ') : '(无)'),
      'skipped: ' + (report.skipped.length ? report.skipped.join(', ') : '(无)'),
      '',
      '下一步: 填写 docs/overview.md（研究宪章），然后用 research doctor 校验。',
      '',
    ];
    return { code: 0, stdout: lines.join('\n') };
  }

  if (cmd === 'doctor') {
    const { positionals } = parseArgs(rest);
    const root = path.resolve(cwd, positionals[0] ?? '.');
    const report = checkResearchRepo(root);
    if (report.ok) {
      return { code: 0, stdout: 'research doctor: ok —— ' + root + '\n' };
    }
    const lines = [
      'research doctor: 不合规 —— ' + root,
      'missing dirs:  ' + (report.missingDirs.join(', ') || '(无)'),
      'missing files: ' + (report.missingFiles.join(', ') || '(无)'),
      '',
      '提示: research init ' + (positionals[0] ?? '.') + ' 可补齐缺失骨架。',
      '',
    ];
    return { code: 1, stdout: lines.join('\n') };
  }

  return { code: 1, stdout: '未知命令: ' + cmd + '\n\n' + USAGE };
}
```

- [ ] **Step 4: 写进程入口**

Create `packages/research-core/src/cli.ts`：

```ts
import { runCli } from './runCli';

const { code, stdout } = runCli(process.argv.slice(2), process.cwd());
process.stdout.write(stdout);
process.exit(code);
```

- [ ] **Step 5: 导出**

Modify `packages/research-core/src/index.ts`，追加：

```ts
export * from './runCli';
```

（`cli.ts` 是进程入口，不进 barrel。最终 index.ts 共 6 行：schema/layout/templates/scaffold/doctor/runCli。）

- [ ] **Step 6: 跑测试确认通过**

Run: `npm -w @rcc/research-core run test -- runCli`
Expected: PASS（6 个 it 全绿）。

- [ ] **Step 7: Commit**

```bash
git add packages/research-core/src/runCli.ts packages/research-core/src/runCli.test.ts packages/research-core/src/cli.ts packages/research-core/src/index.ts
git commit -m "feat(research): research CLI dispatch(init/doctor/help) + 进程入口"
```

## Task 8: 端到端冒烟（真跑 `research` 脚本）+ 包 README

**Files:**
- Create: `packages/research-core/README.md`
- （无新代码，仅真实 CLI 冒烟与全量测试/类型校验）

- [ ] **Step 1: 真实跑 `research init`**

Run:
```bash
TMP=$(mktemp -d) && npm -w @rcc/research-core run research -- init "$TMP/demo" --name Smoke && ls -R "$TMP/demo" | head -40
```
Expected: 打印 `created: ...`，`$TMP/demo` 下出现 `CLAUDE.md`、`docs/overview.md`、`research/nodes/tasks/.gitkeep` 等。

- [ ] **Step 2: 真实跑 `research doctor`（合规）**

Run:
```bash
npm -s -w @rcc/research-core run research -- doctor "$TMP/demo"; echo "exit=$?"
```
Expected: 输出含 `ok`，`exit=0`。

- [ ] **Step 3: 真实跑 `research doctor`（不合规）**

Run:
```bash
rm "$TMP/demo/CLAUDE.md" && npm -s -w @rcc/research-core run research -- doctor "$TMP/demo"; echo "exit=$?"; rm -rf "$TMP"
```
Expected: 输出 `missing files: CLAUDE.md`，`exit=1`。

- [ ] **Step 4: 写包 README**

Create `packages/research-core/README.md`：

```markdown
# @rcc/research-core

科研工作流系统的核心库（被 research CLI 与 remote-cc 后端共用）。

本包当前覆盖 spec 的「约定层」：
- 目录规范常量（`layout.ts`）
- CLAUDE.md / overview 模板（`templates.ts`）
- `scaffoldResearchRepo`（`research init` 的核心）
- `checkResearchRepo`（`research doctor`）
- CLI dispatch（`runCli` / `cli.ts`）：`init` / `doctor`
- 草案节点 schema（`schema.ts`）

## 用法（开发期，经 tsx）

    npm -w @rcc/research-core run research -- init <dir> [--name 名称] [--force]
    npm -w @rcc/research-core run research -- doctor <dir>

完整知识图存储与其余 CLI 动词（add/link/supersede/invalidate/contradict/brief/show…）见后续「骨干层」。

设计依据：`docs/superpowers/specs/2026-06-22-research-workflow-system-design.md`。
```

- [ ] **Step 5: 全量测试 + 类型校验**

Run: `npm -w @rcc/research-core run test && npm -w @rcc/research-core run typecheck`
Expected: 全部测试通过；typecheck 退出 0。

- [ ] **Step 6: 根级 test 包含新包**

Run: `npm test`
Expected: shared、research-core、server 三个包测试均跑到且通过。

- [ ] **Step 7: Commit**

```bash
git add packages/research-core/README.md
git commit -m "docs(research): research-core 包 README + 约定层端到端冒烟通过"
```

---

## 自查（写完计划后核对 spec）

**1. spec 覆盖（§10 约定层各项）**
- 目录规范 → Task 3（layout）+ Task 5（scaffold 创建）+ Task 6（doctor 校验）。✓
- CLAUDE.md / docs 模板 → Task 4（templates）。✓
- src/experiments 纪律 → 写进 CLAUDE.md 宪法（Task 4）；自动化的 import 边界 lint 属增强，留待后续（见下「范围说明」）。✓（以宪法形式落地）
- `research init`（F2 从零创建）→ Task 5 + Task 7（CLI）+ Task 8（冒烟）。✓
- 够用的 schema 草案（§3 词汇）→ Task 2。✓
- 结构/文本分离原则 → 体现在 layout（nodes/ 与 text/ 分离）与 CLAUDE.md 宪法措辞。✓

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤均给出完整可粘贴代码与可执行命令、预期输出。模板正文里的 `<…>` 是给最终研究者填写的占位（属交付内容，非计划占位）。✓

**3. 类型一致性**：`ScaffoldOptions`/`ScaffoldReport`/`scaffoldResearchRepo`（scaffold.ts）、`DoctorReport`/`checkResearchRepo`（doctor.ts）、`runCli(argv, cwd)→{code,stdout}`（runCli.ts）在定义与各调用处命名一致；`templates.ts` 经 `import type { ScaffoldOptions }` 复用同一类型。✓

**范围说明（本层不做，留后续层）**：完整节点 JSON 存储与 CLI 写入动词（add/link/supersede/invalidate/contradict）、派生索引与 `brief`/缩放、`research init` 的引导式问答、src↔experiments import 边界的自动 lint、把 remote-cc 后端与网页接到本核心库——均属「骨干层/洞察层/呈现层」，不在本计划。

**分发说明**：本层 `research` 仅经 `tsx` 在 monorepo 内运行；让任意科研仓库（如 Python 的 sample-finetune）把 `research` 装上 PATH（全局安装 / 打包 bin）属骨干层的分发议题，本层不解决。



