# 科研工作流系统 — 骨干层设计

> 状态：设计稿（承接总设计，待提出者过目）
> 日期：2026-06-22
> 范围：本文是「骨干层」实现设计，对应总设计 `2026-06-22-research-workflow-system-design.md` §10 的第 2 层。约定层已完成并合并入 master；本层在其目录骨架上长出真正的图存储与 `rlab` CLI 写入/查询动词。

## 1. 范围与边界

**本层交付（做什么）**

- `research/nodes/**.json` 图存储：完整 zod schema（按 type 判别联合）、写入校验、CLI 独占写入。
- `research/text/**.md` 散文分离：节点 JSON 的 `text` 字段指向散文文件；CLI 绝不解析散文取结构。
- `research/.index/` 派生索引：由 `nodes/` 重建的查询缓存，非第二真值，可随时重建。
- `rlab` CLI：写动词全套（结构改动，人发起）+ 读动词 `show` / `find` / `list` + 最简 `brief`（纯计算的全局骨架）。
- 全局分发：让同机任意科研仓库（含 Python 项目如 sample-finetune）能调用 `rlab`。

**本层不做（划给后续层，防止 scope 蔓延）**

- 洞察层：`brief` 的 token 预算与智能摘要、`next` 待办分析、`invalidate` 沿 `depends-on` 的连坐复查、网络图分析。本层只**存**结构与状态，不做跨节点的智能推理。
- 呈现层：remote-cc 后端 API、手机网页看板、聊天端产出/打磨节点闭环。
- F1 收编：从旧 `docs/tasks|evidence/INDEX.md` 导入为节点（留呈现层或独立任务）。

**承接约定层**

- 复用 scaffold 已建的 `research/nodes/{threads,ideas,tasks,evidence}` 目录。
- 用本层的完整判别联合 schema **替换**约定层 `schema.ts` 的草案 `ResearchNode`（草案本就声明「留给骨干层收紧」）。
- 保留 `rlab init` / `doctor`；在其上增加动词。`doctor` 扩展：除目录/文件校验外，再校验 `nodes/` 内每个 JSON 的 schema 合法性 + 边引用完整性（指向的 id 必须存在）。

## 2. 数据模型

### 2.1 编号

- **每类型独立递增数字**：`thread/003`、`idea/012`、`task/007`、`evidence/005`。分配时扫描该类型目录、取现有最大号 +1（`numbering` 模块负责）。
- **子编号 `NNN.M`**（如 `task/025.1`）：用于「对某节点的跟进 / 修正」，由人在动词里**显式指定** `--as 025.1`，不自动生成。
- **`reference` 用语义 id**：`reference/vaswani2017`（作者+年份 citekey）。论文按来源命名更自然，且 reference 不进实验 DAG。
- id 形如 `<type>/<number-or-citekey>`，与磁盘路径 `research/nodes/<typeDir>/<number-or-citekey>.json` 一一对应（`nodeId` 模块负责 id ↔ 路径互转）。

### 2.2 节点 schema（按 type 判别联合）

**公共字段**（所有节点）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `<type>/<number>`，如 `task/007` |
| `type` | enum | thread / idea / task / evidence / reference |
| `title` | string | 一行标题 |
| `summary?` | string | brief 用的一句话（人写的假设句 / 结论句） |
| `parent?` | string | `contains` 的反向；容器的 children 由索引算 |
| `edges` | Edge[] | 见 §2.5；默认 `[]` |
| `aliases` | string[] | 改名留痕（ORS→H-Guard）；默认 `[]` |
| `kind` | string[] | 正交标签 baseline/ablation/root-cause/rerun/figure…；默认 `[]` |
| `text?` | string | 指向散文文件，如 `research/text/tasks/007.md` |
| `createdAt` | string | ISO 时间戳 |
| `updatedAt` | string | ISO 时间戳，每次写动词刷新 |

**按 type 收紧的字段**：

- `thread`：`status: open | parked | concluded`（方向的轻生命周期）。
- `idea`：`status: incubating | parked | crystallized | dropped`。
- `task`：
  - `status: todo | active | done | superseded | invalidated | dropped | blocked`
  - `expectation?: string`（一句话**预期结果**，给 brief 做「预期 vs 实际」对照；完整预期写散文 `text`）
  - `code: string[]`（实验代码目录路径引用，如 `experiments/007_error_type_position`；默认 `[]`）
  - `lifecycle?: Lifecycle`（见 §2.4）
