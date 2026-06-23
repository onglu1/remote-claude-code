# 科研工作流系统 — 二期设计(F1 导入 + 网络图 + 聊天闭环)

> 状态：设计稿(用户全权委托设计,自主推进)
> 日期：2026-06-22
> 范围：本文是「呈现层二期」+「F1 收编」三件事的合并设计:
>   1. F1 — 旧 docs/tasks|evidence INDEX.md 一次性导入为节点
>   2. 网络图可视化(节点-边图,移动端友好)
>   3. 聊天端「产出/打磨节点」闭环(CLAUDE.md 模板更新 + 网页 auto-refresh)
>
> 三件事都是一期设计文档明列的留白,独立可做,合一个分支 `feat/research-phase2` 一次性 merge。

## 1. F1 旧数据导入

### 范围

- 把现有 `docs/tasks/INDEX.md` + `docs/evidence/INDEX.md` 解析后写入 `research/nodes/*.json`(经写动词,不绕 schema)。
- **一次性**:已存在同 id 节点不覆盖,跳过并报告(幂等)。
- 旧侧车 `docs/.rcc-meta.json` 的 status/evidenceLinks 一并采用。
- **只导入节点 + 必然的 produces 边**(task → evidence 由 task.evidenceLinks 映射)。旧 source 字段写入 summary(不强行猜出 motivated-by 边的目标 — 留人后续手工补)。

### 字段映射

旧 task → 新 task:
- `number` → `as`(保留原编号)
- `title` → `title`
- `status`: `todo` → `todo`、`doing` → `active`、`done` → `done`(并补一个对应 evidence,见下)、`dropped` → `dropped`(lifecycle.droppedReason 标记「F1 导入」)
- `source` → 拼接进 `summary`(前缀「来源:」)
- `tags` → `kind[]`

旧 evidence → 新 evidence:
- `number` → `as`
- `title` → `title`
- `conclusion` → `summary`
- `result`: 旧 INDEX.md 无此字段,统一标 `inconclusive`(后续人 review 再 supersede/标 +/-)

旧 task.evidenceLinks → 新 task 上的 `produces` 边(指向对应 evidence id)。

如旧 task 是 `done` 但 evidenceLinks 为空,**不自动建** evidence;done 表示「旧体系里完成」,但没数据来源,留人决定。

### 实现

- 核心解析 + 映射纯函数:`packages/research-core/src/legacy/`
  - `parseLegacy.ts`:`parseLegacyDocs(docsDir): { tasks, evidence, meta }` (复用 apps/server 的 taskEvidence.ts 解析逻辑思路,但独立实现以解耦)
  - `importLegacy.ts`:`importLegacy(root, store, parsed): ImportReport` 调写动词
- CLI:`rlab import-legacy [docsDir=docs]` 命令
- 后端:POST `/api/projects/:id/research/import-legacy` body `{ docsDir?: string }`
- 前端:`EmptyState` 加「从旧 INDEX.md 导入」按钮(仅 `docs/tasks/INDEX.md` 存在时显示),走该 endpoint

### 测试

- `parseLegacy.test.ts`:从一组手写 fixture markdown 解析,断言 task/evidence/links 字段
- `importLegacy.test.ts`:解析后调 importLegacy,断言节点数 + edge 数 + 状态映射
- `routes/research.test.ts`:扩 1 例 import-legacy 端到端

## 2. 网络图可视化

### 范围

- 在 ResearchView 加第 5 个子视图 `network`(在 `map/next/analyze/brief` 之后)
- 渲染整张图的节点-边图,**移动端可 pinch zoom + pan + 点节点跳详情**。
- 不在网页上**编辑边**(仍走节点详情页的 link drawer)。

### 库选型

**cytoscape** v3.x(~ 70KB gzipped、移动端手势成熟、API 简洁、TS 类型齐全)。
布局:`cose`(物理力引导)默认;按节点数自适应 — 节点 ≤ 30 用 `cose`,> 30 切 `concentric` 减少计算。

### 视觉

- **节点形状**(按 type):thread = 圆形大、idea = 椭圆、task = 矩形、evidence = 菱形、reference = 三角
- **节点颜色**(按 status):open/active/incubating = 蓝、done/concluded/crystallized = 绿、todo = 灰、blocked = 橙、invalidated/dropped = 红、superseded/parked = 浅灰
- **节点标签**:`<id> 简短 title`(超过 20 字截断)
- **边**:
  - `contains`(由 parent 字段派生) = 黑实线粗
  - `depends-on` = 灰实线细
  - `produces` = 绿实线
  - `contradicts state=open` = 红虚线粗
  - `contradicts state=resolved` = 浅红实线细
  - 其他 label = 浅灰实线细 + label 浮动文字

