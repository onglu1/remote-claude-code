# 科研工作流系统 — 呈现层设计（一期）

> 状态：设计稿（用户全权委托设计，自主推进）
> 日期：2026-06-22
> 范围：本文是「呈现层」一期实现设计，对应总设计 `2026-06-22-research-workflow-system-design.md` §10 的第 4 层。约定层、骨干层、洞察层均已落地并合并入 master(`6b1c39f`)。本层把已有的「带类型知识库 + 9 + 9 个 CLI 动词」铺成手机优先的网页应用,让用户在浏览器里看见和操作图。

## 1. 范围与边界

**本层一期交付**

- **后端 API**:`/api/projects/:projectId/research/...`,所有读动词 + 写动词都暴露成 HTTP endpoint;直接调 `@rcc/research-core`(NodeStore / verbs / insights);zod 校验输入,失败返 400。
- **手机优先网页**:在 `ProjectDetail` 加新 tab `research`(保留旧 `tasks` 不删),内部 4 个子视图:
  - **地图**(默认):顶级 thread 卡片网格;点 thread 进 thread 详情(展开 contains 子树)。
  - **待办**:next 多维度,分维度分组;点条目进节点详情。
  - **体检**:analyze 输出,显示总量/类型分布/状态分布/问题清单。
  - **Brief**:富版 brief 渲染(纯文本预览),顶部切换最简/富版。
- **节点详情页**:任何节点 id 都能进,显示字段/出边/入边/操作菜单(改字段/加边/conclude/supersede/invalidate/drop/block/contradict/...)。
- **空仓库引导**:第一次进未 init 项目时显示「初始化研究图」按钮,调 `init` endpoint(本质就是 rlab init)。
- **真实集成 smoke**:端到端跑 `init → add → conclude → contradict → invalidate → next → analyze → brief` 全部通过 HTTP API,验证后端可用。

**本层不做(留二期 / 留聊天端闭环)**

- **网络图可视化**(D3/Cytoscape 节点-边图):移动端交互难做好,YAGNI,留二期。
- **聊天端产出/打磨节点的闭环**:让 Agent 在对话里"把这个想法记成 idea"。涉及 AskUserQuestion hook、聊天端 KeyBar、Agent 指令解析。独立可大可小,留二期或单独一层。
- **F1 旧数据导入**:从 `docs/tasks|evidence/INDEX.md` 导入为节点。独立任务。
- **多用户并发写**:本层不做乐观锁/版本冲突;依赖 NodeStore 的原子写已够单用户。
- **网页直接编辑散文 `text/**.md`**:散文文件浏览复用现有 `FileBrowser`,不重做。

**承接洞察层**

- 直接 import `@rcc/research-core` 的:`NodeStore`/`ResearchGraph`/`runCli`/`scaffoldResearchRepo`/全部 verbs 函数(addNode/setNode/...) /全部 insights 函数(nextAll/affectedBy/analyzeGraph/renderBriefRich)。
- 不在 shared 包重复定义节点类型;前端直接 `import type { ResearchNode, NextItem, GraphStats } from '@rcc/research-core'`(已 barrel)。
- 不动 `@rcc/research-core`(完全只读消费,与后端 / CLI 共用)。

## 2. 设计哲学守护

| 原则 | 本层如何守护 |
|------|-------------|
| 不删除现有功能 | 旧 `TaskEvidenceBoard` / `tasks` tab 完全保留,只**新增** `research` tab |
| 改动简单清晰、职责单一 | 后端按域拆: `routes/research.ts` 路由 + `lib/researchProvider.ts` 项目-NodeStore 缓存;前端按视图拆 `components/research/*` |
| 不依赖 LLM | 网页直接调 CLI 写动词,Agent 闭环留二期 |
| 只增不毁 | 所有写操作都通过既有写动词(invalidate / drop / supersede 都只改 status) |
| 人发起结构改动 | 网页操作 = 人主动点;无任何自动重构 |
| 手机优先、贴近原生 AI 网页 | 卡片网格、segmented control、bottom sheet drawer、大点击区 |
| 流式 | 不需要(图操作是离散事件,非流式) |

## 3. 后端架构

### 3.1 模块拆分

```
apps/server/src/
  lib/
    researchProvider.ts   每个 project.path 对应一个 NodeStore(惰性建,写动词后失效)
  routes/
    research.ts            HTTP 路由,鉴权 + zod 校验 + 调 research-core
    research.test.ts       端到端测试(临时 tmp 目录、真实 NodeStore)
```

