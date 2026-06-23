import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { signToken, verifyToken, COOKIE_NAME } from '../lib/auth';
import { toAuthUserFromPrimary, toAuthUserFromSub } from '../plugins/requireAuth';

const LoginSchema = z.object({ username: z.string().min(1), password: z.string() });
// 兼容别名：旧前端只发口令，按 ADMIN_USERNAME 这个用户校验。
const UnlockSchema = z.object({ password: z.string() });

export async function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.publicOrigin.startsWith('https'),
    path: '/',
    maxAge: Math.floor(ctx.config.tokenTtlMs / 1000),
  };

  const issue = (userId: string): string =>
    signToken(ctx.config.sessionSecret, ctx.config.tokenTtlMs, userId);

  app.get('/api/auth/state', async (req) => {
    const payload = verifyToken(ctx.config.sessionSecret, req.cookies?.[COOKIE_NAME]);
    if (!payload) return { user: null };
    // 先查主账号
    const u = ctx.users.get(payload.userId);
    if (u) return { user: toAuthUserFromPrimary(u) };
    // 再查子用户(父被删则视作登出)
    const s = ctx.subUsers.get(payload.userId);
    if (s) {
      const parent = ctx.users.get(s.parentId);
      if (parent) return { user: toAuthUserFromSub(s, parent) };
    }
    return { user: null };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parse = LoginSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const { username, password } = parse.data;

    // 先查主账号
    const user = ctx.users.findByUsername(username);
    if (user) {
      const ok = await argon2.verify(user.passwordHash, password).catch(() => false);
      if (ok) {
        reply.setCookie(COOKIE_NAME, issue(user.id), cookieOpts);
        return { user: toAuthUserFromPrimary(user) };
      }
    }
    // 再查子用户(独立用户名/口令,unix 身份继承父)
    const sub = ctx.subUsers.findByUsername(username);
    if (sub) {
      const ok = await argon2.verify(sub.passwordHash, password).catch(() => false);
      if (ok) {
        const parent = ctx.users.get(sub.parentId);
        if (!parent) return reply.code(401).send({ error: 'orphan_subuser' });
        reply.setCookie(COOKIE_NAME, issue(sub.id), cookieOpts);
        return { user: toAuthUserFromSub(sub, parent) };
      }
    }
    return reply.code(401).send({ error: '用户名或口令错误' });
  });

  // 兼容别名：保留 /api/auth/unlock，按 ADMIN_USERNAME 这个用户处理口令登录，
  // 避免前端中途态被破坏。子用户不走这条(子用户登录用 /api/auth/login)。
  app.post('/api/auth/unlock', async (req, reply) => {
    const parse = UnlockSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const admin = ctx.users.findByUsername(ctx.config.adminUsername);
    const ok = admin
      ? await argon2.verify(admin.passwordHash, parse.data.password).catch(() => false)
      : false;
    if (!admin || !ok) return reply.code(401).send({ error: '口令错误' });
    reply.setCookie(COOKIE_NAME, issue(admin.id), cookieOpts);
    return { unlocked: true, user: toAuthUserFromPrimary(admin) };
  });

  app.post('/api/auth/lock', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { user: null };
  });
}
