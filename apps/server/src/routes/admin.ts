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

  // ---- 项目跨 namespace 管理(管理员降级 2026-06-25) ----
  // admin 普通入口已与其他用户同等(canSeeProject 不再 bypass admin),想跨 namespace
  // "管"项目需走这组专用路由。守卫 = requireAuth + requireAdmin,绕过 canSeeProject。
  //
  // 设计取舍:
  //  - GET 列全部项目:admin 才能看,普通用户 / 子用户 403。
  //  - PATCH owner:把项目从 A 转给 B(B 必须是已知 user.id 或 subUser.id)。
  //    转完之后,A 在他的视图里就看不见这项目了,B 能看见——所有 fall-through 的功能
  //    (会话/文件/research/folder)都自动跟着 canSeeProject 走,无需额外改。
  //  - DELETE:绕过 canSeeProject 删项目实体。**不**清空 conversations / folders 残留——
  //    那些走 projectId 关联,父项目消失后它们就成孤儿,各自的可见性继续按原 ownerId 算
  //    (普通用户列 conversations 时已经会按 project 不存在过滤掉),与现有 DELETE 路径同语义。
  //
  // 不做的事:在这里加"管理员替别人新建项目"。要新建仍走 POST /api/projects + 自己 namespace,
  // 想转给别人就建完用本路由 PATCH owner——少一个分支、行为更可预测。
  const PatchProjectSchema = z.object({
    ownerId: z.string().min(1),
  });
  const projectAdminGuard = { preHandler: [requireAuth, requireAdmin] };

  app.get('/api/admin/projects', projectAdminGuard, async () => {
    return { projects: ctx.projects.load() };
  });

  app.patch('/api/admin/projects/:id', projectAdminGuard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parse = PatchProjectSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: parse.error.message });
    const target = ctx.projects.get(id);
    if (!target) return reply.code(404).send({ error: 'project not found' });
    // 目标 ownerId 必须是已知 namespace(主账号 user.id 或子用户 subUser.id)。
    // 这一层是为了避免管理员手滑写错 id 导致项目永远没人看得见(那等于隐性丢失)。
    const allNs = new Set<string>([
      ...ctx.users.load().map((u) => u.id),
      ...ctx.subUsers.load().map((s) => s.id),
    ]);
    if (!allNs.has(parse.data.ownerId)) {
      return reply.code(400).send({ error: 'owner_not_found' });
    }
    const updated = ctx.projects.setOwnerId(id, parse.data.ownerId);
    if (!updated) return reply.code(404).send({ error: 'project not found' });
    return { project: updated };
  });

  app.delete('/api/admin/projects/:id', projectAdminGuard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = ctx.projects.get(id);
    if (!target) return reply.code(404).send({ error: 'project not found' });
    ctx.projects.remove(id);
    return { ok: true };
  });
}