### 3.2 `researchProvider.ts`

```ts
import { NodeStore, ResearchGraph } from '@rcc/research-core';
import { canSeeProject } from './authz';
import type { Project } from '@rcc/shared';

interface CachedProvider {
  store: NodeStore;
  graphAt: number; // 上次 graph 缓存的 mtime;若 store 写动词后失效
  graph?: ResearchGraph;
}

export class ResearchProviderRegistry {
  private readonly cache = new Map<string, CachedProvider>();

  /** 取项目对应的 NodeStore(惰性建);store 是 IO 层,新建廉价。 */
  store(projectPath: string): NodeStore {
    let p = this.cache.get(projectPath);
    if (!p) {
      p = { store: new NodeStore(projectPath), graphAt: 0 };
      this.cache.set(projectPath, p);
    }
    return p.store;
  }

  /** 取项目对应的 ResearchGraph(全量加载,可缓存);写动词后调 invalidate。 */
  graph(projectPath: string): ResearchGraph {
    const p = this.cache.get(projectPath) ?? { store: new NodeStore(projectPath), graphAt: 0 };
    if (!p.graph) p.graph = new ResearchGraph(p.store.list());
    this.cache.set(projectPath, p);
    return p.graph;
  }

  invalidate(projectPath: string): void {
    const p = this.cache.get(projectPath);
    if (p) p.graph = undefined;
  }
}
```

### 3.3 路由清单

所有路由前缀 `/api/projects/:projectId/research`,统一鉴权(`requireAuth` 中间件 + `canSeeProject`)。

**读**

| 方法 | 路径 | 返回 |
|------|------|------|
| GET | `/init-status` | `{ initialized: boolean, root: string }` (探测 research/ 目录) |
| GET | `/graph` | `{ nodes: ResearchNode[] }`(全量节点;前端自己构图) |
| GET | `/brief?rich=1` | `{ text: string }` |
| GET | `/next?stale-days=N&kinds=k1,k2` | `{ items: NextItem[] }` |
| GET | `/analyze` | `{ stats: GraphStats }` |
| GET | `/affected-by/:id` | `{ report: AffectedReport }` |
| GET | `/node/:id` | `{ node, inEdges }` |

**写**

| 方法 | 路径 | body |
|------|------|------|
| POST | `/init` | `{ name?: string, force?: boolean }` |
| POST | `/add` | `{ type, title, as?, parent?, summary?, expectation?, result?, url? }` |
| POST | `/set` | `{ id, title?, summary?, expectation?, text? }` |
| POST | `/link` | `{ from, to, label, note? }` |
| POST | `/unlink` | `{ from, to, label? }` |
| POST | `/contain` | `{ child, parent?: string \| null }`(null 解绑) |
| POST | `/split` | `{ id, into: string[] }` |
| POST | `/merge` | `{ ids: string[], title }` |
| POST | `/conclude` | `{ task, result, summary?, manifest?, output? }` |
| POST | `/supersede` | `{ id, by, reason? }` |
| POST | `/invalidate` | `{ id, reason }` |
| POST | `/drop` | `{ id, reason }` |
| POST | `/block` | `{ id, on: string[] }` |
| POST | `/unblock` | `{ id }` |
| POST | `/contradict` | `{ a, b, note? }` |
| POST | `/resolve` | `{ a, b, by? }` |
| POST | `/alias` | `{ id, name }` |
| POST | `/status` | `{ id, set }` |
| POST | `/link-code` | `{ id, path }` |
| POST | `/link-output` | `{ id, path, manifest? }` |

写动词成功 → 调 `rebuildIndex` + `provider.invalidate(projectPath)`,返回 `{ ok: true, node?: ResearchNode }`。失败 → 400 + `{ error: string }`。

### 3.4 数据契约

派生类型从 `@rcc/research-core` 直接导出给 shared / web,**不在 shared 里复制**:

```ts
// shared 包暴露(re-export):
export type {
  ResearchNode, NodeType,
  NextItem, AffectedReport, GraphStats, RichBriefLine,
} from '@rcc/research-core';
```

`packages/shared/src/research.ts` 新文件做 re-export,`schemas.ts` 不动(它的旧 `TaskItem` 是给 `TaskEvidenceBoard` 用的)。

## 4. 前端架构

### 4.1 路由与挂载点

