# 科研工作流系统 — 设计

> 状态：设计稿（已与提出者头脑风暴收敛，待评审）
> 日期：2026-06-22
> 范围：本文是**基础概念设计**，统一定义这套系统"是什么"。具体实现按 §10「实现分层」拆成多份计划（各自走 writing-plans），本文是所有层共享的参照。

## 1. 背景与目标

remote-cc 现有"科研模式" = `apps/server/src/lib/taskEvidence.ts`：用正则解析 `docs/tasks/INDEX.md`、`docs/evidence/INDEX.md` 的手写表格，网页端只能把状态/链接/标签写进 `docs/.rcc-meta.json` 侧车。本质是"只读解析 + 轻量补丁"：脆弱（正则吃手写 markdown）、只认 task/evidence 两类、无 CLI、关系仅靠 `source`/`evidenceLinks` 两个弱字段、无法从零创建。

参照 `sample-finetune` 与 `sample-research` 两个真实科研仓库，提炼出一套更完整、更抗意外的工作流。目标：

- 研究者跟 AI 对话 → 产出/打磨 task；AI 在指令下落实为代码、跑实验、产出 evidence。
- thread/idea/task/evidence 结成**带注解的网络**，让研究者头脑清晰。
- **CLI 收口**结构读写，schema 不被 AI 随机性侵蚀。
- 两个能力：(F1) 在合规目录里工作并优化研究者思考；(F2) 从零创建合规目录。
- 代码分两界：`src/` 稳定核心（被所有实验依赖，质量优先）；`experiments/` 一次性（忠于实验目的，复杂度无所谓，交给 AI）。

### 设计纪律（贯穿全文）

- 不删现有可用功能，新能力并行增量、可切换。
- 文件小而专注、职责单一、可维护；follow remote-cc 既有分层（`lib/` 领域 + `plugins/` 横切 + `routes/` 按域）。
- 中文文档；代码标识符英文。

## 2. 核心理念

1. **不是文档，是「带类型的知识库 + 一个 API」。** 像 git 仓库：从不手改 `.git/`，只用 `git` 动词；结构永远自洽，因为写入只有一条受控通道。科研图同理。
2. **结构与文本分离。** 图结构（节点字段、边、包含、状态、出处）用**专业结构化格式**承载（CLI 独占、schema 校验），markdown **只**承载供人 / AI 阅读的散文；**绝不从文本解析连边或图结构**。两者各管一段、互不侵入。
3. **三权分立。**
   - **人 = 直觉 + 判断 + 结构主权**：灌想法、拍板方向值不值得走、喊停；拆/合/连边/作废等**带判断的结构改动由人发起**（网页直接操作，或自然语言让 Agent 代劳）。
   - **Agent = 基于 KB 的思考 + 答疑 + 指令下执行**：最大价值是就这份知识库与人对话、回答问题；写实验代码、跑、记录都在人的指令下；**绝不擅自重构结构**。
   - **CLI / 图 = 不变量**：schema、传播规则、"只增不毁"由它守，人和 Agent 都越不过去。
4. **只增不毁。** 没有东西被真删；只有被标注、取代、作废——且永远留"为什么"。
5. **缩放即压缩。** 包含层级既是给人的可缩放地图，也是喂给 AI 的多分辨率上下文机制（见 §7）。

## 3. 数据模型

### 3.1 节点类型

- `thread`（方向）：一个值得多实验投入的问题/假设。判断力所在；天然是容器。
- `idea`（思路）：门槛极低的直觉/灵感，一句话即可存。**不是 task**——task 要求完整实验设计，idea 是其下的孵化区。天然是容器（一个模糊 idea 内部可以是一张子图）。
- `task`（实验）：一个**完整实验设计**，可直接开写。
- `evidence`（证据）：一次实验的目的/数据/结论。
- `reference`（论文/外部来源，可选）：外围"来源"节点，**不进实验 DAG**；可被任意节点 `cites`，渲染上与实验节点区分。按主题启用。
- **猜想（conjecture）**：默认作为 thread/task 的属性，需要时再升一等节点。

