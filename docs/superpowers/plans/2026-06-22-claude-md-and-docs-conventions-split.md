# CLAUDE.md 入口化与 docs/conventions 拆分 — 实现计划

> **Goal:** 把 rlab init 默认产物拆成「永不变的 CLAUDE.md 入口 + docs/CLAUDE.md 子索引 + 6 份 docs/conventions/*.md 共用规范」,且在 test_research 上 force 重刷做新旧对比验收。
>
> **Architecture:** 纯模板内容工作 — 只动 `packages/research-core/src/{layout,templates}.ts` 及对应共置测试。`scaffold.ts` 自动遍历 `TEMPLATE_FILES` 不需改动。
>
> **Tech Stack:** TypeScript (ESM, tsx 直跑) + vitest 共置测试 + 静态文本模板(允许 `${projectName}` 替换)。

执行策略: **inline 执行(用户全权委托,无需 subagent)**。

---

## Task 1 — 扩 layout.ts 与测试

**Files**
- Modify: `packages/research-core/src/layout.ts`
- Modify: `packages/research-core/src/layout.test.ts`

**Steps**
- [ ] 改 layout.test.ts: 加 it 测 `SCAFFOLD_DIRS` 含 `docs/conventions`、`REQUIRED_FILES` 含 `docs/CLAUDE.md`。原有的 `expect(REQUIRED_FILES).toEqual(['CLAUDE.md', 'docs/overview.md'])` 改成包含三个文件的 `toEqual`。
- [ ] 跑测试确认 RED。
- [ ] 改 layout.ts: `SCAFFOLD_DIRS` 末尾追加 `'docs/conventions'`;`REQUIRED_FILES` 改为 `['CLAUDE.md', 'docs/overview.md', 'docs/CLAUDE.md']`。`REQUIRED_DIRS` 不动(conventions 不强制 doctor)。
- [ ] 跑测试 GREEN。
- [ ] 不单独 commit,留到 Task 4 一起提。

## Task 2 — 重写 renderClaudeMd 为入口指南版

**Files**
- Modify: `packages/research-core/src/templates.ts`
- Modify: `packages/research-core/src/templates.test.ts`

**Steps**
- [ ] 改 templates.test.ts:
  - 原 `renderClaudeMd 含「研究图共享工作台」章节与 rlab 用法示例` 测试改为:含项目名、含三权分立、含必读文档清单、**不含** `完整动词清单`(用 `not.toContain`)、长度 ≤ 80 行。
  - 原 `TEMPLATE_FILES` toEqual 长度 = 2 的断言改成 toEqual 长度 = 9(列出全部 9 个路径)。
- [ ] 跑测试确认 RED。
- [ ] 改 templates.ts: `renderClaudeMd` 重写为入口指南版(≤80 行),骨架按 spec §设计/CLAUDE.md。
- [ ] 跑测试 GREEN(其余 7 个 render 函数尚未加,TEMPLATE_FILES 也未加,会有失败,把它们留到 Task 3)。

## Task 3 — 新增 7 份模板与 TEMPLATE_FILES

**Files**
- Modify: `packages/research-core/src/templates.ts`
- Modify: `packages/research-core/src/templates.test.ts`

**Steps**
- [ ] templates.test.ts 加 7 个 describe 块:
  - `renderDocsClaudeMd` 含项目名、含"必读路线"、含 6 份 conventions 文件名引用
  - `renderConventionCollaboration` 含"判断力 > 执行力"、"诚实第一"、"AskUserQuestion"、`## 项目特定补充`
  - `renderConventionCoding` 含"类型标注"、"pathlib"、"显式 import"、Python 示例代码块、`## 项目特定补充`
  - `renderConventionExperiments` 含 `MANIFEST.json`、"中断安全"、"smoke"、"广度优先"、JSON 示例块、`## 项目特定补充`
  - `renderConventionGit` 含 `feat:`、`fix:`、"分支命名"、"禁止提交"、`## 项目特定补充`
  - `renderConventionWriting` 含"代码英文"、"图表英文"、"色盲友好"、matplotlib 代码块、`## 项目特定补充`
  - `renderConventionResearchWorkflow` 含"rlab brief"、"不许自驱重构"、"完整动词清单"、`## 项目特定补充`
  - `TEMPLATE_FILES` 含 9 项,paths 按"读入顺序"排列(CLAUDE.md, docs/CLAUDE.md, docs/overview.md, docs/conventions/collaboration.md, .../research-workflow.md, .../coding.md, .../experiments.md, .../git.md, .../writing.md)。
- [ ] 跑测试确认 RED。
- [ ] templates.ts 实现 7 个 render 函数,每个用 `[...].join('\n')` 数组拼装(与现有 renderClaudeMd 风格一致),内容按 spec 各小节细则。
- [ ] 把 7 个新条目加入 `TEMPLATE_FILES`。
- [ ] 跑测试 GREEN。

## Task 4 — 扩 scaffold.test.ts 集成测试

**Files**
- Modify: `packages/research-core/src/scaffold.test.ts`

**Steps**
- [ ] 加 it: `force=true 重刷写齐全部 docs 文件`:
  - 先正常 init,然后 force=true 再 init,检查 `docs/CLAUDE.md`、`docs/conventions/collaboration.md` 等 7 个文件存在且含 `'Demo'` 项目名。
- [ ] 加 it: `docs/conventions 目录有 .gitkeep`(它是空目录的派生需求,虽然里面已有 6 文件不算空,但 GITKEEP_DIRS 派生公式仍会放,这个 case 实际验证 `gitkeep` 共存于非空目录的行为是合理的)。
  - 实际上 GITKEEP_DIRS 是 `SCAFFOLD_DIRS.filter(d => d !== 'research/.index')`,而 docs/conventions 里有 6 个 .md 文件,放 .gitkeep 也无害(git 会跟踪),保持现有逻辑即可。
- [ ] 跑测试 GREEN。
- [ ] commit: `feat(research): CLAUDE.md 入口化 + docs/conventions 6 份共用规范模板`

## Task 5 — 全量测试 + typecheck + build

**Steps**
- [ ] `npm test --workspace @rcc/research-core` 全绿
- [ ] `npm test --workspace @rcc/server` 全绿(无关联,但确认没破坏)
- [ ] `npm run typecheck` 三个包全绿
- [ ] `npm run build` web 包成功
- [ ] 如发现破坏,修了再提一个 commit。

## Task 6 — 合并 master + force 重刷 test_research

**Steps**
- [ ] 切到 master: `cd /path/to/remote-cc`
- [ ] `git merge feat/scaffold-docs --ff-only`
- [ ] `git worktree remove .worktrees/scaffold-docs`
- [ ] `git branch -d feat/scaffold-docs`
- [ ] `npm install`(同步 master node_modules 内的 research-core symlink)
- [ ] 在 test_research 目录: `cd /path/to/workspace/test_research && /usr/local/bin/rlab init --force test_research`(如 rlab 没在 PATH,改用 `npx tsx /path/to/remote-cc/packages/research-core/src/cli.ts init --force test_research` 或先 `npm run rlab` 找入口)
- [ ] `ls test_research/docs/conventions/` 确认 6 个文件;`wc -l test_research/CLAUDE.md` 确认 ≤80 行
- [ ] `./start.sh` 重启(在 remote-cc 目录)
- [ ] `curl http://127.0.0.1:6325/api/health` → `{"ok":true}`

## Task 7 — 给用户验收报告

总结改动 + 文件清单 + test_research 路径供用户对比新旧。
