import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { listSubdirs, PathTraversalError } from '../lib/files';

/**
 * 决定本次请求的浏览根:
 *   1) RCC_FS_BROWSE_ROOT_<UNIXUSER> env 显式配了 → 用它
 *   2) 否则 → /home/<unixUser>(Linux 约定;非标准家目录的少数环境靠 env 兜底)
 * 仍保留旧 FS_BROWSE_ROOT 作为"完全没 unix 区分时的全局后备"
 * (老部署不知道 unix 隔离的兼容路径)。
 */
function browseRootFor(ctx: AppContext, unixUser: string): string {
  const explicit = ctx.config.fsBrowseRootMap[unixUser];
  if (explicit) return explicit;
  // 服务进程 unix 用户用旧的全局 FS_BROWSE_ROOT(兼容老部署)
  if (unixUser === ctx.config.serviceUser && ctx.config.fsBrowseRoot) {
    return ctx.config.fsBrowseRoot;
  }
  return path.join('/home', unixUser);
}

/**
 * 文件系统目录选择器（添加项目时逐级点选路径，不用手输）。
 * 多用户隔离设计 2026-06-23:浏览根按 req.user.unixUser 决定,各自看自己家目录。
 */
export async function registerFsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/fs/dirs', { preHandler: requireAuth }, async (req, reply) => {
    const { path: relPath = '' } = req.query as { path?: string };
    const root = browseRootFor(ctx, req.user!.unixUser);
    try {
      const listing = listSubdirs(root, relPath);
      return { root, ...listing };
    } catch (e) {
      const code = e instanceof PathTraversalError ? 403 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
}
