import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';
import { TaskEvidenceStore } from '../lib/taskEvidence';

const PatchSchema = z.object({
  status: z.enum(['todo', 'doing', 'done', 'dropped']).optional(),
  evidenceLinks: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export async function registerTaskEvidenceRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  // 取 store 前先校验项目可见性（不可见与不存在一样返回 null → 404）。
  const storeFor = (id: string, req: FastifyRequest): TaskEvidenceStore | null => {
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) return null;
    return new TaskEvidenceStore(path.join(project.path, 'docs'));
  };

  app.get('/api/projects/:id/tasks', { preHandler: requireAuth }, async (req, reply) => {
    const store = storeFor((req.params as { id: string }).id, req);
    if (!store) return reply.code(404).send({ error: 'project not found' });
    return { tasks: store.getTasks(), evidence: store.getEvidence(), hasDocs: store.hasDocs() };
  });

  app.patch('/api/projects/:id/tasks/:num', { preHandler: requireAuth }, async (req, reply) => {
    const { id, num } = req.params as { id: string; num: string };
    const store = storeFor(id, req);
    if (!store) return reply.code(404).send({ error: 'project not found' });
    const parse = PatchSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    store.patchTask(num, parse.data);
    return { ok: true, task: store.getTasks().find((t) => t.number === num) };
  });
}