### 3.2 两种关系，正交

**结构关系**（系统据此推理）

- `contains`：谁装在谁里 = 可缩放的包含树。任何节点都**可**装子图；典型只在两个尺度用（方向级分组、idea 级孵化），多数节点是扁的——**别为嵌套而嵌套**。
- `depends-on`：依赖 / 陈旧传播主干。

**张力关系**

- `contradicts`：对称，自带 `open / resolved`。两条都有效的 evidence 因设置微差结论相反时连此边。

**自由语义边** = `{ from, to, label, note }`

- `label` 自由（预置快捷：`motivated-by / produces / supports / refutes`，仅标签、无特殊逻辑；某标签值得系统特殊对待时，再"升级"成类型）。
- `note` = 一句"**这俩为什么有联系**"——边最该承载的东西。sample-finetune 的「来源」列其实就是写在边上的 why，这里把它正式化。

### 3.3 生命周期 = 节点状态 + 动词（不是边）

- `idea`：孵化中 / 搁置 / 已凝成task / 弃。
- `task`：todo → active → done；异常终态 superseded / invalidated / dropped / blocked。
- `evidence`：active / superseded / invalidated；正交维度 `result = positive / negative / inconclusive`（负结果一等公民，永不隐藏）。
- 动词（改某节点 status + 后继指针，非连接）：`supersede X --by Y`、`invalidate X --reason …`、`drop X --reason …`、`block X --on …`。`invalidate` 额外沿 `depends-on` 连坐复查下游。
- 正交标签 `kind`：baseline / ablation / root-cause / rerun / figure …（可扩展）。
- `aliases[]`：改名留痕（如 ORS→H-Guard，数据/config 沿用旧名）。

### 3.4 archive vs trash

终态的两种呈现：done / superseded → archive（归档留底）；invalidated / dropped → trash（作废留痕）。**都不真删。**

## 4. 必须扛住的意外（对照 sample-research 真实历史验证）

- **做错 → 重做**：旧条目 `invalidate(原因)`，新建 v2 `supersede` 指回；旧的进 trash 仍可查"为什么废"。（sample-research 013→024）
- **两个都对却矛盾**：`contradicts` 连两条 evidence、标 open；解决靠**新起一个受控 task** 隔离哪个旋钮造成分叉，做完产出的 evidence 标 resolved。前提是设置可比对——每个 task/evidence 带 MANIFEST 字段（model/config/注入参/数据集/n/seed），系统可自动 diff、圈出可疑差异点。
- **新发现让旧结论作废**：新 evidence `invalidates` 旧 evidence，系统沿 `depends-on` 把下游"地基已塌"的条目标红逐个待办。**本质 = 给科研装了"类型检查器 / 构建陈旧检测"**：动了地基，立刻知道下游"哪些编译不过"。
- **老师临时塞活** = 普通 task（`source` 记一句"组会"即可），不另设节点。
- **改名** = `aliases` 字段，不做成边。

## 5. 目录结构与映射

```
<repo>/
  CLAUDE.md            # 宪法:大背景+硬约束+"先 rlab 读图"+结构人治+判断>执行+src/experiments 纪律
  research/            # 【新】带类型的知识图(数据结构,非文档)
    nodes/             # 结构=真值:专业数据格式(每节点一个 JSON,CLI 独占,schema 校验)
      threads/   NNN.json
      ideas/     NNN.json
      tasks/     NNN.json
      evidence/  NNN.json
      references/ *.json   # 可选
    text/              # 文本:纯散文 md,只供人/AI 阅读,从不解析结构;由节点 JSON 的 text 字段指向
      tasks/007.md  ...
    .index/            # 由 nodes/ 派生的索引/缓存,可重建,从不手写
  docs/                # 自由散文(不进图的叙事文档)
    overview.md        # 研究宪章:现象 + 为什么值得做
    design/  paper/  reports/  <custom>/   # 按主题扩展
  src/                 # 稳定核心库:质量优先,被所有实验依赖;experiments 可 import src,src 绝不反向
  experiments/NNN_*/   # 一次性实验:设置+冗杂代码,忠于目的即可; README 关联节点编号
  output/NNN_*/        # 实验产物(gitignore) + 每目录一个 MANIFEST.json
```

