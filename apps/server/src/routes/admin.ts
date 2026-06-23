import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import {
  makeRequireAuth,
  makeRequireAdminRole,
  toAuthUserFromPrimary,
} from '../plugins/requireAuth';

const CreateSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: z.enum(['admin', 'user']).default('user'),
  /**
   * 多用户隔离:绑定的本机 unix 用户名。可选;缺省取 ctx.config.serviceUser
   * (相当于"跟 admin 跑在同一个 unix 下",行为同单用户旧逻辑)。
   */
  unixUser: z.string().min(1).optional(),
});
const PatchSchema = z.object({
  password: z.string().min(1).optional(),
  unixUser: z.string().min(1).optional(),
});

/** 用户管理（仅管理员）：列出 / 新增 / 改口令 / 删用户。绝不外泄 passwordHash。 */
export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);
  const requireAdmin = makeRequireAdminRole();
  const guard = { preHandler: [requireAuth, requireAdmin] };

  app.get('/api/admin/users', guard, async () => {
    return { users: ctx.users.load().map(toAuthUserFromPrimary) };
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
      // add 完拿到 user 后,补 unixUser 字段(UserStore.add 当前不接受 unixUser 入参)。
      // 缺省取 serviceUser:跟运行 rcc 服务的 unix 一致,行为同单用户旧逻辑。
      const targetUnix = parse.data.unixUser ?? ctx.config.serviceUser;
      const withUnix = ctx.users.setUnixUser(user.id, targetUnix);
      return { user: toAuthUserFromPrimary(withUnix ?? user) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parse = PatchSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    let updated = ctx.users.get(id);
    if (!updated) return reply.code(404).send({ error: 'user not found' });
    if (parse.data.password) {
      const hash = await argon2.hash(parse.data.password);
      updated = ctx.users.setPassword(id, hash) ?? updated;
    }
    if (parse.data.unixUser) {
      updated = ctx.users.setUnixUser(id, parse.data.unixUser) ?? updated;
    }
    return { user: toAuthUserFromPrimary(updated) };
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
