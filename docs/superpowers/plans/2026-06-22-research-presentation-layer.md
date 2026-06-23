# 科研工作流 — 呈现层一期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把骨干 + 洞察层铺成手机优先网页:后端 21 endpoint + 前端 4 子视图 + 节点详情 + 动词表单。

**Architecture:** `apps/server/src/routes/research.ts` Fastify 路由 + `lib/researchProvider.ts` NodeStore 缓存,直接调 `@rcc/research-core` 同源。前端 `apps/web/src/components/research/*` 在浏览器构图 + 本地派生计算。`ProjectTab` 加 `'research'`,保留旧 `'tasks'`。

**Tech Stack:** Fastify, zod, `@rcc/research-core`(已发布), React 18, Vite, vitest(后端)。无新依赖。

---

## 文件结构（一次性全图）

**后端新增（`apps/server/src/`）**

- `lib/researchProvider.ts` — 项目 path → NodeStore + 缓存的 ResearchGraph(写后失效)
- `routes/research.ts` — 7 读 + 14 写 endpoint;鉴权 + zod 校验 + 调 research-core
- `routes/research.test.ts` — 端到端测试(临时 tmp 目录 + 真实 NodeStore)
- `scripts/smoke-research-api.ts` — 启实例 + 登录 + HTTP 端到端跑全流程

**前端新增（`apps/web/src/`）**

- `lib/researchApi.ts` — fetch 包装;每个 endpoint 一个方法
- `components/research/ResearchView.tsx` — 主容器:子视图切换 + graph 缓存 + 失效重拉
- `components/research/EmptyState.tsx` — 未 init 时「初始化」按钮
- `components/research/StatusBadge.tsx` — 状态色块(thread/idea/task/evidence)
- `components/research/NodeCard.tsx` — 通用节点卡片
- `components/research/ThreadCard.tsx` — thread 专用卡片(顶级地图用)
- `components/research/EdgeList.tsx` — 出边 + 入边表
- `components/research/MapView.tsx` — 地图:顶级 thread 网格 + thread 详情子树展开
- `components/research/NextView.tsx` — 待办分维度列表
- `components/research/AnalyzeView.tsx` — 体检:总量+直方图+问题清单
- `components/research/BriefView.tsx` — Brief 富版/最简切换
- `components/research/NodeDetail.tsx` — 节点详情页
- `components/research/NodeOpsDrawer.tsx` — bottom sheet 动词表单(20 个动词)

**修改**

- `packages/shared/src/routes.ts` — `ProjectTab` 加 `'research'`
- `packages/shared/src/research.ts` — 新文件,re-export `@rcc/research-core` 类型
- `packages/shared/src/index.ts` — `export * from './research'`
- `apps/web/src/components/ProjectDetail.tsx` — tabs 加 `'research'`,内容区路由到 `ResearchView`

---

## Task 1: shared 类型铺路（ProjectTab + re-export）

**Files:**
- Modify: `packages/shared/src/routes.ts`
- Create: `packages/shared/src/research.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/routes.test.ts`(扩 1 例)

- [ ] **Step 1: 改 ProjectTab 测试期望(失败测试)**

打开 `packages/shared/src/routes.test.ts`,找已有的 `it('parse 项目 tab ...')`,在 tab 三个分支后加一例。先看现有测试结构(用 `cat` 或 view),然后在与 `'files'` / `'tasks'` 同级处加 `'research'` 的断言。例:

```ts
it('parse project research tab', () => {
  const r = parseRoute('/p/foo/research');
  expect(r).toEqual({ name: 'project', projectId: 'foo', tab: 'research' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --prefix packages/shared 2>&1 | tail -10`
Expected: 至少有 1 个 FAIL(`'research'` 路径无法解析或 ProjectTab 类型不接受)

- [ ] **Step 3: 改 `packages/shared/src/routes.ts`**

`export type ProjectTab = 'sessions' | 'files' | 'tasks';` →

```ts
export type ProjectTab = 'sessions' | 'files' | 'tasks' | 'research';
```

并在 `parseRoute` / `routeToPath` 的相关分支补上 `'research'`(找现有的 `'tasks'` 处理位置照搬即可)。

- [ ] **Step 4: 建 `packages/shared/src/research.ts`**

```ts
/**
 * 科研图派生类型 — 全部 re-export 自 @rcc/research-core(barrel)。
 * 共用同一份 schema/insights,前后端永不分叉。
 */
export type {
  ResearchNode, ThreadNode, IdeaNode, TaskNode, EvidenceNode, ReferenceNode,
  NodeType, Edge, Lifecycle,
  ThreadStatus, IdeaStatus, TaskStatus, EvidenceStatus, EvidenceResult,
  NextItem, AffectedReport, GraphStats, RichBriefLine,
} from '@rcc/research-core';
```

- [ ] **Step 5: 改 `packages/shared/src/index.ts`**

末尾追加:

```ts
export * from './research';
```

- [ ] **Step 6: 改 `packages/shared/package.json` 添加 dep**

确认 `packages/shared/package.json` 的 `dependencies` 含 `"@rcc/research-core": "*"`。若无,加上。然后 `npm install --prefix packages/shared` 让 workspace link。

实际命令:

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
# 先看
cat "$WT/packages/shared/package.json"
# 如缺,编辑加 "dependencies": { "@rcc/research-core": "*" }
# 然后 npm install(若 monorepo 自动 link 则无需)
```

- [ ] **Step 7: 跑测试 + typecheck**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm test --prefix "$WT/packages/shared" 2>&1 | tail -10
npx tsc -p "$WT/packages/shared" --noEmit 2>&1 | tail -5
```

Expected: 测试 PASS、typecheck 无报错。