- `evidence`：
  - `status: active | superseded | invalidated`
  - `result: positive | negative | inconclusive | mixed`（**必填**，负结果一等公民；`mixed` = 某条件成立、另一条件不成立）
  - `output: string[]`（产物目录路径引用；默认 `[]`）
  - `manifest?: string`（本次执行的 MANIFEST.json 路径，记 model/config/注入参/数据集/n/seed）
  - `lifecycle?: Lifecycle`
- `reference`：`url?: string`、`citekey?: string`（无生命周期 status）。

### 2.3 task / evidence 边界：预期 vs 实际

这是模型里最易含混处，故钉死一条边界：

- **task = 问句 / 预期**：要验证什么假设、怎么设置、**预期**得到什么。`status` 只回答「这实验做没做」。task **不带 result**——它对应 result 的东西是 `expectation`（预期），不是结果。
- **evidence = 作答 / 实际**：这次执行**实际**跑出什么、结论是什么、可不可信。`result` 极性 + `summary` 一句话结论 + `text` 完整分析，三层各管一段。
- 「预期 vs 实际」的对照是 evidence 相对 task 的增量价值（预期阳性却跑出阴性 = 意外发现），所以两者**互补不重叠**。
- 一个 task 可关联 **0 / 1 / 多个** evidence（重跑、不同配置各一份）。
- **代码归 task（设计实现）、产物归 evidence（某次执行）**：`code[]` 挂 task，`output[]` / `manifest` 挂 evidence。一份实验代码可跑多次、产生多份 evidence。
- **交互合一消除繁琐**：`rlab conclude <task> --result … --summary …` 一步把 task 标 `done`、自动建关联 evidence、连上 `produces` 边。日常手感是「给实验填结论」，不是「管两个节点」。本体分离（清晰）、交互合一（不繁琐）。

### 2.4 生命周期 = 节点状态 + 后继指针（不是边）

`Lifecycle`（task / evidence 可选挂载）：

```
Lifecycle = {
  supersededBy?: string     // 被谁取代
  supersedes?: string       // 取代了谁
  invalidatedReason?: string
  droppedReason?: string
  blockedOn?: string[]      // 卡在哪些节点上
  at?: string               // 最近一次生命周期变更时间
}
```

- `supersede X --by Y`：X.status=`superseded`、X.lifecycle.supersededBy=Y、Y.lifecycle.supersedes=X。
- `invalidate X --reason …`：X.status=`invalidated`、记 reason。**本层只改本节点**；「沿 `depends-on` 连坐复查下游」是洞察层的 `next` 分析。
- `drop` / `block` 同理改 status + 记原因 / blockedOn。
- **没有 delete**：drop / invalidate 只改 status。archive（done/superseded）vs trash（invalidated/dropped）只是 status 的呈现分组，**只增不毁**。

### 2.5 两类边

统一存在节点的 `edges[]` 里，元素结构：

```
Edge = { to: string, label: string, note?: string, state?: 'open' | 'resolved' }
```

- **自由语义边**：`{to, label, note?}`。`label` 自由，预置快捷 `motivated-by` / `produces` / `supports` / `refutes` / `depends-on` / `cites`（仅标签，本层无特殊逻辑；`depends-on` 的连坐、`cites` 的 reference 渲染等留后续层）。`note` = 一句「这俩为什么有联系」，边最该承载的 why。
- **张力边 `contradicts`**：复用同一结构，`label='contradicts'` + `state: open | resolved`（对称语义；本层只存，成对写入由 `contradict` 动词保证）。`resolve` 动词把 `state` 翻成 `resolved`。
- 边是**有向存储**（写在 from 节点上）；反向邻接由派生索引算，供 `show` 显示「谁指向我」。

## 3. 存储与索引

### 3.1 真值布局

```
research/
  nodes/
    threads/003.json      ideas/012.json      tasks/007.json
    evidence/005.json     references/vaswani2017.json
  text/
    tasks/007.md  ...     # 纯散文，CLI 从不解析
  .index/                 # 派生缓存（见 3.2）
```

- 每节点一个 JSON = git 可逐节点 diff、人可肉眼速览。
- 存储格式定为 **JSON**（非 SQLite）：换来 git diff 友好 + 人可直接读；科研仓库节点量级几百，全量读进内存做查询绰绰有余。

### 3.2 派生索引

- `research/.index/graph.json`：由 `nodes/` 全量重建的查询缓存。内容：children 反向索引（parent→children）、反向邻接（to→from 边）、按 type/status 分组、id→title 映射。
- **重建策略**：每个写动词成功后**全量重建**（节点几百个，重建在几十毫秒内，简单可靠；增量/惰性是过早优化，YAGNI）。
- 非第二真值：`rlab reindex` 可随时从 `nodes/` 重建；索引损坏/缺失不影响真值，读动词在索引缺失时可回退为现场全量加载。

