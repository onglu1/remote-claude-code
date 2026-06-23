# 科研工作流系统 — 洞察层设计

> 状态：设计稿（用户委托全权设计，自主推进）
> 日期：2026-06-22
> 范围：本文是「洞察层」实现设计，对应总设计 `2026-06-22-research-workflow-system-design.md` §10 的第 3 层。约定层、骨干层均已落地；本层在骨干层的 `ResearchGraph` 之上长出**纯计算**的洞察能力，让 CLI 能回答「我现在该看什么 / 该做什么 / 哪里崩了」。

## 1. 范围与边界

**本层交付**

- **next 待办分析**：综合维度 `rlab next` + 5 个分维度查询（`open` / `tensions` / `stale` / `orphans` / `stagnant`），把人该关注的事按维度列出。
- **invalidate 连坐复查**：`rlab affected-by <id>` 计算沿 `depends-on` 反向闭包，列出"地基已塌"的下游集合；`rlab next` 的 stale 维度复用此能力。
- **brief 富版**：`rlab brief --rich`，在最简骨架之上叠加容器状态卷积（子节点状态计数 / 未解张力数 / 最新 evidence 结果）。默认 `rlab brief` 行为不变（保最简骨架）。
- **网络图分析**：`rlab analyze`，输出全图统计（孤儿 / 断链 / 未解张力 / 停滞方向 / 节点/边计数 / 类型分布）。

**本层不做（划给后续层）**

- 呈现层：remote-cc 后端 API、手机网页看板、聊天端产出/打磨节点闭环。
- LLM 概括：所有 brief / next 输出都是**纯计算**。LLM 概括是 Agent 拿到 CLI 输出后自己做的事，不该被 CLI 接管。
- F1 收编：从旧 `docs/tasks|evidence/INDEX.md` 导入为节点。
- 复杂图算法（中心度、聚类、强连通分量）：YAGNI；网络图可视化时再说。

**承接骨干层**

- 不动 `schema.ts` / `store.ts` / `graph.ts` / 任何写动词：洞察层是纯**读+派生**，不写节点。
- 在 `packages/research-core/src/insights/` 新子目录里加纯函数；CLI 通过 `runCli.ts` 接入。
- 测试沿用 vitest 模式（与源码共置）；不需要新 IO 测试套件（用内存图直接构造）。

## 2. 设计哲学守护

复制骨干层的守护清单，对照本层：

| 原则 | 本层如何守护 |
|------|-------------|
| 只增不毁 | 洞察层只读图，不写任何节点 |
| 人发起结构改动 | invalidate 连坐**查询时算**，不在 invalidate 时主动改下游 status；下游节点状态由人后续判断后用现有写动词改 |
| CLI 收口 | 所有洞察能力都是 CLI 动词；底层是纯函数，可被未来呈现层后端复用 |
| 结构与文本分离 | 不解析任何散文 |
| 派生非真值 | next/analyze 的所有输出都是从节点 JSON 派生，节点 JSON 始终是唯一真值 |
| 不依赖 LLM | 全部纯计算 |

## 3. 数据模型（不动 schema，仅派生类型）

不加新字段、不加新 status 值。所有洞察结果是**派生类型**，定义在 `insights/types.ts`：

```ts
// 单条"该关注的事"
export interface NextItem {
  kind: 'open-task' | 'tension' | 'stale' | 'orphan' | 'stagnant-thread';
  id: string;                  // 主体节点 id
  title: string;
  reason: string;              // 一句话:为什么进了这个列表
  related?: string[];          // 关联节点(如 contradicts 对方、affected-by 上游)
  age?: number;                // 距 updatedAt 的天数(陈旧度,可排序)
}

// affected-by 闭包结果
export interface AffectedReport {
  from: string;
  downstream: { id: string; path: string[] }[]; // path: 从 from 到该节点的 depends-on 链
}

// 全图统计
export interface GraphStats {
  byType: Record<string, number>;       // thread/idea/task/evidence/reference 各几个
  byStatus: Record<string, number>;     // 跨类型的 status 直方图
  orphans: string[];                    // 无 parent 且无入边的节点(reference 除外)
  dangling: string[];                   // 指向不存在 id 的边(from→to)
  openTensions: number;                 // contradicts state=open 的对数(去重)
  stagnantThreads: string[];            // 停滞方向 id
  totals: { nodes: number; edges: number; containsTrees: number };
}

// 富 brief 的一行(供渲染层用)
export interface RichBriefLine {
  id: string;
  depth: number;
  statusTag: string;
  title: string;
  rollup?: string;  // 容器卷起:"3 done / 2 open · 1 张力 · 最新 +"
}
```