### 交互

- 点节点 → `onClickNode(id)` 跳详情(走主容器既有 focusedNodeId 机制)
- 双指 pinch zoom、单指 pan
- 顶部小工具栏:「居中」「重排」按钮

### 性能

- 节点数 < 500 时 `cose` 流畅;若超 500 仅展示「图过大,请用待办/Brief」提示(本期 YAGNI 优化)。

## 3. 聊天端「产出/打磨节点」闭环

「闭环」= 让人在聊天里跟 Agent 说「把这个想法记成 idea」、Agent 用 `rlab` 落进图、网页**自动**反映。

### 三件事

#### 3.1 模板更新让 Agent 知道 rlab 是什么

`packages/research-core/src/templates.ts:renderClaudeMd` 末尾加新章节「研究图共享工作台」,具体写:
- 知识图怎么用、`rlab brief` / `rlab next` 怎么查、`rlab show <id>` 怎么深挖
- 何时该写动词(只在用户**明确要求**时);**绝不**自驱重构
- 典型动词 + 一行示例:`rlab add idea --title 'XYZ' --parent thread/003`,`rlab conclude task/007 --result positive --summary '验证通过'`

不动既有「三权分立」「判断 > 执行」等段。

#### 3.2 网页 auto-refresh

`ResearchView.tsx` 加一个 setInterval(10 秒)悄悄 GET `/graph`,与当前 `nodes` 比较:节点数变 / 任一 `updatedAt` 变 → 重新 set state。无变化不触发 React re-render(避免视觉闪烁)。

可在「研究」tab 顶部小字「自动同步中(10s)」状态指示,让用户知道。

#### 3.3 不动核心 CLI / 不加新 hook

聊天里 Agent 跑 `rlab` 是**原生**调用(rlab install 已经把命令装到 ~/.local/bin/rlab),tmux 里 `rlab add` 是普通 shell 命令。没有额外 hook 需要。

### 测试

- `templates.test.ts` 验证 renderClaudeMd 输出含「研究图共享工作台」段、含「rlab brief」「rlab add」「rlab conclude」等关键词
- 网页 auto-refresh 无单测(前端无 vitest);靠真实启动验证

## 4. 模块拆分

```
packages/research-core/src/
  legacy/                      (新)F1 导入
    parseLegacy.ts             解析 docs/tasks|evidence/INDEX.md → 中间表示
    parseLegacy.test.ts
    importLegacy.ts            中间表示 → 调写动词
    importLegacy.test.ts
  runCli.ts                    (改)接 import-legacy 动词
  templates.ts                 (改)CLAUDE.md 末尾加「研究图共享工作台」段

apps/server/src/
  routes/research.ts           (改)加 POST /import-legacy
  routes/research.test.ts      (改)加 1 例

apps/web/
  package.json                 (改)加 cytoscape devDep
  src/components/research/
    NetworkView.tsx            (新)cytoscape 渲染
    ResearchView.tsx           (改)加 'network' SubView + auto-refresh
    EmptyState.tsx             (改)加「从旧 INDEX.md 导入」按钮
  src/lib/researchApi.ts       (改)加 importLegacy method
  src/index.css                (改)加网络图与导入按钮样式
```

## 5. 守护原则

- **不删现有功能**:全部增量。旧 TaskEvidenceBoard 保留;EmptyState 旧路径(空 → 初始化)仍工作。
- **只增不毁**:F1 导入只写不删 — 已存在 id 跳过、不覆盖。
- **CLI 收口**:F1 不绕 schema,全部经 `addNode/linkNodes`。
- **手机优先**:网络图 cytoscape 移动端手势就绪。
- **不依赖 LLM**:三件事都是工程,与 LLM 无关。

## 6. 非目标 / YAGNI

- 边图实时联动(写动词后 graph 自动重排):YAGNI,刷新视图重渲就够。
- F1 导入的边推断启发(从 summary 文字猜 motivated-by 等):留人手工。
- 网络图布局参数 UI 调节:YAGNI。
- 网页内可视化编辑 markdown(text 文件):走文件浏览。

## 7. 提交策略

三件事分 3 个 subagent 顺序做,每件事独立 commit;最后一次 fast-forward merge 到 master。