- [ ] **Step 8: Commit**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
git -C "$WT" add packages/shared/
git -C "$WT" commit -m "feat(shared): ProjectTab 加 'research' + re-export research-core 派生类型"
```

---

## Task 2: 后端 researchProvider(NodeStore 缓存)

**Files:**
- Create: `apps/server/src/lib/researchProvider.ts`
- Create: `apps/server/src/lib/researchProvider.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/lib/researchProvider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchProviderRegistry } from './researchProvider';
import { scaffoldResearchRepo, addNode } from '@rcc/research-core';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-rp-'));
  scaffoldResearchRepo(root, { projectName: 'Demo' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ResearchProviderRegistry', () => {
  it('store(path) 返回同一个 NodeStore 实例(惰性建,缓存)', () => {
    const reg = new ResearchProviderRegistry();
    const s1 = reg.store(root);
    const s2 = reg.store(root);
    expect(s1).toBe(s2);
  });
  it('graph(path) 全量加载并缓存', () => {
    const reg = new ResearchProviderRegistry();
    addNode(root, reg.store(root), { type: 'thread', title: 'T1', as: '001' });
    const g1 = reg.graph(root);
    const g2 = reg.graph(root);
    expect(g1).toBe(g2);
    expect(g1.get('thread/001')?.title).toBe('T1');
  });
  it('invalidate 后下次 graph() 重新加载', () => {
    const reg = new ResearchProviderRegistry();
    const store = reg.store(root);
    addNode(root, store, { type: 'thread', title: 'T1', as: '001' });
    const g1 = reg.graph(root);
    addNode(root, store, { type: 'task', title: 'T2', as: '001' });
    reg.invalidate(root);
    const g2 = reg.graph(root);
    expect(g2).not.toBe(g1);
    expect(g2.nodes.size).toBe(2);
  });
  it('initialized(path):scaffold 后 true', () => {
    const reg = new ResearchProviderRegistry();
    expect(reg.initialized(root)).toBe(true);
    expect(reg.initialized('/nonexistent-/x/y/z')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm test --prefix "$WT/apps/server" -- researchProvider 2>&1 | tail -10
```

Expected: FAIL,找不到 `./researchProvider`。

- [ ] **Step 3: 实现 `apps/server/src/lib/researchProvider.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import { NodeStore, ResearchGraph } from '@rcc/research-core';

interface Cached {
  store: NodeStore;
  graph?: ResearchGraph;
}

/**
 * 每个 project.path 对应一个 NodeStore(惰性建,缓存到 process 生命周期)。
 * ResearchGraph 是全量节点的内存快照,写动词后用 invalidate 失效让下次重建。
 */
export class ResearchProviderRegistry {
  private readonly cache = new Map<string, Cached>();

  store(projectPath: string): NodeStore {
    let c = this.cache.get(projectPath);
    if (!c) {
      c = { store: new NodeStore(projectPath) };
      this.cache.set(projectPath, c);
    }
    return c.store;
  }

  graph(projectPath: string): ResearchGraph {
    const c = this.cache.get(projectPath) ?? { store: new NodeStore(projectPath) };
    if (!c.graph) c.graph = new ResearchGraph(c.store.list());
    this.cache.set(projectPath, c);
    return c.graph;
  }

  invalidate(projectPath: string): void {
    const c = this.cache.get(projectPath);
    if (c) c.graph = undefined;
  }

  /** 探测项目是否已 scaffold(看 research/nodes/threads 目录存在)。 */
  initialized(projectPath: string): boolean {
    try {
      return fs.statSync(path.join(projectPath, 'research', 'nodes', 'threads')).isDirectory();
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm test --prefix "$WT/apps/server" -- researchProvider 2>&1 | tail -10
```

Expected: 4/4 PASS。

- [ ] **Step 5: 跑整套 server 测试 + typecheck 确保无回归**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm test --prefix "$WT/apps/server" 2>&1 | tail -10
npx tsc -p "$WT/apps/server" --noEmit 2>&1 | tail -5
```

Expected: 全 PASS、typecheck 无报错。

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add apps/server/src/lib/researchProvider.ts apps/server/src/lib/researchProvider.test.ts
git -C "$WT" commit -m "feat(server): researchProvider — 项目-NodeStore 注册表(惰性 + 缓存 + invalidate)"
```

---

## Task 3: 后端 routes/research 读 endpoint + test 基础

**Files:**
- Create: `apps/server/src/routes/research.ts`
- Create: `apps/server/src/routes/research.test.ts`

读 endpoint(7 个):
- GET `/init-status`
- GET `/graph`
- GET `/brief?rich=1`
- GET `/next?stale-days=N&kinds=...`
- GET `/analyze`
- GET `/affected-by/:id`
- GET `/node/:id`

- [ ] **Step 1: 先看现有路由模板,模仿其鉴权 + 项目查找**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
cat "$WT/apps/server/src/routes/taskEvidence.ts"
```

记下:
- 鉴权:`makeRequireAuth(ctx)` → `preHandler` 用
- 项目查找:`ctx.projects.get(id)` 返回 Project | undefined
- 可见性:`canSeeProject(user, project)` 返 boolean

- [ ] **Step 2: 写失败测试 `apps/server/src/routes/research.test.ts`(只覆盖读 endpoint)**

模仿 `taskEvidence.test.ts` 或别的现有测试的 setup(看 fixture 模式)。骨架:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerResearchRoutes } from './research';
import { ResearchProviderRegistry } from '../lib/researchProvider';
import { addNode, scaffoldResearchRepo, NodeStore } from '@rcc/research-core';
import type { Project, AuthUser } from '@rcc/shared';

// 最小化 AppContext fake;按 ctx 实际接口补充
function makeCtx(projects: Project[]) {
  const provider = new ResearchProviderRegistry();
  const me: AuthUser = { id: 'u1', username: 'tester', role: 'admin' } as AuthUser;
  return {
    provider,
    projects: { get: (id: string) => projects.find((p) => p.id === id) },
    requireAuth: async (req: any) => { req.user = me; }, // 测试用桩
    canSeeProject: () => true,
  };
}

async function buildApp(projects: Project[]): Promise<{ app: FastifyInstance; ctx: ReturnType<typeof makeCtx> }> {
  const app = Fastify();
  await app.register(cookie);
  const ctx = makeCtx(projects);
  app.addHook('preHandler', ctx.requireAuth);
  registerResearchRoutes(app, ctx as any);
  return { app, ctx };
}

let projectRoot: string;
beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-research-route-'));
});
afterEach(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

describe('GET /api/projects/:id/research/init-status', () => {
  it('未 scaffold → initialized=false', async () => {
    const { app } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/research/init-status' });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ initialized: false, root: projectRoot });
  });
  it('scaffold 后 initialized=true', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/research/init-status' });
    expect(JSON.parse(r.body).initialized).toBe(true);
  });
});

describe('GET /research/graph', () => {
  it('空仓 → nodes: []', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/research/graph' });
    expect(JSON.parse(r.body)).toEqual({ nodes: [] });
  });
  it('有节点 → 返回 nodes 数组', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app, ctx } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    addNode(projectRoot, ctx.provider.store(projectRoot), { type: 'thread', title: 'T', as: '001' });
    ctx.provider.invalidate(projectRoot);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/research/graph' });
    const body = JSON.parse(r.body);
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe('thread/001');
  });
});

describe('GET /research/brief, /next, /analyze', () => {
  it('三个读 endpoint 200 + 非空 payload', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app, ctx } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    addNode(projectRoot, ctx.provider.store(projectRoot), { type: 'task', title: 'T', as: '001' });
    ctx.provider.invalidate(projectRoot);

    const brief = await app.inject({ method: 'GET', url: '/api/projects/p1/research/brief' });
    expect(brief.statusCode).toBe(200);
    expect(JSON.parse(brief.body).text).toContain('task/001');

    const next = await app.inject({ method: 'GET', url: '/api/projects/p1/research/next' });
    expect(next.statusCode).toBe(200);
    expect(JSON.parse(next.body).items.length).toBeGreaterThan(0);

    const an = await app.inject({ method: 'GET', url: '/api/projects/p1/research/analyze' });
    expect(an.statusCode).toBe(200);
    expect(JSON.parse(an.body).stats.totals.nodes).toBe(1);
  });
});

describe('GET /research/node/:id, /affected-by/:id', () => {
  it('node 返回 node + inEdges;affected-by 返回 report', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app, ctx } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    const store = ctx.provider.store(projectRoot);
    addNode(projectRoot, store, { type: 'task', title: 'A', as: '001' });
    addNode(projectRoot, store, { type: 'task', title: 'B', as: '002' });
    ctx.provider.invalidate(projectRoot);

    const n = await app.inject({ method: 'GET', url: '/api/projects/p1/research/node/task%2F001' });
    expect(n.statusCode).toBe(200);
    expect(JSON.parse(n.body).node.id).toBe('task/001');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test --prefix "$WT/apps/server" -- research.test 2>&1 | tail -10
```

Expected: FAIL,找不到 `./research` 或路由不存在。

- [ ] **Step 4: 实现 `apps/server/src/routes/research.ts`**

```ts
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import {
  scaffoldResearchRepo,
  rebuildIndex,
  affectedBy,
  nextAll,
  analyzeGraph,
  renderBriefRich,
  renderBrief,
  ResearchGraph,
} from '@rcc/research-core';

// 项目查找 + 鉴权;失败抛已注入的 401/404 风格错误。
function resolveProject(ctx: AppContext, req: FastifyRequest, projectId: string) {
  const project = ctx.projects.get(projectId);
  if (!project) {
    throw Object.assign(new Error('项目不存在'), { statusCode: 404 });
  }
  const user = (req as any).user;
  if (!ctx.canSeeProject(user, project)) {
    throw Object.assign(new Error('不可见'), { statusCode: 404 });
  }
  return project;
}

export function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  const PARAMS = z.object({ id: z.string() });
  const NODE_PARAMS = z.object({ id: z.string(), nodeId: z.string() });

  // ============ 读 ============

  app.get('/api/projects/:id/research/init-status', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const p = resolveProject(ctx, req, id);
    return { initialized: ctx.research.initialized(p.path), root: p.path };
  });

  app.get('/api/projects/:id/research/graph', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const p = resolveProject(ctx, req, id);
    const store = ctx.research.store(p.path);
    return { nodes: store.list() };
  });

  app.get('/api/projects/:id/research/brief', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const rich = (req.query as any)?.rich === '1';
    const max = (req.query as any)?.['max-bytes'];
    const p = resolveProject(ctx, req, id);
    const graph = ctx.research.graph(p.path);
    const text = rich
      ? renderBriefRich(graph, max ? parseInt(max, 10) : undefined)
      : renderBrief(graph);
    return { text };
  });

  app.get('/api/projects/:id/research/next', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const q = req.query as Record<string, string | undefined>;
    const p = resolveProject(ctx, req, id);
    const graph = ctx.research.graph(p.path);
    const items = nextAll(graph, {
      staleDays: q['stale-days'] ? parseInt(q['stale-days']!, 10) : undefined,
      kinds: q.kinds ? q.kinds.split(',').filter(Boolean) as any : undefined,
    });
    return { items };
  });

  app.get('/api/projects/:id/research/analyze', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const p = resolveProject(ctx, req, id);
    return { stats: analyzeGraph(ctx.research.graph(p.path)) };
  });

  app.get('/api/projects/:id/research/affected-by/*', async (req) => {
    const { id } = PARAMS.parse(req.params);
    const p = resolveProject(ctx, req, id);
    // /affected-by/<urlencoded id>
    const nodeId = decodeURIComponent((req.params as any)['*']);
    return { report: affectedBy(ctx.research.graph(p.path), nodeId) };
  });

  app.get('/api/projects/:id/research/node/*', async (req, reply) => {
    const { id } = PARAMS.parse(req.params);
    const p = resolveProject(ctx, req, id);
    const nodeId = decodeURIComponent((req.params as any)['*']);
    const graph = ctx.research.graph(p.path);
    const node = graph.get(nodeId);
    if (!node) { reply.code(404); return { error: '节点不存在' }; }
    return { node, inEdges: graph.inEdges(nodeId) };
  });

  // ============ 写(占位,T4 实现) ============
}
```

**注意**:`AppContext` 需要新增 `research: ResearchProviderRegistry` 字段。打开 `apps/server/src/context.ts`,把 provider 注入。如:

```ts
// context.ts 顶部 import
import { ResearchProviderRegistry } from './lib/researchProvider';
// AppContext 接口加:
research: ResearchProviderRegistry;
// 构造 ctx 时:
const research = new ResearchProviderRegistry();
return { /* ...其他 */ research };
```

- [ ] **Step 5: 把 registerResearchRoutes 接到 app 启动**

打开 `apps/server/src/app.ts`(或主路由注册处,搜 `registerTaskEvidenceRoutes` 找现有 pattern),在同一处加:

```ts
import { registerResearchRoutes } from './routes/research';
// 在 registerTaskEvidenceRoutes(app, ctx) 之后:
registerResearchRoutes(app, ctx);
```

- [ ] **Step 6: 跑测试**

```bash
npm test --prefix "$WT/apps/server" -- research.test 2>&1 | tail -15
npm test --prefix "$WT/apps/server" 2>&1 | tail -10
npx tsc -p "$WT/apps/server" --noEmit 2>&1 | tail -5
```

Expected: research.test 全 PASS;整 server 包无回归;typecheck `ok`。

- [ ] **Step 7: Commit**

```bash
git -C "$WT" add apps/server/src/routes/research.ts apps/server/src/routes/research.test.ts apps/server/src/context.ts apps/server/src/app.ts
git -C "$WT" commit -m "feat(server): routes/research 读 endpoint(init-status/graph/brief/next/analyze/affected-by/node)"
```

---

## Task 4: 后端 routes/research 写 endpoint(20 个动词)

**Files:**
- Modify: `apps/server/src/routes/research.ts`(在「写(占位)」位置补全)
- Modify: `apps/server/src/routes/research.test.ts`(加写动词测试)

每个写 endpoint 都是同一模式:
1. zod 校验 body
2. resolveProject + provider.store
3. 调对应 verb 函数
4. `rebuildIndex(p.path, store)` + `provider.invalidate(p.path)`
5. 返回 `{ ok: true, ...result }` 或 try/catch 失败 400

- [ ] **Step 1: 加共享 helper 与 schema(在 research.ts 顶部)**

```ts
// 在 import 末尾加
import {
  addNode, setNode,
  linkNodes, unlinkNodes, containNode, aliasNode,
  splitIdea, mergeIdeas,
  concludeTask, supersedeNode, invalidateNode, dropNode, blockNode, unblockNode, setStatus,
  contradictNodes, resolveContradiction,
  linkCode, linkOutput,
} from '@rcc/research-core';

