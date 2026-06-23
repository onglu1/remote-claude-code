import argon2 from 'argon2';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '@rcc/shared';
import type { AppContext } from '../context';
import { signToken, verifyToken, COOKIE_NAME } from '../lib/auth';

const LoginSchema = z.object({ username: z.string().min(1), password: z.string() });
// 兼容别名：旧前端只发口令，按 ADMIN_USERNAME 这个用户校验。
const UnlockSchema = z.object({ password: z.string() });

const toAuthUser = (u: { id: string; username: string; role: AuthUser['role'] }): AuthUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
});

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
    const u = ctx.users.get(payload.userId);
    return { user: u ? toAuthUser(u) : null };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parse = LoginSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const user = ctx.users.findByUsername(parse.data.username);
    const ok = user
      ? await argon2.verify(user.passwordHash, parse.data.password).catch(() => false)
      : false;
    if (!user || !ok) return reply.code(401).send({ error: '用户名或口令错误' });
    reply.setCookie(COOKIE_NAME, issue(user.id), cookieOpts);
    return { user: toAuthUser(user) };
  });

  // 兼容别名：保留 /api/auth/unlock，按 ADMIN_USERNAME 这个用户处理口令登录，
  // 避免前端中途态被破坏。
  app.post('/api/auth/unlock', async (req, reply) => {
    const parse = UnlockSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const admin = ctx.users.findByUsername(ctx.config.adminUsername);
    const ok = admin
      ? await argon2.verify(admin.passwordHash, parse.data.password).catch(() => false)
      : false;
    if (!admin || !ok) return reply.code(401).send({ error: '口令错误' });
    reply.setCookie(COOKIE_NAME, issue(admin.id), cookieOpts);
    return { unlocked: true, user: toAuthUser(admin) };
  });

  app.post('/api/auth/lock', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { user: null };
  });
}