- **进图的是节点 → `research/`；不进图的叙事 → `docs/`。**
- **结构与文本是两份独立文件**：结构 = `research/nodes/**.json`（CLI 独占的真值，schema 校验，**绝不从 md 解析**）；文本 = `research/text/**.md`（纯散文，人 / AI 自由读写）。节点 JSON 用 `text` 字段指向自己的散文文件。`research/.index/` 仅为快查 / 缩放的**派生缓存**（由 `nodes/` 重建，非第二份真值，故无 desync）。JSON 每节点一文件 → git 可逐节点 diff、亦可人肉速览；若日后需更重的查询能力可换 SQLite（代价是二进制 diff，故默认 JSON）。
- `AGENTS.md` 取消，其内容（改文档边界、提交禁忌、资源纪律）并入 CLAUDE.md。
- 全局递增编号；子编号（如 025.1）用于跟进 / 修正。

### 5.1 节点结构记录（JSON 草案）

`research/nodes/tasks/007.json`：

```json
{
  "id": "task/007",
  "type": "task",
  "title": "错误类型 × 注入位置危害排序矩阵",
  "status": "todo",
  "result": null,
  "kind": ["baseline"],
  "aliases": [],
  "parent": "thread/003",
  "summary": "受控验证 005 预测的错误危害排序",
  "edges": [
    {"to": "evidence/005", "label": "motivated-by", "note": "005 预测的危害排序需受控验证"},
    {"to": "task/006",     "label": "depends-on",   "note": "复用 006 的注入工具"}
  ],
  "text": "research/text/tasks/007.md",
  "code":     ["experiments/007_error_type_position"],
  "output":   ["output/007_error_type_position"],
  "manifest": "output/007_error_type_position/MANIFEST.json"
}
```

- `parent` = `contains` 的反向；容器节点的 children 由索引算。
- `code` / `output` / `manifest` 是**路径引用，不复制**内容。
- 对应散文 `research/text/tasks/007.md` 只写给人 / AI 看：动机 / 想验证什么 / 预期结果 / 配置组等——**不含任何需解析的结构**。
- `summary` 是 brief 用的一句话（假设句人写，状态卷积由 CLI 补）。

## 6. CLI 设计（`rlab`）

唯一的结构写入通道；自描述（`--help` / `schema`）、写入校验、append-only、原子写 + `.bak`、双输出（`--json` 机器 / 人类可读）。**核心库被 CLI 与 remote-cc 后端共用 → 同一张图、两个客户端、永不分叉。** CLI **只**读写 `research/nodes/**.json`（结构），**从不解析 `research/text/**.md` 取结构**；散文文件人 / AI 自由写。

- **读**：`brief`（预算内的全局骨架，见 §7）、`show <id> [--deep]`、`find <query>`、`next`（开放 task / 未解张力 / 被作废拖累的下游 / 没人跟进的 idea / 停滞方向）。
- **结构（人发起）**：`add <type>`、`link <from> <to> --label --note`、`contain / split / merge`、`supersede`、`invalidate`、`drop`、`block`、`contradict` / `resolve`、`alias`。
- **代码 / 产物挂接**：`link-code <id> <path>`、`link-output <id> <path>`、MANIFEST 关联。
- 失败即拒（schema 校验），结构永远自洽。

## 7. Agent 集成与上下文策略