// 文件内、registerResearchRoutes 之外或之内,加 helper:
function doneWrite(ctx: AppContext, projectPath: string): void {
  rebuildIndex(projectPath, ctx.research.store(projectPath));
  ctx.research.invalidate(projectPath);
}
```

- [ ] **Step 2: 写 zod schemas(在 helper 后)**

```ts
const InitSchema = z.object({ name: z.string().optional(), force: z.boolean().optional() });
const AddSchema = z.object({
  type: z.enum(['thread', 'idea', 'task', 'evidence', 'reference']),
  title: z.string().min(1),
  as: z.string().optional(),
  parent: z.string().optional(),
  summary: z.string().optional(),
  expectation: z.string().optional(),
  result: z.enum(['positive', 'negative', 'inconclusive', 'mixed']).optional(),
  url: z.string().optional(),
});
const SetSchema = z.object({
  id: z.string(), title: z.string().optional(), summary: z.string().optional(),
  expectation: z.string().optional(), text: z.string().optional(),
});
const LinkSchema = z.object({ from: z.string(), to: z.string(), label: z.string().min(1), note: z.string().optional() });
const UnlinkSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() });
const ContainSchema = z.object({ child: z.string(), parent: z.string().nullable().optional() });
const SplitSchema = z.object({ id: z.string(), into: z.array(z.string().min(1)).min(1) });
const MergeSchema = z.object({ ids: z.array(z.string()).min(1), title: z.string().min(1) });
const ConcludeSchema = z.object({
  task: z.string(),
  result: z.enum(['positive', 'negative', 'inconclusive', 'mixed']),
  summary: z.string().optional(), manifest: z.string().optional(), output: z.array(z.string()).optional(),
});
const SupersedeSchema = z.object({ id: z.string(), by: z.string(), reason: z.string().optional() });
const InvalidateSchema = z.object({ id: z.string(), reason: z.string().min(1) });
const DropSchema = z.object({ id: z.string(), reason: z.string().min(1) });
const BlockSchema = z.object({ id: z.string(), on: z.array(z.string()).min(1) });
const UnblockSchema = z.object({ id: z.string() });
const ContradictSchema = z.object({ a: z.string(), b: z.string(), note: z.string().optional() });
const ResolveSchema = z.object({ a: z.string(), b: z.string(), by: z.string().optional() });
const AliasSchema = z.object({ id: z.string(), name: z.string().min(1) });
const StatusSchema = z.object({ id: z.string(), set: z.string().min(1) });
const LinkCodeSchema = z.object({ id: z.string(), path: z.string().min(1) });
const LinkOutputSchema = z.object({ id: z.string(), path: z.string().min(1), manifest: z.string().optional() });
```

- [ ] **Step 3: 写 endpoint(在 registerResearchRoutes 内部,读 endpoint 之后)**

每个 endpoint 都是同一模板。给你一个完整范本 + 后面用列表代替重复:

```ts
// 范本:add
app.post('/api/projects/:id/research/add', async (req, reply) => {
  const { id } = PARAMS.parse(req.params);
  const p = resolveProject(ctx, req, id);
  let body;
  try { body = AddSchema.parse(req.body); }
  catch (e) { reply.code(400); return { error: (e as Error).message }; }
  try {
    const node = addNode(p.path, ctx.research.store(p.path), body);
    doneWrite(ctx, p.path);
    return { ok: true, node };
  } catch (e) {
    reply.code(400); return { error: (e as Error).message };
  }
});
```

接下来的 19 个 endpoint 都用这个范本,差别只在 schema、verb 调用、返回字段。按下表实现:

| Path | Schema | 调用 | 返回 |
|------|--------|------|------|
| `/init` | `InitSchema` | `scaffoldResearchRepo(p.path, { projectName: body.name ?? p.name, force: body.force ?? false })` | `{ ok: true, report }` |
| `/add` | `AddSchema` | `addNode(p.path, store, body)` | `{ ok: true, node }` |
| `/set` | `SetSchema` | `setNode(store, body)` | `{ ok: true, node }` |
| `/link` | `LinkSchema` | `linkNodes(store, body)` | `{ ok: true, node }` |
| `/unlink` | `UnlinkSchema` | `unlinkNodes(store, body)` | `{ ok: true, node }` |
| `/contain` | `ContainSchema` | `containNode(store, { child: body.child, parent: body.parent ?? undefined })` | `{ ok: true, node }` |
| `/split` | `SplitSchema` | `splitIdea(p.path, store, body)` | `{ ok: true, nodes }` |
| `/merge` | `MergeSchema` | `mergeIdeas(p.path, store, body)` | `{ ok: true, task }` |
| `/conclude` | `ConcludeSchema` | `concludeTask(p.path, store, body)` | `{ ok: true, ...result }` |
| `/supersede` | `SupersedeSchema` | `supersedeNode(store, body)` | `{ ok: true, node }` |
| `/invalidate` | `InvalidateSchema` | `invalidateNode(store, body)` | `{ ok: true, node }` |
| `/drop` | `DropSchema` | `dropNode(store, body)` | `{ ok: true, node }` |
| `/block` | `BlockSchema` | `blockNode(store, body)` | `{ ok: true, node }` |
| `/unblock` | `UnblockSchema` | `unblockNode(store, body)` | `{ ok: true, node }` |
| `/contradict` | `ContradictSchema` | `contradictNodes(store, body)` | `{ ok: true, ...result }` |
| `/resolve` | `ResolveSchema` | `resolveContradiction(store, body)` | `{ ok: true, ...result }` |
| `/alias` | `AliasSchema` | `aliasNode(store, body)` | `{ ok: true, node }` |
| `/status` | `StatusSchema` | `setStatus(store, body)` | `{ ok: true, node }` |
| `/link-code` | `LinkCodeSchema` | `linkCode(store, body)` | `{ ok: true, node }` |
| `/link-output` | `LinkOutputSchema` | `linkOutput(store, body)` | `{ ok: true, node }` |

每个 endpoint **都要**在成功路径里调 `doneWrite(ctx, p.path)`(重建索引 + 失效缓存)。把所有 20 个 endpoint 都按范本写好。`store` 都是 `ctx.research.store(p.path)`。

- [ ] **Step 4: 测试扩 add + set + invalidate + conclude 关键路径**

在 `research.test.ts` 末尾追加:

```ts
describe('POST 写动词', () => {
  it('init → add → set → graph 含新节点', async () => {
    const { app } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);

    const init = await app.inject({ method: 'POST', url: '/api/projects/p1/research/init', payload: { name: 'Demo' } });
    expect(init.statusCode).toBe(200);

    const add = await app.inject({ method: 'POST', url: '/api/projects/p1/research/add', payload: { type: 'task', title: 'T', as: '007' } });
    expect(add.statusCode).toBe(200);
    expect(JSON.parse(add.body).node.id).toBe('task/007');

    const set = await app.inject({ method: 'POST', url: '/api/projects/p1/research/set', payload: { id: 'task/007', title: 'T 新标题' } });
    expect(JSON.parse(set.body).node.title).toBe('T 新标题');

    const graph = await app.inject({ method: 'GET', url: '/api/projects/p1/research/graph' });
    expect(JSON.parse(graph.body).nodes).toHaveLength(1);
  });
  it('add 缺 title → 400', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/research/add', payload: { type: 'task' } });
    expect(r.statusCode).toBe(400);
  });
  it('conclude 全流程 → evidence 与 produces 边', async () => {
    scaffoldResearchRepo(projectRoot, { projectName: 'Demo' });
    const { app, ctx } = await buildApp([{ id: 'p1', name: 'P', path: projectRoot, type: 'research', launchCommand: 'sh', ownerId: 'u1' }]);
    addNode(projectRoot, ctx.provider.store(projectRoot), { type: 'task', title: 'T', as: '001' });
    ctx.provider.invalidate(projectRoot);

    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/research/conclude', payload: { task: 'task/001', result: 'positive', summary: '验证通过' } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.task.status).toBe('done');
    expect(body.evidence.result).toBe('positive');
  });
});
```

**测试里 ctx 的 provider 字段名**:T2 的 ResearchProviderRegistry 接口的字段名要与测试 fake ctx 字段名一致(`provider` 或 `research`)。本计划统一**用 `ctx.research`(在 AppContext)**;但测试里的 fake ctx fixture(`makeCtx`)目前用了 `provider` 字段名,**统一改成 `research`**:

```ts
function makeCtx(projects: Project[]) {
  const research = new ResearchProviderRegistry();
  // ...
  return { research, projects: ..., requireAuth: ..., canSeeProject: ... };
}
```

并把 Step 2 测试里所有 `ctx.provider` 改成 `ctx.research`。

- [ ] **Step 5: 跑测试 + typecheck**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm test --prefix "$WT/apps/server" 2>&1 | tail -15
npx tsc -p "$WT/apps/server" --noEmit 2>&1 | tail -5
```

