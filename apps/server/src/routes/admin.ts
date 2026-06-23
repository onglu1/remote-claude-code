import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '@rcc/shared';
import type { AppContext } from '../context';
import { makeRequireAuth, makeRequireAdminRole } from '../plugins/requireAuth';

const CreateSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['admin', 'user']).default('user'),
});
const PatchSchema = z.object({ password: z.string().min(1) });

const toAuthUser = (u: { id: string; username: string; role: AuthUser['role'] }): AuthUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
});

/** 用户管理（仅管理员）：列出 / 新增 / 改口令 / 删用户。绝不外泄 passwordHash。 */
export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users);
  const requireAdmin = makeRequireAdminRole();
  const guard = { preHandler: [requireAuth, requireAdmin] };

  app.get('/api/admin/users', guard, async () => {
    return { users: ctx.users.load().map(toAuthUser) };
  });

  app.post('/api/admin/users', guard, async (req, reply) => {
    const parse = CreateSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    try {
      const hash = await argon2.hash(parse.data.password);
      const user = ctx.users.add({
        username: parse.data.username,
        passwordHash: hash,
        role: parse.data.role,
      });
      return { user: toAuthUser(user) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parse = PatchSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    const hash = await argon2.hash(parse.data.password);
    const updated = ctx.users.setPassword(id, hash);
    if (!updated) return reply.code(404).send({ error: 'user not found' });
    return { user: toAuthUser(updated) };
  });

  app.delete('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const all = ctx.users.load();
    const target = all.find((u) => u.id === id);
    if (!target) return reply.code(404).send({ error: 'user not found' });
    // 防自锁：不允许删掉最后一个管理员。
    const admins = all.filter((u) => u.role === 'admin');
    if (target.role === 'admin' && admins.length <= 1) {
      return reply.code(400).send({ error: '不能删除最后一个管理员' });
    }
    ctx.users.remove(id);
    return { ok: true };
  });
}