- `packages/shared/src/routes.ts`:`ProjectTab` 加 `'research'`(保留 `'tasks'`)。
- `apps/web/src/components/ProjectDetail.tsx`:`tabs.push({ key: 'research', label: '研究' })`(仅 `project.type === 'research'` 时);内容区 `{tab === 'research' && <ResearchView project={project} />}`。
- 子视图(地图/待办/体检/Brief/节点详情/thread 详情)在 `ResearchView` 内部用 `useState` 切,**URL 不细分**(避免污染 shared 路由 schema,前端单页面状态机更轻)。

### 4.2 模块拆分

```
apps/web/src/
  lib/
    researchApi.ts          所有 /api/projects/:id/research/* 的 fetch 包装(返回类型从 @rcc/research-core 取)
  components/research/
    ResearchView.tsx        主容器:子视图切换 + 共享 graph 数据 + 失效重拉
    EmptyState.tsx          未 init 时的「初始化」按钮
    MapView.tsx             默认:thread 卡片网格 → contains 子树展开
    NextView.tsx            待办:NextItem 列表,按 kind 分组
    AnalyzeView.tsx         体检:GraphStats 渲染(总量 + 直方图 + 问题清单)
    BriefView.tsx           Brief 富版/最简切换
    NodeDetail.tsx          节点详情:字段/出边/入边/操作菜单
    NodeOpsDrawer.tsx       动词触发的 bottom sheet 表单(per-动词字段)
    ThreadCard.tsx          thread 卡片(用于地图视图)
    NodeCard.tsx            通用节点卡片(用于子树展开 / next 列表 / find 结果)
    StatusBadge.tsx         状态色块(thread.open / task.done / evidence.+ 等)
    EdgeList.tsx            出/入边表(可点跳)
```

### 4.3 子视图设计要点

**地图(默认)**

- 顶部 segmented control:`[地图][待办][体检][Brief]`(粘顶,scroll 时保持)。
- thread 卡片网格(单列,卡片高 < 80px):标题、status badge、rollup 一行小字。
- 浮层 FAB「+」:新建顶级节点(可选 thread/idea/task)。
- 点 thread → 进 thread 详情:展开 contains 子树(按 type 分组,每组一列;每个 child 是 NodeCard);顶部「+」按钮加子节点。

**待办**

- 顶部小 chips:`全部 / open-task / tension / stale / orphan / stagnant`(单选,默认全部)。
- 列表条目:`[kind 色块] id  title  → reason`,点 → 节点详情。

**体检**

- 顶部一行总量:`节点 N · 边 M · contains 树 T`。
- 类型分布:横向条形图(thread/idea/task/evidence/reference)。
- 状态分布:同样的条形图,跨类型直方图。
- 问题清单:孤儿 / 断链 / 张力对 / 停滞方向 — 每项点开列具体 id。

**Brief**

- 顶部切换:`最简 / 富版`。
- pre 标签里渲染缩进文本,可整段复制(Agent 上下文用)。

**节点详情**

- 顶部:`< 返回` + `id + status badge + title`。
- 摘要 + kind tags + aliases。
- `text`(若有)显示「散文 →」链接(指向 `FileBrowser` 那个文件)。
- 出边表:`→ to (label: note)`,点 to → 进对应节点。
- 入边表:`← from (label)`,点 from → 进对应节点。
- 操作菜单(底部固定栏 + 三点菜单):
  - 改字段(title / summary / expectation / text)
  - 加边
  - 改状态(走 `/status`,按 type 给合法 status 选项)
  - conclude(仅 task)
  - supersede / invalidate / drop / block / unblock
  - alias
  - 张力:contradict / resolve(选另一节点)
  - 挂接:link-code(仅 task) / link-output(仅 evidence)
  - 拆/合(仅 idea):split / merge

### 4.4 动词触发的 Drawer

`NodeOpsDrawer.tsx` 是个 bottom sheet(手机端):顶部标题写动词名,中间是按动词定义的字段,底部「确认 / 取消」。

各动词字段表(zod 同名):
- `set`: title? summary? expectation? text?
- `add(子节点)`: type? title* as? summary? expectation?(task) result?(evidence)
- `link`: to* label* note?
- `contain`: parent*(picker) or 解绑
- `conclude`: result*(picker:positive/negative/inconclusive/mixed) summary? manifest? output?
- `supersede`: by*(node picker) reason?
- `invalidate / drop`: reason*
- `block`: on*(multi node picker)
- `unblock`: (无字段)
- `contradict`: b*(node picker) note?
- `resolve`: b*(picker) by?(task picker)
- `alias`: name*
- `status`: set*(按 type 给选项)
- `split`: into*(逗号分隔)
- `merge`: ids*(multi picker) title*