Expected: 全 PASS、typecheck `ok`。

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add apps/server/src/routes/research.ts apps/server/src/routes/research.test.ts
git -C "$WT" commit -m "feat(server): routes/research 20 写动词 endpoint(全部 verbs + zod 校验)"
```

---

## Task 5: 后端 smoke HTTP 端到端

**Files:**
- Create: `apps/server/scripts/smoke-research-api.ts`
- Modify: `apps/server/package.json`(加 `smoke:research` script)

- [ ] **Step 1: 写 `apps/server/scripts/smoke-research-api.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerResearchRoutes } from '../src/routes/research';
import { ResearchProviderRegistry } from '../src/lib/researchProvider';
import type { Project, AuthUser } from '@rcc/shared';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-smoke-research-'));
  const project: Project = { id: 'demo', name: 'Demo', path: root, type: 'research', launchCommand: 'sh', ownerId: 'u1' } as Project;
  const me: AuthUser = { id: 'u1', username: 'tester', role: 'admin' } as AuthUser;

  const app = Fastify({ logger: false });
  await app.register(cookie);
  const research = new ResearchProviderRegistry();
  const ctx = {
    research,
    projects: { get: (id: string) => (id === 'demo' ? project : undefined) },
    canSeeProject: () => true,
  } as any;
  app.addHook('preHandler', async (req) => { (req as any).user = me; });
  registerResearchRoutes(app, ctx);

  async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const r = await app.inject({ method, url, payload });
    process.stdout.write(`\n[${method}] ${url}\n  status: ${r.statusCode}\n  body: ${r.body.slice(0, 200)}\n`);
    if (r.statusCode !== 200) {
      process.stderr.write(`❌ ${method} ${url} -> ${r.statusCode}: ${r.body}\n`);
      process.exit(1);
    }
    return JSON.parse(r.body);
  }

  await call('POST', '/api/projects/demo/research/init', { name: 'Demo' });
  await call('GET', '/api/projects/demo/research/init-status');
  await call('POST', '/api/projects/demo/research/add', { type: 'thread', title: '错误危害方向', as: '003' });
  await call('POST', '/api/projects/demo/research/add', { type: 'task', title: '错误类型×位置矩阵', as: '007', parent: 'thread/003' });
  await call('POST', '/api/projects/demo/research/conclude', { task: 'task/007', result: 'positive', summary: '排序确认' });
  await call('POST', '/api/projects/demo/research/add', { type: 'task', title: '重测矩阵', as: '008', parent: 'thread/003' });
  await call('POST', '/api/projects/demo/research/conclude', { task: 'task/008', result: 'negative', summary: '相反结论' });
  await call('POST', '/api/projects/demo/research/contradict', { a: 'evidence/001', b: 'evidence/002', note: '设置微差' });
  await call('POST', '/api/projects/demo/research/invalidate', { id: 'evidence/002', reason: 'fi_server 配置有误' });
  await call('GET', '/api/projects/demo/research/graph');
  await call('GET', '/api/projects/demo/research/next');
  await call('GET', '/api/projects/demo/research/analyze');
  await call('GET', '/api/projects/demo/research/brief?rich=1');
  await call('GET', '/api/projects/demo/research/affected-by/evidence%2F002');

  process.stdout.write('\n✅ 呈现层 HTTP API smoke 全绿\n');
  fs.rmSync(root, { recursive: true, force: true });
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 加 npm script**

打开 `apps/server/package.json`,在 `scripts` 下加:

```json
"smoke:research": "tsx scripts/smoke-research-api.ts"
```

- [ ] **Step 3: 跑 smoke**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npm run --prefix "$WT/apps/server" smoke:research 2>&1 | tail -30
```

Expected: 末尾 `✅ 呈现层 HTTP API smoke 全绿`,所有 14 个调用 status 200。

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add apps/server/scripts/smoke-research-api.ts apps/server/package.json
git -C "$WT" commit -m "test(server): smoke-research-api 端到端跑全套读写动词"
```

---

## Task 6: 前端 researchApi(fetch 包装)

**Files:**
- Create: `apps/web/src/lib/researchApi.ts`