## 4. 五件套定义

### 4.1 阈值约定

"陈旧 / 停滞"按 `updatedAt` 与当前时间差判断，单位：天。

- **默认阈值**：14 天（两周）。
- **CLI 覆盖**：每个相关动词都支持 `--stale-days N`。
- **为何不存阈值进 schema**：阈值是**呈现偏好**，不是节点事实；放节点会让多人/多场景用同一阈值，反而僵硬。

### 4.2 五维度定义

| 维度 | 定义 | reason 模板 |
|------|------|-------------|
| **open-task** | `task.status ∈ {todo, active}` | "open task,等待你推进" |
| **tension** | 任意节点 `edges[]` 有 `label='contradicts' state='open'`,按对去重 | "未解张力:与 <other> 结论相反" |
| **stale** | 所有 `status='invalidated'` 节点的 `affected-by` 闭包之并集 | "上游 <id> 已作废,可能需要复查" |
| **orphan** | `idea.status='incubating'` 且无 `parent` 且无入边 | "无归属 idea,需决定方向或丢弃" |
| **stagnant-thread** | `thread.status='open'` 且其 contains 子树里所有节点的 `max(updatedAt)` 早于阈值 | "方向静默 N 天" |

### 4.3 affected-by（连坐查询）

- **输入**：节点 id `X`。
- **算法**：从图所有节点出发，递归收集「存在 `edge.label='depends-on'` 指向 X 的节点」，再继续从这些节点找它们的上游 depends-on 链 —— 实际上是「从 X 沿 depends-on 入边反向 BFS」。
- **输出**：`AffectedReport`，每个下游节点附带从 X 到它的 depends-on 路径（供人判断「到底隔多远」）。
- **不做**：不真改下游 status；下游"该不该作废"由人后续看 affected-by 报告再决定。

### 4.4 brief 富版

- **保留默认 `brief`**：现有最简骨架不动（向后兼容）。
- **新增 `brief --rich`**：每行末尾叠加容器卷起摘要 `rollup`：
  - 子节点状态计数（`3 done / 2 open / 1 blocked`）
  - 未解张力数（`· 1 张力`）
  - 最新 evidence 结果（`· 最新 +` / `· 最新 -` / `· 最新 ±`）
  - 叶子节点无 rollup
- **token 预算**：所有 rollup 文本是几十字内；几百节点的项目富 brief 也只有几十 KB，远小于 Agent 上下文。提供 `--max-bytes N` 在极端情况下截断尾部。

### 4.5 网络图分析

`rlab analyze` 输出 `GraphStats`（人类可读表格 + `--json` 结构化）。具体覆盖：

- **byType**：thread/idea/task/evidence/reference 各几个。
- **byStatus**：跨类型 status 直方图（`open: 1, todo: 3, active: 2, done: 5, ...`）。
- **orphans**：所有"无 parent 且无入边"的节点，**排除** thread（thread 天然是顶层，无 parent 是正常的）和 reference（外围节点，无入边也正常）。
- **dangling**：所有指向不存在 id 的边（复用 doctor 已有逻辑，但单独列在 analyze 里）。
- **openTensions**：`contradicts state=open` 的对数（按 `{min(a,b), max(a,b)}` 去重）。
- **stagnantThreads**：停滞方向 id 列表（按 4.2 定义）。
- **totals**：节点总数 / 边总数 / contains 树数（顶层无 parent 节点数）。

## 5. CLI 设计（在 `rlab` 上追加）

不动现有动词。新增：

