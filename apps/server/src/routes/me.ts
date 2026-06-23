import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';

// 用户偏好(目前只有空闲自动关闭阈值)。0 = 关闭功能;上限 48 小时防极端值。
const SettingsSchema = z.object({ idleCloseHours: z.number().int().min(0).max(48) });

/**
 * 当前用户(自己)的设置端点:
 * - GET 返回 settings(未配置过给默认 { idleCloseHours: 3 })。
 * - PATCH 写入 settings(单字段,后续多字段时直接扩 schema)。
 *
 * 鉴权走 requireAuth(普通用户仅能改自己的)。管理员要改别人的走 admin 路由,这里不暴露。
 */
export async function registerMeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/me/settings', { preHandler: requireAuth }, async (req) => {
    const u = ctx.users.get(req.user!.id);
    return u?.settings ?? { idleCloseHours: 3 };
  });

  app.patch('/api/me/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parse = SettingsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const u = ctx.users.updateSettings(req.user!.id, parse.data);
    return u?.settings ?? parse.data;
  });
}