- Agent = 基于 KB 的思考伙伴；结构改动只在人指令下"代劳"（提议 + 执行），不擅自重构；tmux 原生 claude 用 bash 调 `rlab`。
- **上下文策略 = 缩放即压缩**：
  - 每个容器维护一句**摘要**（人写的"当前假设" + CLI 自动卷起的子节点状态 / 最新发现 / 未解张力）。所有摘要拼成**全图骨架**，小到永远入上下文 → `rlab brief`。
  - 答题姿势：**先 `brief` 拿全局骨架（绝不迷宫盲走）→ 只对相关子树 `show --deep`（绝不全量溢出）**。覆盖完整（每个方向骨架里都有一行）+ 细节局部（只在相关处无损展开），同时消解"信息不全"与"撑爆上下文"。
- 摘要不算"Agent 改结构"：假设句由人写（或 Agent 代笔），状态卷积由 CLI 算，故 brief 便宜可信。

## 8. remote-cc 网页集成（高层）

- 研究地图（方向卡片）→ 缩放进子图 → 节点页 → 全局网络图 → idea 孵化树 → 主动提醒（孤儿 idea / 未解张力 / 作废连坐）。
- 人可在网页**直接操作结构**（调同一核心库）；聊天侧 Agent 基于 KB 答疑 / 在指令下执行。
- 现有 `TaskEvidenceBoard` 不破坏：迁移为读新图（或并行保留），旧 `docs/.rcc-meta.json` 提供一次性导入。

## 9. 两个功能

- **F1 在合规目录工作**：读图 / 思考 / 在指令下行动；**收编已有仓库**——从既有 `docs/tasks|evidence/INDEX.md` 一次性导入为节点（含「来源」列 → 边注解）。
- **F2 从零创建**：脚手架 `research/` + `docs/overview.md` + `CLAUDE.md` + `src/experiments/output` 骨架；可走一段引导式问答填"研究宪章"。

## 10. 实现分层与顺序

本设计落地拆为 4 层，各自一份 plan（走 writing-plans）：

1. **约定层**：目录规范、CLAUDE.md / docs 模板、src/experiments 纪律、`rlab init`（F2）。
2. **骨干层**：`research/nodes/` JSON 结构存储（schema 校验）+ `research/text/` 散文分离 + 派生索引 + `rlab` CLI（共享核心库）。
3. **洞察层**：`brief` / 缩放、网络图、缺口 / 张力 / 作废连坐分析。
4. **呈现层**：remote-cc 手机看板、网络图、聊天产出 / 打磨节点的闭环。

- 起点：提出者选定**先约定层**；但骨干层的 schema 与约定层互相印证，约定层会先速写够用的 schema 草案。
- 向后兼容：全程并行增量，不破坏 remote-cc 现有终端 / 聊天 / 文件浏览 / 现有 task 看板。

## 11. 非目标 / YAGNI（已主动收掉，避免过度设计）

- `request`（老师请求）独立节点 —— 砍，作普通 task。
- `reuses-data / cross-validates / responds-to` 等边 —— 砍，需要时用自由标签边。
- 改名做成边 —— 砍，降级为 `aliases` 字段。
- 默认深层嵌套 —— 不做，包含典型很浅。
- Agent 自治维护结构 —— 不做，结构人治。
- 多人协作 / 跨项目借数据 / 预注册假设 —— 本期不展开，模型可容纳，留待后续。

## 12. 开放问题（留给后续层）

- 节点 JSON 完整 schema 与编号 / 子编号规则细节；结构存储用 JSON（默认）还是 SQLite 的最终取舍。
- `brief` 的 token 预算与摘要生成策略（纯计算 vs 含 LLM 概括）。
- 网页网络图的可视化与移动端缩放交互。
- 已有仓库导入的字段映射与冲突处理。
- `reference` / `conjecture` 何时从属性升为一等节点的判据。
