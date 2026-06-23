import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';

// 用户偏好(目前只有空闲自动关闭阈值)。0 = 关闭功能;上限 48 小时防极端值。
const SettingsSchema = z.object({ idleCloseHours: z.number().int().min(0).max(48) });

const PasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

/**
 * 当前用户(自己)的设置端点:
 * - GET /api/me/settings 返回 settings(未配置过给默认 { idleCloseHours: 3 })。
 * - PATCH /api/me/settings 写入 settings(子用户/主账号各写各自 store)。
 * - PATCH /api/me/password 自助改口令(校验旧口令)。
 *
 * 鉴权走 requireAuth(普通用户仅能改自己的)。管理员改别人走 admin 路由,这里不暴露。
 * 多用户隔离设计 2026-06-23:按 req.user.kind 路由到 UserStore 或 SubUserStore。
 */
export async function registerMeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/me/settings', { preHandler: requireAuth }, async (req) => {
    const me = req.user!;
    if (me.kind === 'subuser') {
      const s = ctx.subUsers.get(me.id);
      return s?.settings ?? { idleCloseHours: 3 };
    }
    const u = ctx.users.get(me.id);
    return u?.settings ?? { idleCloseHours: 3 };
  });

  app.patch('/api/me/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parse = SettingsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const me = req.user!;
    if (me.kind === 'subuser') {
      const s = ctx.subUsers.updateSettings(me.id, parse.data);
      return s?.settings ?? parse.data;
    }
    const u = ctx.users.updateSettings(me.id, parse.data);
    return u?.settings ?? parse.data;
  });

  app.patch('/api/me/password', { preHandler: requireAuth }, async (req, reply) => {
    const parse = PasswordSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const me = req.user!;
    const { oldPassword, newPassword } = parse.data;
    if (me.kind === 'subuser') {
      const s = ctx.subUsers.get(me.id);
      const ok = s && (await argon2.verify(s.passwordHash, oldPassword).catch(() => false));
      if (!s || !ok) return reply.code(401).send({ error: 'wrong_password' });
      ctx.subUsers.setPassword(s.id, await argon2.hash(newPassword));
      return { ok: true };
    }
    const u = ctx.users.get(me.id);
    const ok = u && (await argon2.verify(u.passwordHash, oldPassword).catch(() => false));
    if (!u || !ok) return reply.code(401).send({ error: 'wrong_password' });
    ctx.users.setPassword(u.id, await argon2.hash(newPassword));
    return { ok: true };
  });
}
