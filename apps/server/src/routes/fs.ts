import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { listSubdirs, PathTraversalError } from '../lib/files';

/**
 * 文件系统目录选择器（添加项目时逐级点选路径，不用手输）。
 * 仅列「已配置浏览根 fsBrowseRoot」内的子目录，单次按需读取，非扫描。
 */
export async function registerFsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  // 任意登录用户都可浏览目录（用于新建自己的项目）；目录浏览不涉及项目可见性。
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/fs/dirs', { preHandler: requireAuth }, async (req, reply) => {
    const { path: relPath = '' } = req.query as { path?: string };
    try {
      const listing = listSubdirs(ctx.config.fsBrowseRoot, relPath);
      return { root: ctx.config.fsBrowseRoot, ...listing };
    } catch (e) {
      const code = e instanceof PathTraversalError ? 403 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
}