### 3.3 原子写

沿用 `taskEvidence.ts` 已验证的模式：写前 `copyFile` 到 `.bak`、写 `.tmp-<pid>` 再 `rename`。schema 校验失败即拒、不落盘。保证任何时刻磁盘上的 JSON 都是 schema 合法的。

## 4. CLI 设计（`rlab`）

唯一结构写入通道；自描述（`--help`）、写入校验、原子写、双输出（`--json` 机器 / 默认人类可读）。CLI **只**读写 `nodes/**.json`，**从不**解析 `text/**.md` 取结构。

### 4.1 写动词（结构改动，人发起）

| 动词 | 签名 | 作用 |
|------|------|------|
| `add` | `add <type> --title … [--parent …] [--summary …] [--as NNN]` | 建节点、分配编号 |
| `set` | `set <id> [--title …] [--summary …] [--expectation …]` | 改可编辑字段 |
| `link` | `link <from> <to> --label … [--note …]` | 加自由语义边 |
| `unlink` | `unlink <from> <to> [--label …]` | 删边（结构勘误，非作废语义） |
| `contain` | `contain <child> --in <parent>` / `--out` | 设/解 parent（contains） |
| `split` | `split <id> --into <title…>` | 把一个 idea 拆成若干子 idea（parent=原 idea） |
| `merge` | `merge <ids…> --title …` | 多个 idea 凝成一个 task：建 task、被并 idea 标 `crystallized` 并加 `crystallized-into` 边（本层只支持 idea→task 一种合并语义，故省去 `--into-task` 显式标志） |
| `conclude` | `conclude <task> --result … --summary … [--manifest …] [--output …]` | 标 task `done` + 建 evidence + `produces` 边 |
| `supersede` | `supersede <id> --by <newId> [--reason …]` | 见 §2.4 |
| `invalidate` | `invalidate <id> --reason …` | 见 §2.4 |
| `drop` | `drop <id> --reason …` | 标 dropped |
| `block` | `block <id> --on <ids…> [--reason …]` | 标 blocked |
| `unblock` | `unblock <id>` | 解除 blocked → 回 todo/active |
| `contradict` | `contradict <a> <b> [--note …]` | 成对加 `contradicts` 边（state=open） |
| `resolve` | `resolve <a> <b> [--by <taskId>]` | contradicts 翻 resolved |
| `alias` | `alias <id> --add <name>` | 加别名 |
| `status` | `status <id> --set <status>` | 通用状态推进（如 todo→active），受 schema 约束 |
| `link-code` | `link-code <taskId> <path>` | 挂实验代码目录 |
| `link-output` | `link-output <evidenceId> <path> [--manifest …]` | 挂产物 / manifest |

每个写动词：schema 校验 → 原子写 → 重建索引 → 双输出。失败即拒，结构永远自洽。每个动词的**核心是纯函数**（输入：当前图 + 参数；输出：变更后的节点集），IO 在外层注入，便于单测。

### 4.2 读动词 + brief

- `show <id> [--deep]`：节点详情（字段、出边、反向入边）；`--deep` 递归展开 contains 子树与一跳邻居。
- `find <query>`：在 id/title/summary/aliases/kind 上做子串匹配，列命中节点。
- `list [--type …] [--status …]`：按类型 / 状态过滤列举。
- `brief`：**最简全局骨架**（纯计算，无 LLM）。从顶层节点（无 parent）起遍历 `contains` 树，缩进打印每行 `id [status简记] title`，evidence 附 result 极性符号（＋/－/?/±），task 可附 `expectation→` 对照。例：

```
thread/003 [open] 错误危害方向
  task/007 [done] 错误类型×位置矩阵
    └ evidence/005 [active +] 危害排序确认
  idea/012 [incubating] 激活值统计特征
evidence/009 [invalidated] fi_server 参数有误，已作废
```

  token 预算、人写摘要的智能卷积留洞察层；本层只做「全部节点一行骨架」的纯遍历。

### 4.3 双输出与校验

- 默认人类可读（上表/树形），`--json` 输出结构化供 remote-cc 后端与脚本消费。
- 核心库（schema + store + graph + verbs + brief）被 CLI 与未来的 remote-cc 后端**共用** → 同一张图、两个客户端、永不分叉。

## 5. 模块拆分（`packages/research-core/src/` 新增）

follow 约定层「文件小而专注、职责单一、依赖注入便于测」：