### 4.5 数据流

- `ResearchView` 用 `useEffect` 拉 `/graph` + `/init-status`,缓存在自身 state。
- 每个子视图共用这份 graph 数据,自己做本地派生(可调用 `@rcc/research-core` 的 `new ResearchGraph(nodes)` + `nextAll/analyzeGraph/renderBriefRich`,把派生计算放前端,减少后端往返)。
- 写动词:`researchApi.postVerb('xxx', body)` → 后端 → 成功后 `ResearchView` 重拉 `/graph`(简单粗暴,几百节点拉回也才几十 KB),失败弹 toast。
- 没有乐观更新(一期 YAGNI);成功后再 refresh。

## 5. 错误处理

- 后端:zod 校验失败 → 400 + `{ error: 'detail' }`;NodeStore 抛 → 400 + `{ error: e.message }`(写动词的语义错误,如「节点已存在」「未知节点」)。其他异常 → 500。
- 前端:统一 `researchApi` 抛 `Error(message)`;`NodeOpsDrawer` 提交时 catch → 表单顶部红字显示;成功 → 关 drawer + 重拉 graph。
- 空状态:`/init-status.initialized=false` → 显示 `EmptyState`,点「初始化」走 `/init`,成功后重拉。

## 6. 测试

- **后端**:`apps/server/src/routes/research.test.ts` vitest:
  - 真实 `mkdtempSync` 临时 project.path + 注入 fake projects.json
  - 鉴权:无 cookie/不可见项目 → 401/404
  - 每个读 endpoint 跑一遍(`/init-status` 初始 false → `/init` → true → `/add` → `/graph` 含新节点)
  - 每个写 endpoint 关键字段缺失 → 400(zod 校验)
  - 完整流:init → add thread/task → conclude → next 含 open-task → invalidate → next 含 stale
- **前端**:不写自动化测试(沿用项目惯例 — apps/web 无 vitest 依赖)。
- **真实集成 smoke**:`apps/server/scripts/smoke-research-api.ts`:
  - 启 Fastify 实例 + 登录(共用现有 smoke 模式)
  - 跑 init → add 几个节点 → next/analyze/brief → invalidate → next 含 stale → 断言全部 200 + body 关键字段非空

## 7. 与现有系统的衔接

- 不动:`apps/server` 的 `lib/auth.ts` / `lib/projects.ts` / `plugins/requireAuth.ts` / `lib/taskEvidence.ts` / `routes/taskEvidence.ts`(旧科研模式并行保留)。
- 不动:`apps/web` 的 `Terminal.tsx` / `components/chat/*` / `TaskEvidenceBoard.tsx`(旧看板保留)。
- 复用:`lib/authz.ts.canSeeProject`、`plugins/requireAuth.makeRequireAuth`、`@rcc/shared` 的 `Project` / `ProjectTab`(扩 `'research'`)。

## 8. 部署与启动

- 后端代码加完直接 `./start.sh --no-build`(只改后端用 --no-build 跑得最快)生效。
- 前端代码加完跑 `./start.sh`(会重建 dist)。
- 不引入新依赖(本层全用现有 React / Vite / Fastify / zod)。

## 9. 非目标 / YAGNI

- 网络图可视化(D3/Cytoscape):移动端体验差,留二期。
- 服务端 SSE 推图更新:多客户端不必要,一期单用户,前端写后重拉即可。
- 节点 JSON 编辑器(直接改 JSON):违反「只通过动词写」,严格禁。
- 实时多端协作:留后续。
- 直接渲染 markdown text(`research/text/*.md`):复用现有 FileBrowser,不重做。
- 网络图筛选 / 搜索高级语法(只支持 `find` 的子串):留二期。

## 10. 留待后续(二期 / 聊天端层 / F1)

- 网络图可视化(节点-边图、放缩、聚类)。
- 聊天端产出/打磨节点闭环:Agent 在对话里写动词,落 sidecar、网页同步刷新。
- F1 收编:从 `docs/tasks|evidence/INDEX.md` 导入为节点 + 「来源」列 → 边 `note`。
- 多人协作的版本冲突/乐观锁。
- 富文本编辑器编辑 `research/text/**.md`(不离开网页)。
