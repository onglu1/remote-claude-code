import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import {
  makeRequireAuth,
  makeRequireAdminRole,
  toAuthUserFromPrimary,
} from '../plugins/requireAuth';
import { canHaveRole } from '../lib/roleRank';

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

  // ---- 子用户 CRUD(多用户隔离设计 2026-06-23) ----
  // 子用户登录不能管子用户(防递归);主账号 user 只能管自己父下的;admin 看全部。
  // 子用户独立 role(2026-06-23 补丁);路由层强制 sub.role <= parent.role,父 user 不能挂 admin 子。
  const SubCreateSchema = z.object({
    parentId: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
    displayName: z.string().trim().min(1).max(40),
    role: z.enum(['admin', 'user']).default('user'),
  });
  const SubPatchSchema = z.object({
    password: z.string().min(1).optional(),
    displayName: z.string().trim().min(1).max(40).optional(),
    role: z.enum(['admin', 'user']).optional(),
  });

  const subAuth = { preHandler: requireAuth };

  app.get('/api/admin/subusers', subAuth, async (req, reply) => {
    const u = req.user!;
    if (u.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
    const all = ctx.subUsers.load().map(({ passwordHash: _ph, ...rest }) => rest);
    if (u.role === 'admin') return { subusers: all };
    return { subusers: all.filter((s) => s.parentId === u.id) };
  });

  app.post('/api/admin/subusers', subAuth, async (req, reply) => {
    const u = req.user!;
    if (u.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
    const parse = SubCreateSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    // 非 admin 只能给自己当父
    if (u.role !== 'admin' && parse.data.parentId !== u.id) {
      return reply.code(403).send({ error: 'forbidden_parent' });
    }
    const parent = ctx.users.get(parse.data.parentId);
    if (!parent) return reply.code(400).send({ error: 'parent_not_found' });
    // 子用户 role 不能超过父(admin > user)。父 user 想挂 admin 子用户 → 400。
    if (!canHaveRole(parent.role, parse.data.role)) {
      return reply.code(400).send({ error: 'role_exceeds_parent' });
    }
    try {
      const hash = await argon2.hash(parse.data.password);
      const sub = ctx.subUsers.add({
        parentId: parse.data.parentId,
        username: parse.data.username,
        passwordHash: hash,
        displayName: parse.data.displayName,
        role: parse.data.role,
      });
      const { passwordHash: _ph, ...rest } = sub;
      return { subuser: rest };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.patch('/api/admin/subusers/:id', subAuth, async (req, reply) => {
    const u = req.user!;
    if (u.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const target = ctx.subUsers.get(id);
    if (!target) return reply.code(404).send({ error: 'subuser not found' });
    if (u.role !== 'admin' && target.parentId !== u.id) {
      return reply.code(403).send({ error: 'forbidden_parent' });
    }
    const parse = SubPatchSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    let updated = target;
    if (parse.data.password) {
      const hash = await argon2.hash(parse.data.password);
      updated = ctx.subUsers.setPassword(id, hash) ?? updated;
    }
    if (parse.data.displayName) {
      updated = ctx.subUsers.rename(id, parse.data.displayName) ?? updated;
    }
    if (parse.data.role) {
      const parent = ctx.users.get(target.parentId);
      if (!parent) return reply.code(400).send({ error: 'parent_not_found' });
      if (!canHaveRole(parent.role, parse.data.role)) {
        return reply.code(400).send({ error: 'role_exceeds_parent' });
      }
      updated = ctx.subUsers.setRole(id, parse.data.role) ?? updated;
    }
    const { passwordHash: _ph, ...rest } = updated;
    return { subuser: rest };
  });

  app.delete('/api/admin/subusers/:id', subAuth, async (req, reply) => {
    const u = req.user!;
    if (u.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const target = ctx.subUsers.get(id);
    if (!target) return reply.code(404).send({ error: 'subuser not found' });
    if (u.role !== 'admin' && target.parentId !== u.id) {
      return reply.code(403).send({ error: 'forbidden_parent' });
    }
    ctx.subUsers.remove(id);
    return { ok: true };
  });
}