- `schema.ts`（扩展）：判别联合的完整 zod schema + `Lifecycle` / `Edge`。
- `nodeId.ts`：id ↔ 磁盘路径互转、type ↔ 目录名映射。
- `numbering.ts`：编号分配（扫目录取 max+1；子编号校验）。
- `store.ts`：单节点 JSON 的读 / 写（原子写 + .bak）/ 列举 / 存在性。纯 IO，不懂语义。
- `graph.ts`：加载全部节点 → 内存图（节点表 + 邻接 + children 反向）+ 查询（show/find/list/邻居/子树）。纯函数化。
- `derivedIndex.ts`：`.index/graph.json` 的重建与读取。
- `verbs/`：写动词语义，按族拆分——`create.ts`（add/set）、`structure.ts`（link/unlink/contain/split/merge/alias）、`lifecycle.ts`（conclude/supersede/invalidate/drop/block/unblock/status）、`tension.ts`（contradict/resolve）、`attach.ts`（link-code/link-output）。每个动词纯函数 + 外层注入 IO。
- `brief.ts`：最简 brief 的纯计算渲染。
- `runCli.ts`（扩展）：在 init/doctor 之上 dispatch 上述动词，解析 flag、调核心库、双输出。
- `cli.ts`（不变）：进程入口，传 `process.cwd()` 给 `runCli`。

## 6. 全局分发

- **目标**：同机任意目录（含无 Node 的 Python 项目 sample-finetune）可执行 `rlab`，且操作的是**调用方 cwd** 下的 `research/`（`runCli` 已接受 cwd 参数）。
- **方案（最轻，符合约定层「无构建步、tsx 直跑源码」）**：`research-core` 提供 `bin/rlab` 包装脚本（shebang，内部 `exec` 用 tsx 跑 `research-core/src/cli.ts "$@"`，工作目录为调用方 cwd）；提供幂等的 `rlab install`（沿用 remote-cc `setup-statusline` 的幂等安装模式）把包装脚本软链到 `~/.local/bin/rlab`。Python 项目里直接 `rlab add task …` 即可，无需该项目有 node_modules。
- **替代（YAGNI，留后续）**：用 esbuild 打成自包含单文件 `.mjs`（跨机 / 无 tsx 环境才需要）。本层不引入打包步。

## 7. 测试策略

沿用约定层 / `taskEvidence.ts` 的 vitest 模式（`*.test.ts` 与源码共置）：

- **纯逻辑单测**：编号分配、id↔路径、图构建与查询、各写动词的状态转换、brief 渲染——全部抽纯函数直接断言。
- **IO 往返测**：`store` / `derivedIndex` 用真实临时目录（`mkdtemp`）测写→读回→断言。
- **每个写动词**：成功路径 + schema 拒绝 + 原子性（中途失败不留半成品）。
- **CLI 端到端**：`runCli(argv, tmpdir)` 跑 `init → add thread → add task → conclude → link → brief`，断言输出与磁盘图自洽。
- **真实集成冒烟**：脚本在临时科研仓库跑完整流程（含 `contradict`/`resolve`、`supersede`、`invalidate`），断言 `doctor` 通过、图引用完整。

## 8. 与约定层 / 现有系统的衔接

- 约定层 schema 草案被本层完整 schema 替换；约定层测试相应更新（已知改动，非破坏）。
- `rlab init` / `doctor` 保留并增强；`doctor` 新增 schema + 边引用校验。
- 现有 `apps/server/src/lib/taskEvidence.ts`（旧 docs/tasks|evidence 解析）**不动**，与新图并行存在；接入后端与导入旧数据是后续层的事。
- 不碰 remote-cc 后端 / 网页 / 终端 / 聊天 / 文件浏览。

## 9. 非目标 / YAGNI

- 索引增量更新、SQLite 后端 —— 不做（全量重建 + JSON 足够）。
- `brief` 智能摘要 / token 预算、`next` 分析、`depends-on` 连坐 —— 洞察层。
- 后端 API、网页看板、聊天闭环、旧数据导入 —— 呈现层 / F1。
- 跨机分发打包、多人协作、跨项目借数据 —— 留后续。

## 10. 留待后续层（开放问题）

- `brief` 的 token 预算与人写摘要的智能卷积策略（洞察层）。
- `invalidate` 沿 `depends-on` 的连坐复查与「构建陈旧检测」呈现（洞察层）。
- 网页网络图可视化与移动端缩放交互（呈现层）。
- 旧 `INDEX.md` → 节点的字段映射与「来源」列 → 边注解（F1）。
- `reference` / `conjecture` 何时从属性 / 外围升为参与 DAG 的一等节点的判据。