- [ ] **Step 1: 看现有 api.ts 模式**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
cat "$WT/apps/web/src/lib/api.ts" | head -40
```

学其 fetch / 错误处理 / 鉴权 cookie 风格。

- [ ] **Step 2: 写 `apps/web/src/lib/researchApi.ts`**

```ts
import type {
  ResearchNode, NextItem, AffectedReport, GraphStats,
  NodeType, EvidenceResult,
} from '@rcc/shared';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `GET ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `POST ${url} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const researchApi = {
  initStatus: (pid: string) => get<{ initialized: boolean; root: string }>(`/api/projects/${pid}/research/init-status`),
  graph: (pid: string) => get<{ nodes: ResearchNode[] }>(`/api/projects/${pid}/research/graph`),
  brief: (pid: string, rich = false) => get<{ text: string }>(`/api/projects/${pid}/research/brief${rich ? '?rich=1' : ''}`),
  next: (pid: string, opts?: { staleDays?: number; kinds?: string[] }) => {
    const qs = new URLSearchParams();
    if (opts?.staleDays !== undefined) qs.set('stale-days', String(opts.staleDays));
    if (opts?.kinds?.length) qs.set('kinds', opts.kinds.join(','));
    const s = qs.toString();
    return get<{ items: NextItem[] }>(`/api/projects/${pid}/research/next${s ? '?' + s : ''}`);
  },
  analyze: (pid: string) => get<{ stats: GraphStats }>(`/api/projects/${pid}/research/analyze`),
  affectedBy: (pid: string, id: string) => get<{ report: AffectedReport }>(`/api/projects/${pid}/research/affected-by/${encodeURIComponent(id)}`),
  node: (pid: string, id: string) => get<{ node: ResearchNode; inEdges: { from: string; edge: { to: string; label: string } }[] }>(`/api/projects/${pid}/research/node/${encodeURIComponent(id)}`),

  init: (pid: string, payload: { name?: string; force?: boolean }) => post<{ ok: true }>(`/api/projects/${pid}/research/init`, payload),
  add: (pid: string, payload: { type: NodeType; title: string; as?: string; parent?: string; summary?: string; expectation?: string; result?: EvidenceResult; url?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`/api/projects/${pid}/research/add`, payload),
  set: (pid: string, payload: { id: string; title?: string; summary?: string; expectation?: string; text?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`/api/projects/${pid}/research/set`, payload),
  link: (pid: string, payload: { from: string; to: string; label: string; note?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/link`, payload),
  unlink: (pid: string, payload: { from: string; to: string; label?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/unlink`, payload),
  contain: (pid: string, payload: { child: string; parent?: string | null }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/contain`, payload),
  split: (pid: string, payload: { id: string; into: string[] }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/split`, payload),
  merge: (pid: string, payload: { ids: string[]; title: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/merge`, payload),
  conclude: (pid: string, payload: { task: string; result: EvidenceResult; summary?: string; manifest?: string; output?: string[] }) =>
    post<{ ok: true; task: ResearchNode; evidence: ResearchNode }>(`/api/projects/${pid}/research/conclude`, payload),
  supersede: (pid: string, payload: { id: string; by: string; reason?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/supersede`, payload),
  invalidate: (pid: string, payload: { id: string; reason: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/invalidate`, payload),
  drop: (pid: string, payload: { id: string; reason: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/drop`, payload),
  block: (pid: string, payload: { id: string; on: string[] }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/block`, payload),
  unblock: (pid: string, payload: { id: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/unblock`, payload),
  contradict: (pid: string, payload: { a: string; b: string; note?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/contradict`, payload),
  resolve: (pid: string, payload: { a: string; b: string; by?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/resolve`, payload),
  alias: (pid: string, payload: { id: string; name: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/alias`, payload),
  status: (pid: string, payload: { id: string; set: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/status`, payload),
  linkCode: (pid: string, payload: { id: string; path: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/link-code`, payload),
  linkOutput: (pid: string, payload: { id: string; path: string; manifest?: string }) =>
    post<{ ok: true }>(`/api/projects/${pid}/research/link-output`, payload),
};
```

- [ ] **Step 3: 跑 typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

Expected: 无报错。

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add apps/web/src/lib/researchApi.ts
git -C "$WT" commit -m "feat(web): researchApi — 21 endpoint 类型安全 fetch 包装"
```

---

## Task 7: 前端共享小组件(StatusBadge / NodeCard / ThreadCard / EdgeList)

**Files:**
- Create: `apps/web/src/components/research/StatusBadge.tsx`
- Create: `apps/web/src/components/research/NodeCard.tsx`
- Create: `apps/web/src/components/research/ThreadCard.tsx`
- Create: `apps/web/src/components/research/EdgeList.tsx`

- [ ] **Step 1: StatusBadge**

```tsx
import type { ResearchNode } from '@rcc/shared';

const COLOR: Record<string, string> = {
  // thread
  open: '#3b82f6', parked: '#a3a3a3', concluded: '#10b981',
  // idea
  incubating: '#f59e0b', crystallized: '#8b5cf6', dropped: '#737373',
  // task
  todo: '#94a3b8', active: '#3b82f6', done: '#10b981',
  superseded: '#a3a3a3', invalidated: '#ef4444', blocked: '#f97316',
};
const RESULT_SYM: Record<string, string> = { positive: '+', negative: '−', inconclusive: '?', mixed: '±' };

export function StatusBadge({ node }: { node: ResearchNode }) {
  if (node.type === 'reference') {
    return <span className="status-badge" style={{ background: '#64748b' }}>ref</span>;
  }
  const color = COLOR[node.status] ?? '#64748b';
  const sym = node.type === 'evidence' ? ` ${RESULT_SYM[node.result] ?? ''}` : '';
  return (
    <span className="status-badge" style={{ background: color }}>
      {node.status}{sym}
    </span>
  );
}
```

- [ ] **Step 2: NodeCard 通用卡片**

```tsx
import type { ResearchNode } from '@rcc/shared';
import { StatusBadge } from './StatusBadge';

export function NodeCard({ node, onClick }: { node: ResearchNode; onClick?: () => void }) {
  return (
    <div className="node-card" onClick={onClick} role="button">
      <div className="node-card-head">
        <span className="node-id">{node.id}</span>
        <StatusBadge node={node} />
      </div>
      <div className="node-title">{node.title}</div>
      {node.summary && <div className="node-summary">{node.summary}</div>}
    </div>
  );
}
```

- [ ] **Step 3: ThreadCard 顶级地图用(含 rollup)**

```tsx
import type { ResearchNode, ResearchGraph } from '@rcc/shared';
import { ResearchGraph as RG } from '@rcc/research-core';
import { StatusBadge } from './StatusBadge';

const RESULT_SYM: Record<string, string> = { positive: '+', negative: '−', inconclusive: '?', mixed: '±' };

function rollup(graph: RG, threadId: string): string {
  const sub = graph.subtree(threadId).filter((n) => n.id !== threadId);
  if (sub.length === 0) return '空';
  const cnt = new Map<string, number>();
  let tens = 0;
  let latest: { at: string; result: string } | null = null;
  for (const n of sub) {
    if (n.type !== 'reference') cnt.set(n.status, (cnt.get(n.status) ?? 0) + 1);
    for (const e of n.edges) if (e.label === 'contradicts' && e.state === 'open') tens++;
    if (n.type === 'evidence' && (!latest || n.updatedAt > latest.at)) latest = { at: n.updatedAt, result: n.result };
  }
  const parts: string[] = [];
  if (cnt.size) parts.push([...cnt].map(([s, c]) => `${c} ${s}`).join(' / '));
  if (tens) parts.push(`${tens} 张力`);
  if (latest) parts.push(`最新 ${RESULT_SYM[latest.result] ?? ''}`);
  return parts.join(' · ') || '空';
}

export function ThreadCard({ node, graph, onClick }: { node: ResearchNode; graph: RG; onClick?: () => void }) {
  return (
    <div className="thread-card" onClick={onClick} role="button">
      <div className="thread-card-head">
        <span className="thread-id">{node.id}</span>
        <StatusBadge node={node} />
      </div>
      <div className="thread-title">{node.title}</div>
      <div className="thread-rollup">{rollup(graph, node.id)}</div>
    </div>
  );
}
```

注意:导入 `ResearchGraph` 直接从 `@rcc/research-core`(类型 + 实现都能用);别从 `@rcc/shared` 拿(shared 只 re-export 类型)。

- [ ] **Step 4: EdgeList(出入边)**

```tsx
import type { Edge } from '@rcc/shared';

export function EdgeList({
  outEdges, inEdges, onClickNode,
}: {
  outEdges: Edge[];
  inEdges: { from: string; edge: Edge }[];
  onClickNode: (id: string) => void;
}) {
  return (
    <div className="edge-list">
      <div className="edge-section">
        <div className="edge-section-head">出边</div>
        {outEdges.length === 0 && <div className="edge-empty">(无)</div>}
        {outEdges.map((e, i) => (
          <div key={i} className="edge-row" onClick={() => onClickNode(e.to)}>
            → {e.to} <span className="edge-label">({e.label}{e.state ? ', ' + e.state : ''}{e.note ? ': ' + e.note : ''})</span>
          </div>
        ))}
      </div>
      <div className="edge-section">
        <div className="edge-section-head">入边</div>
        {inEdges.length === 0 && <div className="edge-empty">(无)</div>}
        {inEdges.map((ie, i) => (
          <div key={i} className="edge-row" onClick={() => onClickNode(ie.from)}>
            ← {ie.from} <span className="edge-label">({ie.edge.label})</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

Expected: 无报错。

- [ ] **Step 6: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/
git -C "$WT" commit -m "feat(web): research 共享小组件(StatusBadge/NodeCard/ThreadCard/EdgeList)"
```

---

## Task 8: 前端 ResearchView 主容器 + EmptyState

**Files:**
- Create: `apps/web/src/components/research/EmptyState.tsx`
- Create: `apps/web/src/components/research/ResearchView.tsx`

- [ ] **Step 1: EmptyState**

```tsx
import { useState } from 'react';
import { researchApi } from '../../lib/researchApi';

export function EmptyState({ projectId, onInitialized }: { projectId: string; onInitialized: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="empty-state">
      <h3>研究图未初始化</h3>
      <p>这个项目还没有 research/ 目录。点击「初始化」会建立目录结构、CLAUDE.md 模板与 docs/overview.md(研究宪章)占位。</p>
      {err && <div className="empty-err">{err}</div>}
      <button className="primary" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { await researchApi.init(projectId, {}); onInitialized(); }
        catch (e) { setErr((e as Error).message); }
        finally { setBusy(false); }
      }}>
        {busy ? '初始化中…' : '初始化研究图'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: ResearchView**

```tsx
import { useEffect, useState, useCallback } from 'react';
import type { Project, ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { researchApi } from '../../lib/researchApi';
import { EmptyState } from './EmptyState';
import { MapView } from './MapView';
import { NextView } from './NextView';
import { AnalyzeView } from './AnalyzeView';
import { BriefView } from './BriefView';
import { NodeDetail } from './NodeDetail';

type SubView = 'map' | 'next' | 'analyze' | 'brief' | 'node';

export function ResearchView({ project }: { project: Project }) {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [nodes, setNodes] = useState<ResearchNode[] | null>(null);
  const [view, setView] = useState<SubView>('map');
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await researchApi.initStatus(project.id);
    setInitialized(s.initialized);
    if (s.initialized) {
      const g = await researchApi.graph(project.id);
      setNodes(g.nodes);
    } else {
      setNodes([]);
    }
  }, [project.id]);

  useEffect(() => { refresh(); }, [refresh]);

  if (initialized === null) return <div className="loading">加载中…</div>;
  if (!initialized) return <EmptyState projectId={project.id} onInitialized={refresh} />;
  if (!nodes) return <div className="loading">加载中…</div>;

  const graph = new ResearchGraph(nodes);
  const focusedNode = focusedNodeId ? graph.get(focusedNodeId) : null;

  const goNode = (id: string) => { setFocusedNodeId(id); setView('node'); };
  const back = () => setFocusedNodeId(null);

  return (
    <div className="research-view">
      <div className="research-tabs">
        {(['map', 'next', 'analyze', 'brief'] as const).map((v) => (
          <button key={v} className={`segbtn ${view === v && !focusedNode ? 'active' : ''}`}
            onClick={() => { setFocusedNodeId(null); setView(v); }}>
            {({ map: '地图', next: '待办', analyze: '体检', brief: 'Brief' })[v]}
          </button>
        ))}
      </div>
      <div className="research-content">
        {focusedNode ? (
          <NodeDetail projectId={project.id} node={focusedNode} graph={graph} onClickNode={goNode} onBack={back} onAfterWrite={refresh} />
        ) : (
          <>
            {view === 'map' && <MapView projectId={project.id} graph={graph} onClickNode={goNode} onAfterWrite={refresh} />}
            {view === 'next' && <NextView graph={graph} onClickNode={goNode} />}
            {view === 'analyze' && <AnalyzeView graph={graph} />}
            {view === 'brief' && <BriefView graph={graph} />}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

Expected: 无报错(其它子视图组件还没建,但 import 会报。先 stub 这些子视图,**或者**确保 tsc 报错只在 import 部分,跳过 step,稍后任务里实现)。

**Stub 方案**:**为让 typecheck 现在过**,先建占位文件 `apps/web/src/components/research/MapView.tsx` 等 5 个,各导出一个最小函数:

```tsx
// apps/web/src/components/research/MapView.tsx (临时 stub,T9 再填)
import type { ResearchGraph } from '@rcc/research-core';
export function MapView(_props: {
  projectId: string; graph: ResearchGraph;
  onClickNode: (id: string) => void; onAfterWrite: () => Promise<void> | void;
}) { return <div>MapView TBD</div>; }
```

同样为 `NextView` / `AnalyzeView` / `BriefView` / `NodeDetail` 各建一个临时 stub,签名一致。

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/
git -C "$WT" commit -m "feat(web): ResearchView 主容器 + EmptyState + 子视图 stub"
```

---

## Task 9: 前端 MapView(顶级地图 + thread 详情子树)

**Files:**
- Modify: `apps/web/src/components/research/MapView.tsx`(替换 stub)

- [ ] **Step 1: 实现 MapView**

```tsx
import { useState } from 'react';
import type { ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { ThreadCard } from './ThreadCard';
import { NodeCard } from './NodeCard';
import { StatusBadge } from './StatusBadge';
import { NodeOpsDrawer } from './NodeOpsDrawer';

export function MapView({
  projectId, graph, onClickNode, onAfterWrite,
}: {
  projectId: string;
  graph: ResearchGraph;
  onClickNode: (id: string) => void;
  onAfterWrite: () => Promise<void> | void;
}) {
  const [drawer, setDrawer] = useState<{ verb: 'add'; context?: { parent?: string } } | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);

  const threads = graph.listByType('thread').sort((a, b) => a.id.localeCompare(b.id));
  const focused = focusedThread ? graph.get(focusedThread) : null;

  if (focused && focused.type === 'thread') {
    const subtree = graph.subtree(focused.id).filter((n) => n.id !== focused.id);
    const byType: Record<string, ResearchNode[]> = { task: [], idea: [], evidence: [], reference: [] };
    for (const n of subtree) (byType[n.type] ?? (byType[n.type] = [])).push(n);

    return (
      <div className="thread-detail">
        <button className="back" onClick={() => setFocusedThread(null)}>‹ 返回地图</button>
        <h2>{focused.id} {focused.title}</h2>
        <StatusBadge node={focused} />
        {focused.summary && <p className="thread-summary">{focused.summary}</p>}

        {(['task', 'idea', 'evidence', 'reference'] as const).map((t) => byType[t]?.length ? (
          <section key={t}>
            <h3>{t}({byType[t]!.length})</h3>
            {byType[t]!.map((n) => (
              <NodeCard key={n.id} node={n} onClick={() => onClickNode(n.id)} />
            ))}
          </section>
        ) : null)}

        <button className="fab" onClick={() => setDrawer({ verb: 'add', context: { parent: focused.id } })}>+</button>
        {drawer && (
          <NodeOpsDrawer
            projectId={projectId}
            verb={drawer.verb}
            context={drawer.context}
            graph={graph}
            onClose={() => setDrawer(null)}
            onDone={async () => { setDrawer(null); await onAfterWrite(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="map-view">
      {threads.length === 0 && <div className="map-empty">还没有 thread。点击 + 建第一个研究方向。</div>}
      {threads.map((t) => (
        <ThreadCard key={t.id} node={t} graph={graph} onClick={() => setFocusedThread(t.id)} />
      ))}
      <button className="fab" onClick={() => setDrawer({ verb: 'add' })}>+</button>
      {drawer && (
        <NodeOpsDrawer
          projectId={projectId}
          verb={drawer.verb}
          context={drawer.context}
          graph={graph}
          onClose={() => setDrawer(null)}
          onDone={async () => { setDrawer(null); await onAfterWrite(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

可能报 `NodeOpsDrawer` 未定义(T12 实现)。先给它一个 stub:

```tsx
// apps/web/src/components/research/NodeOpsDrawer.tsx (stub,T12 实现)
import type { ResearchGraph } from '@rcc/research-core';
export function NodeOpsDrawer(_props: {
  projectId: string; verb: string; context?: any;
  graph: ResearchGraph;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) { return null; }
```

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/MapView.tsx apps/web/src/components/research/NodeOpsDrawer.tsx
git -C "$WT" commit -m "feat(web): MapView — 顶级 thread 地图 + thread 详情子树展开"
```

---

## Task 10: 前端 NextView / AnalyzeView / BriefView

**Files:**
- Modify: `apps/web/src/components/research/NextView.tsx`(替换 stub)
- Modify: `apps/web/src/components/research/AnalyzeView.tsx`
- Modify: `apps/web/src/components/research/BriefView.tsx`

- [ ] **Step 1: NextView**

```tsx
import { useState } from 'react';
import type { NextItem } from '@rcc/shared';
import { ResearchGraph, nextAll } from '@rcc/research-core';

const KIND_LABEL: Record<NextItem['kind'] | 'all', string> = {
  all: '全部',
  'open-task': '待办 task',
  tension: '张力',
  stale: '受拖累',
  orphan: '孤儿',
  'stagnant-thread': '停滞',
};

export function NextView({ graph, onClickNode }: { graph: ResearchGraph; onClickNode: (id: string) => void }) {
  const [kind, setKind] = useState<NextItem['kind'] | 'all'>('all');
  const items = nextAll(graph, kind === 'all' ? {} : { kinds: [kind] });

  return (
    <div className="next-view">
      <div className="kind-chips">
        {(Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((k) => (
          <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {items.length === 0 && <div className="next-empty">(没有该维度的待办)</div>}
      {items.map((it, i) => (
        <div key={i} className="next-row" onClick={() => onClickNode(it.id)}>
          <span className={`kind-tag k-${it.kind}`}>{KIND_LABEL[it.kind]}</span>
          <span className="next-id">{it.id}</span>
          <span className="next-title">{it.title}</span>
          <div className="next-reason">→ {it.reason}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: AnalyzeView**

```tsx
import { ResearchGraph, analyzeGraph } from '@rcc/research-core';

function Bar({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bar-value">{value}</span>
    </div>
  );
}

export function AnalyzeView({ graph }: { graph: ResearchGraph }) {
  const s = analyzeGraph(graph);
  return (
    <div className="analyze-view">
      <div className="analyze-totals">
        节点 <b>{s.totals.nodes}</b> · 边 <b>{s.totals.edges}</b> · contains 树 <b>{s.totals.containsTrees}</b>
      </div>

      <section><h3>类型分布</h3>
        {Object.entries(s.byType).map(([t, c]) => (
          <Bar key={t} label={t} value={c} total={s.totals.nodes} />
        ))}
      </section>

      <section><h3>状态分布</h3>
        {Object.entries(s.byStatus).map(([st, c]) => (
          <Bar key={st} label={st} value={c} total={Object.values(s.byStatus).reduce((a, b) => a + b, 0)} />
        ))}
      </section>

      <section><h3>问题清单</h3>
        <div className="issue-row"><b>孤儿:</b> {s.orphans.length === 0 ? '(无)' : s.orphans.join(', ')}</div>
        <div className="issue-row"><b>断链:</b> {s.dangling.length === 0 ? '(无)' : s.dangling.join(', ')}</div>
        <div className="issue-row"><b>未解张力对:</b> {s.openTensions}</div>
        <div className="issue-row"><b>停滞方向:</b> {s.stagnantThreads.length === 0 ? '(无)' : s.stagnantThreads.join(', ')}</div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: BriefView**

```tsx
import { useState } from 'react';
import { ResearchGraph, renderBrief, renderBriefRich } from '@rcc/research-core';

export function BriefView({ graph }: { graph: ResearchGraph }) {
  const [rich, setRich] = useState(true);
  const text = rich ? renderBriefRich(graph) : renderBrief(graph);
  return (
    <div className="brief-view">
      <div className="brief-toggle">
        <button className={`segbtn ${!rich ? 'active' : ''}`} onClick={() => setRich(false)}>最简</button>
        <button className={`segbtn ${rich ? 'active' : ''}`} onClick={() => setRich(true)}>富版</button>
      </div>
      <pre className="brief-text">{text || '(图为空)'}</pre>
    </div>
  );
}
```

- [ ] **Step 4: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

Expected: 无报错。

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/NextView.tsx apps/web/src/components/research/AnalyzeView.tsx apps/web/src/components/research/BriefView.tsx
git -C "$WT" commit -m "feat(web): NextView/AnalyzeView/BriefView — 三个派生视图"
```

---

## Task 11: 前端 NodeDetail(节点详情页)

**Files:**
- Modify: `apps/web/src/components/research/NodeDetail.tsx`(替换 stub)

- [ ] **Step 1: 实现 NodeDetail**

```tsx
import { useState } from 'react';
import type { ResearchNode } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { StatusBadge } from './StatusBadge';
import { EdgeList } from './EdgeList';
import { NodeOpsDrawer } from './NodeOpsDrawer';

type Verb = 'set' | 'link' | 'status' | 'conclude' | 'supersede' | 'invalidate'
  | 'drop' | 'block' | 'unblock' | 'contradict' | 'resolve' | 'alias'
  | 'split' | 'merge' | 'link-code' | 'link-output' | 'contain' | 'unlink';

function verbsFor(node: ResearchNode): Verb[] {
  const base: Verb[] = ['set', 'link', 'unlink', 'status', 'contain', 'alias', 'invalidate', 'drop', 'supersede', 'contradict', 'resolve'];
  if (node.type === 'task') return [...base, 'conclude', 'block', 'unblock', 'link-code'];
  if (node.type === 'evidence') return [...base, 'block', 'unblock', 'link-output'];
  if (node.type === 'idea') return [...base, 'split', 'merge'];
  return base;
}

export function NodeDetail({
  projectId, node, graph, onClickNode, onBack, onAfterWrite,
}: {
  projectId: string;
  node: ResearchNode;
  graph: ResearchGraph;
  onClickNode: (id: string) => void;
  onBack: () => void;
  onAfterWrite: () => Promise<void> | void;
}) {
  const [drawer, setDrawer] = useState<{ verb: Verb } | null>(null);
  const verbs = verbsFor(node);
  const inEdges = graph.inEdges(node.id);

  return (
    <div className="node-detail">
      <button className="back" onClick={onBack}>‹ 返回</button>
      <h2>{node.id} {node.title}</h2>
      <StatusBadge node={node} />
      {node.summary && <p className="node-summary-full">{node.summary}</p>}
      {node.type === 'task' && node.expectation && <p className="node-expectation"><b>预期:</b> {node.expectation}</p>}
      {node.kind.length > 0 && <div className="kind-tags">{node.kind.map((k) => <span key={k} className="kind-tag-pill">{k}</span>)}</div>}
      {node.aliases.length > 0 && <div className="aliases">别名: {node.aliases.join(', ')}</div>}
      {node.text && <a className="text-link" href={`#fs:${node.text}`}>查看散文 →</a>}

      <EdgeList outEdges={node.edges} inEdges={inEdges} onClickNode={onClickNode} />

      <div className="node-ops">
        {verbs.map((v) => (
          <button key={v} className="op-btn" onClick={() => setDrawer({ verb: v })}>{v}</button>
        ))}
      </div>

      {drawer && (
        <NodeOpsDrawer
          projectId={projectId}
          verb={drawer.verb}
          context={{ subject: node.id }}
          graph={graph}
          onClose={() => setDrawer(null)}
          onDone={async () => { setDrawer(null); await onAfterWrite(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
```

Expected: 无报错(`NodeOpsDrawer` stub 还在,接受 context.subject)。

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/NodeDetail.tsx
git -C "$WT" commit -m "feat(web): NodeDetail — 节点详情页(字段/出入边/操作菜单)"
```

---

## Task 12: 前端 NodeOpsDrawer(动词表单)

**Files:**
- Modify: `apps/web/src/components/research/NodeOpsDrawer.tsx`(替换 stub)

- [ ] **Step 1: 实现 NodeOpsDrawer**

```tsx
import { useState } from 'react';
import type { ResearchNode, NodeType, EvidenceResult } from '@rcc/shared';
import { ResearchGraph } from '@rcc/research-core';
import { researchApi } from '../../lib/researchApi';

type Verb =
  | 'add' | 'set' | 'link' | 'unlink' | 'contain' | 'split' | 'merge'
  | 'conclude' | 'supersede' | 'invalidate' | 'drop' | 'block' | 'unblock'
  | 'contradict' | 'resolve' | 'alias' | 'status' | 'link-code' | 'link-output';

interface Ctx {
  subject?: string; // 当前节点 id(供需要的动词)
  parent?: string;  // add 时的 parent
}

const TYPE_OPTIONS: NodeType[] = ['thread', 'idea', 'task', 'evidence', 'reference'];
const RESULT_OPTIONS: EvidenceResult[] = ['positive', 'negative', 'inconclusive', 'mixed'];

function statusOptions(node: ResearchNode | undefined): string[] {
  if (!node) return [];
  if (node.type === 'thread') return ['open', 'parked', 'concluded'];
  if (node.type === 'idea') return ['incubating', 'parked', 'crystallized', 'dropped'];
  if (node.type === 'task') return ['todo', 'active', 'done', 'superseded', 'invalidated', 'dropped', 'blocked'];
  if (node.type === 'evidence') return ['active', 'superseded', 'invalidated'];
  return [];
}

export function NodeOpsDrawer({
  projectId, verb, context, graph, onClose, onDone,
}: {
  projectId: string;
  verb: Verb;
  context?: Ctx;
  graph: ResearchGraph;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const subject = context?.subject;
  const subjectNode = subject ? graph.get(subject) : undefined;

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      await dispatch();
      await onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function dispatch() {
    const pid = projectId;
    switch (verb) {
      case 'add':
        await researchApi.add(pid, {
          type: (form.type as NodeType) || 'task',
          title: form.title || '',
          as: form.as || undefined,
          parent: form.parent || context?.parent || undefined,
          summary: form.summary || undefined,
          expectation: form.expectation || undefined,
          result: (form.result as EvidenceResult) || undefined,
        }); return;
      case 'set':
        await researchApi.set(pid, { id: subject!, title: form.title || undefined, summary: form.summary || undefined, expectation: form.expectation || undefined, text: form.text || undefined }); return;
      case 'link':
        await researchApi.link(pid, { from: subject!, to: form.to, label: form.label || 'related-to', note: form.note || undefined }); return;
      case 'unlink':
        await researchApi.unlink(pid, { from: subject!, to: form.to, label: form.label || undefined }); return;
      case 'contain':
        await researchApi.contain(pid, { child: subject!, parent: form.parent || null }); return;
      case 'split':
        await researchApi.split(pid, { id: subject!, into: (form.into ?? '').split(',').map((x) => x.trim()).filter(Boolean) }); return;
      case 'merge':
        await researchApi.merge(pid, { ids: (form.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean), title: form.title }); return;
      case 'conclude':
        await researchApi.conclude(pid, { task: subject!, result: form.result as EvidenceResult, summary: form.summary || undefined, manifest: form.manifest || undefined, output: form.output ? form.output.split(',').map((x) => x.trim()) : undefined }); return;
      case 'supersede':
        await researchApi.supersede(pid, { id: subject!, by: form.by, reason: form.reason || undefined }); return;
      case 'invalidate':
        await researchApi.invalidate(pid, { id: subject!, reason: form.reason }); return;
      case 'drop':
        await researchApi.drop(pid, { id: subject!, reason: form.reason }); return;
      case 'block':
        await researchApi.block(pid, { id: subject!, on: form.on.split(',').map((x) => x.trim()).filter(Boolean) }); return;
      case 'unblock':
        await researchApi.unblock(pid, { id: subject! }); return;
      case 'contradict':
        await researchApi.contradict(pid, { a: subject!, b: form.b, note: form.note || undefined }); return;
      case 'resolve':
        await researchApi.resolve(pid, { a: subject!, b: form.b, by: form.by || undefined }); return;
      case 'alias':
        await researchApi.alias(pid, { id: subject!, name: form.name }); return;
      case 'status':
        await researchApi.status(pid, { id: subject!, set: form.set }); return;
      case 'link-code':
        await researchApi.linkCode(pid, { id: subject!, path: form.path }); return;
      case 'link-output':
        await researchApi.linkOutput(pid, { id: subject!, path: form.path, manifest: form.manifest || undefined }); return;
    }
  }

  const fields: JSX.Element[] = [];
  switch (verb) {
    case 'add':
      fields.push(
        <label key="t">type
          <select value={form.type || 'task'} onChange={(e) => set('type', e.target.value)}>
            {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>,
        <label key="title">title<input value={form.title || ''} onChange={(e) => set('title', e.target.value)} /></label>,
        <label key="as">as(可选编号 / citekey)<input value={form.as || ''} onChange={(e) => set('as', e.target.value)} /></label>,
        <label key="parent">parent(可选)<input value={form.parent || context?.parent || ''} onChange={(e) => set('parent', e.target.value)} /></label>,
        <label key="summary">summary(可选)<input value={form.summary || ''} onChange={(e) => set('summary', e.target.value)} /></label>,
      );
      if (form.type === 'task') fields.push(<label key="exp">expectation<input value={form.expectation || ''} onChange={(e) => set('expectation', e.target.value)} /></label>);
      if (form.type === 'evidence') fields.push(
        <label key="res">result
          <select value={form.result || 'positive'} onChange={(e) => set('result', e.target.value)}>
            {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>,
      );
      break;
    case 'set':
      fields.push(
        <label key="t">title<input value={form.title || ''} onChange={(e) => set('title', e.target.value)} placeholder={subjectNode?.title} /></label>,
        <label key="s">summary<input value={form.summary || ''} onChange={(e) => set('summary', e.target.value)} placeholder={subjectNode?.summary} /></label>,
        <label key="x">text 路径<input value={form.text || ''} onChange={(e) => set('text', e.target.value)} placeholder={subjectNode?.text} /></label>,
      );
      if (subjectNode?.type === 'task') {
        fields.push(<label key="e">expectation<input value={form.expectation || ''} onChange={(e) => set('expectation', e.target.value)} placeholder={subjectNode.expectation} /></label>);
      }
      break;
    case 'link':
      fields.push(
        <label key="to">to<input value={form.to || ''} onChange={(e) => set('to', e.target.value)} placeholder="task/007" /></label>,
        <label key="label">label<input value={form.label || ''} onChange={(e) => set('label', e.target.value)} placeholder="depends-on / supports / refutes ..." /></label>,
        <label key="note">note(可选,这俩为什么有联系)<input value={form.note || ''} onChange={(e) => set('note', e.target.value)} /></label>,
      );
      break;
    case 'unlink':
      fields.push(
        <label key="to">to<input value={form.to || ''} onChange={(e) => set('to', e.target.value)} /></label>,
        <label key="label">label(可选,不填删全部到 to 的边)<input value={form.label || ''} onChange={(e) => set('label', e.target.value)} /></label>,
      );
      break;
    case 'contain':
      fields.push(
        <label key="p">parent(留空 = 解绑)<input value={form.parent || ''} onChange={(e) => set('parent', e.target.value)} placeholder={subjectNode?.parent} /></label>,
      );
      break;
    case 'split':
      fields.push(<label key="into">into(逗号分隔的子 idea 标题)<input value={form.into || ''} onChange={(e) => set('into', e.target.value)} placeholder="想法A, 想法B" /></label>);
      break;
    case 'merge':
      fields.push(
        <label key="ids">ids(逗号分隔的 idea id;含本节点)<input value={form.ids || (subject ?? '')} onChange={(e) => set('ids', e.target.value)} /></label>,
        <label key="title">合成的 task title<input value={form.title || ''} onChange={(e) => set('title', e.target.value)} /></label>,
      );
      break;
    case 'conclude':
      fields.push(
        <label key="r">result<select value={form.result || 'positive'} onChange={(e) => set('result', e.target.value)}>{RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>,
        <label key="s">一句话结论<input value={form.summary || ''} onChange={(e) => set('summary', e.target.value)} /></label>,
        <label key="m">manifest(可选 MANIFEST.json 路径)<input value={form.manifest || ''} onChange={(e) => set('manifest', e.target.value)} /></label>,
        <label key="o">output(可选,逗号分隔)<input value={form.output || ''} onChange={(e) => set('output', e.target.value)} /></label>,
      );
      break;
    case 'supersede':
      fields.push(
        <label key="by">by(新节点 id)<input value={form.by || ''} onChange={(e) => set('by', e.target.value)} placeholder="task/024" /></label>,
        <label key="r">reason(可选,为什么取代)<input value={form.reason || ''} onChange={(e) => set('reason', e.target.value)} /></label>,
      );
      break;
    case 'invalidate':
    case 'drop':
      fields.push(<label key="r">reason<input value={form.reason || ''} onChange={(e) => set('reason', e.target.value)} /></label>);
      break;
    case 'block':
      fields.push(<label key="on">on(逗号分隔被卡的 id)<input value={form.on || ''} onChange={(e) => set('on', e.target.value)} placeholder="task/006, task/007" /></label>);
      break;
    case 'unblock':
      fields.push(<div key="info">无需字段;点确定即解除阻塞,status 回 active。</div>);
      break;
    case 'contradict':
      fields.push(
        <label key="b">b(另一节点 id)<input value={form.b || ''} onChange={(e) => set('b', e.target.value)} /></label>,
        <label key="n">note(可选)<input value={form.note || ''} onChange={(e) => set('note', e.target.value)} /></label>,
      );
      break;
    case 'resolve':
      fields.push(
        <label key="b">b(另一节点 id)<input value={form.b || ''} onChange={(e) => set('b', e.target.value)} /></label>,
        <label key="by">by(可选,做出隔离实验的 task id)<input value={form.by || ''} onChange={(e) => set('by', e.target.value)} /></label>,
      );
      break;
    case 'alias':
      fields.push(<label key="n">name<input value={form.name || ''} onChange={(e) => set('name', e.target.value)} /></label>);
      break;
    case 'status': {
      const opts = statusOptions(subjectNode);
      fields.push(
        <label key="s">set
          <select value={form.set || opts[0]} onChange={(e) => set('set', e.target.value)}>
            {opts.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>,
      );
      break;
    }
    case 'link-code':
      fields.push(<label key="p">path(代码目录路径)<input value={form.path || ''} onChange={(e) => set('path', e.target.value)} placeholder="experiments/007_xxx" /></label>);
      break;
    case 'link-output':
      fields.push(
        <label key="p">path(产物路径)<input value={form.path || ''} onChange={(e) => set('path', e.target.value)} placeholder="output/007_xxx" /></label>,
        <label key="m">manifest(可选)<input value={form.manifest || ''} onChange={(e) => set('manifest', e.target.value)} /></label>,
      );
      break;
  }

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="drawer-verb">{verb}</span>
          {subject && <span className="drawer-subject">{subject}</span>}
        </div>
        <div className="drawer-body">{fields}</div>
        {err && <div className="drawer-err">{err}</div>}
        <div className="drawer-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={submit}>{busy ? '提交中…' : '确定'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -10
```

Expected: 无报错。

- [ ] **Step 3: 跑前端 build 验证**

```bash
npm run --prefix "$WT/apps/web" build 2>&1 | tail -10
```

Expected: 编译成功,有 dist 输出。

- [ ] **Step 4: Commit**

```bash
git -C "$WT" add apps/web/src/components/research/NodeOpsDrawer.tsx
git -C "$WT" commit -m "feat(web): NodeOpsDrawer — 20 动词 bottom sheet 表单(zod 校验由后端把关)"
```

---

## Task 13: ProjectDetail 接入 + 真实集成验证

**Files:**
- Modify: `apps/web/src/components/ProjectDetail.tsx`
- Modify: `apps/web/src/index.css`(可选,加 research 视图样式)

- [ ] **Step 1: 改 ProjectDetail.tsx 接入 research tab**

打开 `apps/web/src/components/ProjectDetail.tsx`,做两处修改:

(a) 在 `tabs.push({ key: 'tasks', ... })` **之后**追加(只对 research 项目):

```tsx
if (project.type === 'research') tabs.push({ key: 'research', label: '研究' });
```

(b) 在内容区 `{tab === 'tasks' && <TaskEvidenceBoard project={project} />}` **之后**追加:

```tsx
{tab === 'research' && <ResearchView project={project} />}
```

并在文件顶部加 import:

```tsx
import { ResearchView } from './research/ResearchView';
```

- [ ] **Step 2: 在 index.css 末尾加最小样式(让网页可读;不调精美)**

```css
/* research */
.research-tabs { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid #e5e5e5; position: sticky; top: 0; background: #fff; z-index: 10; }
.segbtn { padding: 6px 10px; border: 1px solid #d4d4d8; background: #f5f5f5; border-radius: 6px; }
.segbtn.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.research-content { padding: 12px; padding-bottom: 80px; }

.empty-state { padding: 24px; text-align: center; }
.empty-state .primary { padding: 10px 18px; background: #3b82f6; color: #fff; border: none; border-radius: 8px; }
.empty-err { color: #ef4444; margin: 8px 0; }

.thread-card, .node-card { padding: 12px; margin-bottom: 10px; background: #fff; border: 1px solid #e5e5e5; border-radius: 8px; }
.thread-card-head, .node-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.thread-id, .node-id { font-size: 12px; color: #737373; font-family: monospace; }
.thread-title, .node-title { font-weight: 500; }
.thread-rollup, .node-summary { font-size: 12px; color: #737373; margin-top: 4px; }
.status-badge { padding: 2px 8px; border-radius: 10px; color: #fff; font-size: 11px; font-weight: 500; }

.fab { position: fixed; right: 16px; bottom: 80px; width: 56px; height: 56px; border-radius: 28px; background: #3b82f6; color: #fff; border: none; font-size: 28px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.back { background: none; border: none; color: #3b82f6; font-size: 16px; padding: 4px 0; margin-bottom: 8px; }

.next-row { padding: 10px; margin-bottom: 8px; background: #fff; border-radius: 6px; border: 1px solid #e5e5e5; }
.next-reason { font-size: 12px; color: #737373; margin-top: 4px; }
.kind-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 6px; color: #fff; background: #94a3b8; }
.k-open-task { background: #3b82f6; }
.k-tension { background: #ef4444; }
.k-stale { background: #f97316; }
.k-orphan { background: #f59e0b; }
.k-stagnant-thread { background: #94a3b8; }
.kind-chips { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.chip { padding: 4px 10px; border-radius: 10px; border: 1px solid #d4d4d8; background: #f5f5f5; font-size: 12px; }
.chip.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }

.bar-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.bar-label { width: 80px; font-size: 12px; }
.bar-track { flex: 1; height: 12px; background: #e5e5e5; border-radius: 6px; overflow: hidden; }
.bar-fill { height: 100%; background: #3b82f6; }
.bar-value { width: 32px; text-align: right; font-size: 12px; }

.brief-text { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; }

.edge-list { margin-top: 16px; }
.edge-section { margin-bottom: 12px; }
.edge-section-head { font-weight: 500; margin-bottom: 4px; }
.edge-row { padding: 6px; cursor: pointer; }
.edge-row:hover { background: #f5f5f5; }
.edge-label { color: #737373; font-size: 12px; }

.node-ops { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 16px; }
.op-btn { padding: 6px 10px; background: #f5f5f5; border: 1px solid #d4d4d8; border-radius: 6px; font-size: 12px; }
.kind-tag-pill { padding: 2px 8px; background: #e5e5e5; border-radius: 10px; font-size: 11px; margin-right: 4px; }

.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: flex-end; z-index: 100; }
.drawer { background: #fff; width: 100%; max-height: 80vh; border-radius: 16px 16px 0 0; padding: 16px; overflow-y: auto; }
.drawer-head { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-weight: 500; }
.drawer-verb { padding: 2px 8px; background: #3b82f6; color: #fff; border-radius: 4px; }
.drawer-body label { display: block; margin-bottom: 10px; font-size: 13px; }
.drawer-body input, .drawer-body select { width: 100%; padding: 8px; border: 1px solid #d4d4d8; border-radius: 6px; font-size: 14px; }
.drawer-err { color: #ef4444; margin: 8px 0; }
.drawer-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.drawer-foot button { padding: 8px 16px; border-radius: 6px; border: 1px solid #d4d4d8; background: #fff; }
.drawer-foot .primary { background: #3b82f6; color: #fff; border-color: #3b82f6; }
```

- [ ] **Step 3: 全套 typecheck + build + 后端测试 + smoke**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
npx tsc -p "$WT/apps/web" --noEmit 2>&1 | tail -5
npm run --prefix "$WT/apps/web" build 2>&1 | tail -8
npm test --prefix "$WT/apps/server" 2>&1 | tail -10
npm run --prefix "$WT/apps/server" smoke:research 2>&1 | tail -5
```

Expected: typecheck `ok`、build dist 输出、server 全测 PASS、smoke 全绿。

- [ ] **Step 4: 启动整服务真实验证**

```bash
WT=/path/to/remote-cc/.worktrees/research-presentation
cd "$WT" && ./start.sh
# 等输出 listening on...
```

然后:
1. 浏览器开 `http://127.0.0.1:6325`(或 .env 里 PORT)
2. 登录
3. 进 sample-finetune 项目(或任何 type='research' 项目)
4. 点「研究」tab
5. 若 research/ 未 init,点「初始化」
6. 加 thread(用浮 FAB)
7. 加 task(点 thread 进详情,再点 +)
8. 进节点详情,试改 status / conclude / contradict
9. 切「待办」、「体检」、「Brief」三个子视图,看派生输出

- [ ] **Step 5: Commit**

```bash
git -C "$WT" add apps/web/src/components/ProjectDetail.tsx apps/web/src/index.css
git -C "$WT" commit -m "feat(web): ProjectDetail 接 'research' tab + 最小样式;真实集成可用"
```

---

## 自审清单(完成时勾)

- ✅ spec §3 后端架构 → T2 (provider) + T3 读 + T4 写 + T5 smoke
- ✅ spec §4 前端架构 → T6 (api) + T7 (小组件) + T8 (主容器) + T9 (Map) + T10 (派生) + T11 (NodeDetail) + T12 (Drawer)
- ✅ spec §4.1 ProjectTab 加 'research' → T1
- ✅ spec §4.2 类型 re-export → T1
- ✅ spec §5 错误处理 → T4 catch + T6 throw + T8/T12 UI 显示
- ✅ spec §6 测试 → T2/T3/T4 单测 + T5 smoke + T13 真实集成
- ✅ spec §2 「不删除现有功能」→ T13 加 'research' tab 保留 'tasks'
- ✅ 无 placeholder;类型/方法名跨任务一致
- ✅ 每个任务 commit 后状态稳定可测
