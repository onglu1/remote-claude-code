# CLAUDE.md 入口化与 docs/conventions 拆分 — 设计

## 背景

`rlab init` 现在产出的 `CLAUDE.md` 把「工作模式 + 三权分立 + 判断>执行 + 代码两界 + 只增不毁 + rlab 完整动词清单 + 语言」全部塞进根文件,一是单文件密度太高,二是 rlab 动词清单会随 CLI 演进而变,违背「CLAUDE.md = 永不变工作流入口」的预期。`docs/` 下除 `overview.md` 与 `.gitkeep` 外没有任何共用规范,新项目接手时仍要从零写编码约定、实验流程、Git 规范等本应跨项目复用的内容(参考 `sample-finetune/docs/design/project-conventions.md`、`sample-research/docs/design/project-conventions.md`)。

## 目标

把"科研项目的协作规范"显式分层:

- **CLAUDE.md** = 项目根的工作流入口,永不随技术演进而变。指引 Agent **按固定顺序读完 `docs/` 必读文档**再回答问题或动手干活。
- **docs/CLAUDE.md** = `docs/` 子索引,列出必读文件清单与阅读路线图。
- **docs/conventions/*.md** = 6 份跨项目共用的协作规范,默认生成、用户可改可删,内含「项目特定补充」占位段以便每个项目按需 customize。
- **docs/overview.md** = 项目宪章(目的、约束、当前方向),保留现状。

rlab 完整动词清单从 `CLAUDE.md` 搬到 `docs/conventions/research-workflow.md`;`CLAUDE.md` 里只留三权分立与"研究图是共享工作台、不许擅自改图、每次先 rlab brief"几行**永远不变**的原则。

## 非目标

- **不改 remote-cc 主仓自身的 CLAUDE.md**:本仓的 CLAUDE.md 是工具开发约定,不是 rlab init 出来的。
- **不动 rlab CLI 与 nodes schema**:这次只是模板内容拆分。
- **不强制 doctor 检查 conventions 文件**:用户可以删 / 改这些文件,doctor 不该把它们当强制存在物。
- **不做 LLM 智能化文档生成**:模板内容全是静态文本(允许 `${projectName}` 替换),不调任何 API。

## 现状参照

sample-finetune 与 sample-research 的 `project-conventions.md` 中可复用为通用规范的小节:

- 工作约定: 判断力>执行力、诚实第一、快速探针先于放量、AskUserQuestion、真实系统优先、先看 brief
- 编码规范: 类型标注、显式 import、pathlib/Path、logging vs print、pytest、文件头 docstring
- 实验流程: MANIFEST.json、中断安全与恢复、广度优先、随跑随存、时间记录、smoke 先行
- Git: 分支命名(feat/fix/exp)、提交前缀、每次一个逻辑变更、禁止提交清单
- 文档/绘图: 中文文档、英文代码与图表、自然语言写作原则、matplotlib 论文风格(serif + 色盲友好 + PDF/PNG)

项目特定的部分(GPU 数量、模型路径、错误分类体系、具体 framework 选型、截止日期等)不进默认模板,留 `## 项目特定补充` 段让用户填。

## 设计

### 产物目录

`rlab init` 默认生成的文件树新增 8 个文件(粗体为新增):

```
<项目根>/
  CLAUDE.md                              # 改写为入口指南
  docs/
    CLAUDE.md                            # 【新】docs 子索引
    overview.md                          # 保留
    conventions/                         # 【新目录】
      collaboration.md                   # 【新】协作准则
      coding.md                          # 【新】编码规范
      experiments.md                     # 【新】实验流程
      git.md                             # 【新】Git 规范
      writing.md                         # 【新】文档/绘图规范
      research-workflow.md               # 【新】rlab 动词清单与典型用法
```

### CLAUDE.md(新版,永不变工作流入口,≈50 行)

骨架:

1. 标题: `# <projectName>`
2. 一句话定位: "本文件是项目根节点。接手任何工作前必须按顺序读完 docs 必读文档再开始回答或动手。"
3. **必读文档**(列 7 条):
   - `docs/overview.md` — 项目宪章
   - `docs/CLAUDE.md` — docs 索引与阅读路线图
   - `docs/conventions/collaboration.md`
   - `docs/conventions/research-workflow.md`
   - `docs/conventions/coding.md`
   - `docs/conventions/experiments.md`
   - `docs/conventions/git.md`
   - `docs/conventions/writing.md`
   - 收尾: "读完后回复『已读完背景』再开始工作。"
4. **三权分立**(保留 8 行,这是永不变原则)
5. **研究图是共享工作台**(3 句话精简版):
   - 结构真值在 `research/nodes/**.json`,只能用 `rlab` 命令读写;
   - **Agent 绝不擅自改图**(完整边界见 `docs/conventions/research-workflow.md`);
   - 每个会话开头先 `rlab brief --rich` 拿状态骨架。
6. **当前优先级**: 占位段 `<由研究者随时改写>`

没有完整动词清单、没有"必做/可做/不能做"详表(这些搬到 research-workflow.md)。

### docs/CLAUDE.md(新,≈40 行)

`docs` 子索引。按必读顺序列出 conventions/*.md,简单解释每份的角色;说明 `tasks/`、`evidence/` 是 rlab 管理的产物、不要手改;给出"什么时候新增 design/*.md"的指引。

### docs/conventions/collaboration.md(≈150 行)

提炼自 sample-finetune「工作约定」与 sample-research 的"判断>执行"等:

- **判断力 > 执行力**(最重要,完整阐述包括"何时停下来报告"的具体信号)
- **诚实第一**(负结果照样进 evidence)
- **快速探针先于放量**(smoke / 探针流程示例)
- **抛选项用 AskUserQuestion**
- **真实系统优先**
- **接手工作先看 rlab brief**
- `## 项目特定补充`(占位)

### docs/conventions/coding.md(≈200 行)

- 通用: 类型标注、显式 import(禁通配符)、pathlib/Path、logging vs print、配置 YAML/JSON、pytest 测试核心算法
- 文件头 docstring 规范 + Python 示例代码块
- 行内注释适用场景
- 张量/数学约定(可选小节,常见于 ML 项目)
- `## 项目特定补充`

### docs/conventions/experiments.md(≈220 行)

- MANIFEST.json 结构 + 完整示例(必须字段、status 字段约定)
- 中断安全与恢复(写入侧 + 恢复侧 + 异常 sample 三段)
- 实验执行原则(先全面后精确、粗扫在先、随跑随存、时间记录、长实验先 smoke)
- 实验目录 README 要求(5 点清单)
- `## 项目特定补充`(GPU 数、模型路径)

### docs/conventions/git.md(≈90 行)

- 分支命名: `feat/<name>`、`fix/<name>`、`exp/<name>`
- 提交前缀: `feat:`、`fix:`、`docs:`、`test:`、`chore:`、`exp:`
- 每次一个逻辑变更
- 禁止提交清单(模型权重、output、.env、.bak、*.log)
- 中文 commit message 鼓励
- `## 项目特定补充`

### docs/conventions/writing.md(≈110 行)

- 语言规则: 代码英文、文档中文、图表英文
- 文档写作原则(自然语言、独立可读、避免贴大段配置)
- evidence/task 写作要点
- matplotlib 论文风格完整前置代码
- `## 项目特定补充`

### docs/conventions/research-workflow.md(≈200 行)

把 `CLAUDE.md` 现版「研究图共享工作台」整段搬过来,**保留所有内容**:

- 你必须做的(每个会话开头先读图、回答前先问图、`rlab next`)
- 你可以做的(在研究者明确要求下)的典型场景示例(idea/task/conclude/contradict/supersede/invalidate)
- 你绝对不能做的(不许自驱重构、不许手改 nodes/*.json、不许从 text/*.md 解析结构)
- 完整动词清单(读 13 个 + 写 20 个)
- `## 项目特定补充`(可选: 项目特有的 rlab 用法约定)

### 代码改动面

- `packages/research-core/src/layout.ts`:
  - `SCAFFOLD_DIRS` 加 `docs/conventions`
  - `REQUIRED_FILES` 加 `docs/CLAUDE.md`(让 doctor 视为合规必需)
  - `GITKEEP_DIRS` 自动跟着加(它是 `SCAFFOLD_DIRS.filter` 派生)
- `packages/research-core/src/templates.ts`:
  - 重写 `renderClaudeMd`(入口指南版)
  - 新增 7 个 render 函数: `renderDocsClaudeMd`、`renderConventionCollaboration`、`renderConventionCoding`、`renderConventionExperiments`、`renderConventionGit`、`renderConventionWriting`、`renderConventionResearchWorkflow`
  - `TEMPLATE_FILES` 加 7 个条目
- `packages/research-core/src/scaffold.ts`: **零改动**(已经遍历 `TEMPLATE_FILES`)
- `packages/research-core/src/layout.test.ts` / `scaffold.test.ts` / `templates.test.ts`: 测试断言相应调整

### 测试策略

- **layout.test.ts**: 新增 `docs/conventions` 在 `SCAFFOLD_DIRS` 与 `GITKEEP_DIRS`、`docs/CLAUDE.md` 在 `REQUIRED_FILES`
- **templates.test.ts**: `renderClaudeMd` 不再含 rlab 完整动词清单 (但仍含项目名 + 三权分立);7 个新 render 函数各有一条断言确认关键内容存在(如 collaboration 含"判断力 > 执行力"、experiments 含"MANIFEST.json"、git 含"feat:"、writing 含"色盲友好"、research-workflow 含"完整动词清单"等);`TEMPLATE_FILES` 长度=9 (CLAUDE.md + docs/overview.md + docs/CLAUDE.md + 6 个 conventions)
- **scaffold.test.ts**: `force=true` 重刷会同时写 7 个新文件;每个文件 `<项目名>` 占位替换正确;幂等不重复

### force 重刷 test_research

合并到 master、`npm install`、`./start.sh` 重启服务后,在 test_research 目录跑:

```
rlab init --force test_research
```

(只覆盖 7 个模板文件,不动 nodes/edges)给用户做新旧直观对比。

## 风险与回滚

- **风险 A**: 老项目(如 test_research)有手改过的 CLAUDE.md,force 会覆盖。**缓解**: 默认非 force 跳过(报 skipped),只有显式 `--force` 才覆盖,与现状一致。
- **风险 B**: 新增 6 份 conventions 文件文字量可观(~1000 行总量),token 占用增加。**缓解**: 这是一次性写入文件、不进 prompt,只有 agent 主动 read 时才进上下文,且按必读顺序 Agent 可自我控制(读完一份再读下一份)。
- **风险 C**: doctor 现在多查一个 `docs/CLAUDE.md`,用户若删它 doctor 会报"不合规"。**缓解**: 这正是预期行为(docs/CLAUDE.md 是子索引,删了就读不到必读路线),且 doctor 报告仅提示不阻塞。

回滚: 单 commit revert 即可,scaffold 逻辑没变。

## 验收

- master 合并后 `npm test --workspace @rcc/research-core` 全绿(预期 162 → 162+N,N≈10)。
- `npm run typecheck` 全绿。
- `npm run build` web 包构建成功。
- `rlab init --force /path/to/workspace/test_research` 写出 8 个文件(CLAUDE.md + docs/CLAUDE.md + overview.md + 6 个 conventions/*.md)。
- 服务重启,健康检查 `curl 127.0.0.1:6325/api/health` → `{"ok":true}`。
- 用户视觉验收: CLAUDE.md 短而清晰(≤80 行)、docs/conventions/*.md 内容详实可直接用。