| 动词 | 签名 | 作用 |
|------|------|------|
| `next` | `next [--stale-days N] [--kind K1,K2…]` | 综合 5 维度列表（默认全维度,按 reason 类型分组） |
| `open` | `open` | 仅 open-task 维度 |
| `tensions` | `tensions` | 仅未解张力,按对列出 |
| `stale` | `stale` | 仅 stale 维度（所有 invalidated 的 affected-by 并集） |
| `orphans` | `orphans` | 仅孤儿 idea |
| `stagnant` | `stagnant [--stale-days N]` | 仅停滞方向 |
| `affected-by` | `affected-by <id>` | 单点反向 depends-on 闭包(含路径) |
| `analyze` | `analyze` | 全图统计 |
| `brief` | `brief [--rich] [--max-bytes N]` | 已有动词,加 `--rich` 出富版;默认行为不变 |

每个新动词都支持 `--json` 双输出（与骨干层惯例一致）。

## 6. 模块拆分

`packages/research-core/src/insights/` 新子目录：

```
insights/
  types.ts        派生类型(NextItem, AffectedReport, GraphStats, RichBriefLine)
  next.ts         next 综合 + 5 个分维度查询函数
  affected.ts     affectedBy(graph, id) 反向 depends-on BFS
  briefRich.ts    renderBriefRich(graph) — 在最简 brief 上叠加 rollup
  analyze.ts      analyzeGraph(graph, opts) → GraphStats
  age.ts          updatedAt → 天数 / 是否陈旧的小工具(可注入 now)
```

- 每个文件单一职责（next 综合 / 连坐 / 富 brief / 全图统计）。
- 全部纯函数：输入 `graph: ResearchGraph` + 参数，输出派生类型。
- `runCli.ts` 加分发：调上述函数 + 人类可读渲染 + `--json` 透传。

## 7. 测试策略

沿用骨干层 vitest 模式（同名 `*.test.ts` 与源码共置）：

- **纯函数单测**：每个 `insights/*.ts` 内的核心函数（如 `nextOpenTasks(graph)`、`affectedBy(graph, id)`、`buildGraphStats(graph, now)`、`renderBriefRich(graph)`）直接断言派生类型。`now` 注入便于陈旧度断言。
- **跨维度集成单测**：构造一张完整小图（thread→task→evidence + contradicts + invalidate 一条），跑 `next()` 断言所有维度都被收集。
- **CLI 端到端**：扩 `runCli.test.ts`，跑 `next/open/tensions/stale/orphans/stagnant/affected-by/analyze/brief --rich` 各一遍，断言 `code=0` 与 `stdout` 关键片段。
- **真实集成冒烟**：扩 `scripts/smoke-backbone.ts`（或新增 `smoke-insights.ts`）：在冒烟流尾部 invalidate 一节点，跑 `affected-by` 列出下游、`next` 显示 stale 条目、`analyze` 报告全图，全部断言 `code=0` 且输出非空。

## 8. 与其他层的衔接

- **骨干层**：完全只读消费 `ResearchGraph` 与 `NodeStore`；不动 schema、不动写动词。
- **未来呈现层**：所有派生类型（NextItem / AffectedReport / GraphStats / RichBriefLine）从 barrel 导出；后端 HTTP API 直接 import 调用，与 CLI 同源。永不分叉。
- **不碰** remote-cc 现有终端 / 聊天 / 文件浏览 / 旧 TaskEvidenceBoard。

## 9. 非目标 / YAGNI

- LLM 概括（spec §12 开放问题）：本层确定**不做**。Agent 拿 brief 后自己用上下文做语义梳理。
- 图算法（中心度、聚类、强连通分量、最短路）：YAGNI，留呈现层网络图可视化时按需。
- 配置文件存阈值：阈值只走 CLI flag。
- 时区/跨天计算：所有时间都按 UTC ISO 算天数差。

## 10. 留待后续层（开放问题）

- 后端 API 路径：是 `/api/projects/:id/research/next` 还是 `/api/research/:projectId/next`？
- 网页是否展示富 brief、还是只用结构化派生类型自己渲染？
- 旧 `INDEX.md` 导入后，"来源"列如何映射到 `edges` 的 `note`。
