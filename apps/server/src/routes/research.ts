import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';
import {
  affectedBy,
  nextAll,
  analyzeGraph,
  renderBriefRich,
  renderBrief,
  scaffoldResearchRepo,
  rebuildIndex,
  addNode,
  setNode,
  linkNodes,
  unlinkNodes,
  containNode,
  aliasNode,
  splitIdea,
  mergeIdeas,
  concludeTask,
  supersedeNode,
  invalidateNode,
  dropNode,
  blockNode,
  unblockNode,
  setStatus,
  contradictNodes,
  resolveContradiction,
  linkCode,
  linkOutput,
  parseLegacyDocs,
  importLegacy,
} from '@rcc/research-core';

const PARAMS = z.object({ id: z.string() });

/**
 * 科研项目呈现层后端 endpoint:7 个读 + 20 个写。
 * 校验项目可见性后,经 ctx.research(惰性 NodeStore + 缓存 ResearchGraph)提取数据;
 * 每个写 endpoint 完成后 rebuildIndex + invalidate 缓存。
 */
export async function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  // 取项目并校验可见;不可见与不存在一样返回 null → 调用方 404。
  const resolve = (req: FastifyRequest) => {
    const { id } = PARAMS.parse(req.params);
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) return null;
    return project;
  };

  // GET /api/projects/:id/research/init-status
  app.get('/api/projects/:id/research/init-status', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { initialized: ctx.research.initialized(p.path), root: p.path };
  });

  // GET /api/projects/:id/research/graph
  app.get('/api/projects/:id/research/graph', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { nodes: ctx.research.store(p.path).list() };
  });

  // GET /api/projects/:id/research/brief?rich=1&max-bytes=N
  app.get('/api/projects/:id/research/brief', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const q = req.query as Record<string, string | undefined>;
    const rich = q.rich === '1';
    const max = q['max-bytes'];
    const graph = ctx.research.graph(p.path);
    const text = rich
      ? renderBriefRich(graph, max ? parseInt(max, 10) : undefined)
      : renderBrief(graph);
    return { text };
  });

  // GET /api/projects/:id/research/next?stale-days=N&kinds=k1,k2
  app.get('/api/projects/:id/research/next', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const q = req.query as Record<string, string | undefined>;
    const items = nextAll(ctx.research.graph(p.path), {
      staleDays: q['stale-days'] ? parseInt(q['stale-days']!, 10) : undefined,
      kinds: q.kinds ? (q.kinds.split(',').filter(Boolean) as never) : undefined,
    });
    return { items };
  });

  // GET /api/projects/:id/research/analyze
  app.get('/api/projects/:id/research/analyze', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { stats: analyzeGraph(ctx.research.graph(p.path)) };
  });

  // GET /api/projects/:id/research/affected-by/* (节点 id 含 / 故用 wildcard)
  app.get('/api/projects/:id/research/affected-by/*', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const nodeId = decodeURIComponent((req.params as { '*': string })['*']);
    return { report: affectedBy(ctx.research.graph(p.path), nodeId) };
  });

  // GET /api/projects/:id/research/node/* (节点详情)
  app.get('/api/projects/:id/research/node/*', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const nodeId = decodeURIComponent((req.params as { '*': string })['*']);
    const graph = ctx.research.graph(p.path);
    const node = graph.get(nodeId);
    if (!node) return reply.code(404).send({ error: 'node not found' });
    return { node, inEdges: graph.inEdges(nodeId) };
  });

  // GET /api/projects/:id/research/text/* (读 research/text/<id>.md 散文版,可选)
  // wildcard 是节点 id(可能含 /),拼成 research/text/<type>/<slug>.md;严格校验路径不逃逸 research/text。
  app.get('/api/projects/:id/research/text/*', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const nodeId = decodeURIComponent((req.params as { '*': string })['*']);
    const graph = ctx.research.graph(p.path);
    const node = graph.get(nodeId);
    if (!node) return reply.code(404).send({ error: 'node not found' });

    // 优先用节点显式的 text 字段(由 rlab set --text 设置);否则约定 research/text/<id>.md
    const relPath = node.text ?? `research/text/${nodeId}.md`;
    const safeRoot = path.resolve(p.path, 'research', 'text');
    const abs = path.resolve(p.path, relPath);
    if (!abs.startsWith(safeRoot + path.sep) && abs !== safeRoot) {
      return reply.code(400).send({ error: 'text path escapes research/text' });
    }
    try {
      const content = await fs.promises.readFile(abs, 'utf8');
      return { exists: true, path: relPath, content };
    } catch {
      return { exists: false, path: relPath, content: null };
    }
  });

  // ============ 写 endpoint zod schemas ============
  // 注:具体的标题长度上限由 ResearchNodeSchema 在写盘前再校验一次(非 ref ≤ 80, ref ≤ 120)。
  // 这里入参放宽到 120 让 reference 也能进,真正的类型相关上限在 schema 层。
  const InitSchema = z.object({ name: z.string().optional(), force: z.boolean().optional() });
  const AddSchema = z.object({
    type: z.enum(['thread', 'idea', 'task', 'evidence', 'reference']),
    title: z.string().min(1).max(120),
    as: z.string().optional(),
    parent: z.string().optional(),
    summary: z.string().optional(),
    expectation: z.string().optional(),
    result: z.enum(['positive', 'negative', 'inconclusive', 'mixed']).optional(),
    url: z.string().optional(),
  });
  const SetSchema = z.object({
    id: z.string(),
    title: z.string().max(120).optional(),
    summary: z.string().optional(),
    expectation: z.string().optional(),
    text: z.string().optional(),
  });
  const LinkSchema = z.object({ from: z.string(), to: z.string(), label: z.string().min(1), note: z.string().optional() });
  const UnlinkSchema = z.object({ from: z.string(), to: z.string(), label: z.string().optional() });
  const ContainSchema = z.object({ child: z.string(), parent: z.string().nullable().optional() });
  const SplitSchema = z.object({ id: z.string(), into: z.array(z.string().min(1)).min(1) });
  const MergeSchema = z.object({ ids: z.array(z.string()).min(1), title: z.string().min(1) });
  const ConcludeSchema = z.object({
    task: z.string(),
    result: z.enum(['positive', 'negative', 'inconclusive', 'mixed']),
    summary: z.string().optional(),
    manifest: z.string().optional(),
    output: z.array(z.string()).optional(),
  });
  const SupersedeSchema = z.object({ id: z.string(), by: z.string(), reason: z.string().optional() });
  const ReasonSchema = z.object({ id: z.string(), reason: z.string().min(1) });
  const BlockSchema = z.object({ id: z.string(), on: z.array(z.string()).min(1) });
  const IdSchema = z.object({ id: z.string() });
  const ContradictSchema = z.object({ a: z.string(), b: z.string(), note: z.string().optional() });
  const ResolveSchema = z.object({ a: z.string(), b: z.string(), by: z.string().optional() });
  const AliasSchema = z.object({ id: z.string(), name: z.string().min(1) });
  const StatusSchema = z.object({ id: z.string(), set: z.string().min(1) });
  const LinkPathSchema = z.object({ id: z.string(), path: z.string().min(1), manifest: z.string().optional() });

  // 写后失效 + 重建索引
  const done = (projectPath: string) => {
    rebuildIndex(projectPath, ctx.research.store(projectPath));
    ctx.research.invalidate(projectPath);
  };

  app.post('/api/projects/:id/research/init', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = InitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const report = scaffoldResearchRepo(p.path, {
        projectName: parsed.data.name ?? p.name,
        force: parsed.data.force ?? false,
      });
      done(p.path);
      return { ok: true, report };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/add', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = AddSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = addNode(p.path, store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/set', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = SetSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = setNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/link', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = LinkSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = linkNodes(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/unlink', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = UnlinkSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = unlinkNodes(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/contain', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ContainSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = containNode(store, { child: parsed.data.child, parent: parsed.data.parent ?? undefined });
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/split', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = SplitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const nodes = splitIdea(p.path, store, parsed.data);
      done(p.path);
      return { ok: true, nodes };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/merge', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = MergeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const task = mergeIdeas(p.path, store, parsed.data);
      done(p.path);
      return { ok: true, task };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/conclude', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ConcludeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const result = concludeTask(p.path, store, parsed.data);
      done(p.path);
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/supersede', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = SupersedeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = supersedeNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/invalidate', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = invalidateNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/drop', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ReasonSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = dropNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/block', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = BlockSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = blockNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/unblock', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = IdSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = unblockNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/contradict', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ContradictSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const result = contradictNodes(store, parsed.data);
      done(p.path);
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/resolve', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const result = resolveContradiction(store, parsed.data);
      done(p.path);
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/alias', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = AliasSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = aliasNode(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/status', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = StatusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = setStatus(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/link-code', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = LinkPathSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = linkCode(store, { id: parsed.data.id, path: parsed.data.path });
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post('/api/projects/:id/research/link-output', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = LinkPathSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = ctx.research.store(p.path);
      const node = linkOutput(store, parsed.data);
      done(p.path);
      return { ok: true, node };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // POST /api/projects/:id/research/import-legacy
  const ImportLegacySchema = z.object({ docsDir: z.string().optional() });
  app.post('/api/projects/:id/research/import-legacy', { preHandler: requireAuth }, async (req, reply) => {
    const p = resolve(req);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    const parsed = ImportLegacySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const docsAbs = path.resolve(p.path, parsed.data.docsDir ?? 'docs');
      const legacy = parseLegacyDocs(docsAbs);
      const store = ctx.research.store(p.path);
      const report = importLegacy(p.path, store, legacy);
      done(p.path);
      return { ok: true, report };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
