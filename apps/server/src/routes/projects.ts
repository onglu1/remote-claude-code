import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';

const CreateSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(['dev', 'research']),
  launchCommand: z.string().optional(),
  notes: z.string().optional(),
  /** 仅管理员可指派 owner；普通用户忽略，强制设为自己。 */
  ownerId: z.string().optional(),
});

export async function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/projects', { preHandler: requireAuth }, async (req) => {
    const user = req.user!;
    return { projects: ctx.projects.load().filter((p) => canSeeProject(user, p)) };
  });

  app.get('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    // 不可见时与不存在一样返回 404（不暴露存在性）。
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'not found' });
    }
    return { project };
  });

  app.post('/api/projects', { preHandler: requireAuth }, async (req, reply) => {
    const parse = CreateSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    const user = req.user!;
    // 普通用户只能建自己的；管理员可用 body.ownerId 指派，缺省也归自己。
    const ownerId = user.role === 'admin' && parse.data.ownerId ? parse.data.ownerId : user.id;
    try {
      const project = ctx.projects.add({ ...parse.data, ownerId });
      return { project };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.delete('/api/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'not found' });
    }
    ctx.projects.remove(id);
    return { ok: true };
  });
}
