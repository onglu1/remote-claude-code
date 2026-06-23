import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';

/**
 * 当前请求的"我的家"目录:
 *   1) RCC_FS_BROWSE_ROOT_<UNIXUSER> env 显式配 → 用它
 *   2) 服务进程 unix 用户仍可用旧 FS_BROWSE_ROOT(老部署兼容)
 *   3) 否则 → /home/<unixUser>
 */
function homeFor(ctx: AppContext, unixUser: string): string {
  const explicit = ctx.config.fsBrowseRootMap[unixUser];
  if (explicit) return explicit;
  if (unixUser === ctx.config.serviceUser && ctx.config.fsBrowseRoot) {
    return ctx.config.fsBrowseRoot;
  }
  return path.join('/home', unixUser);
}

/**
 * 目录选择器:接受绝对路径,列出该路径下的子目录,无层级限制。
 * 多用户隔离设计 2026-06-23 + UX 改造 2026-06-23:
 *   - 默认起步 = 当前用户 home(/home/<unixUser> 或 env 覆盖)
 *   - 用户可点 "上级" 回到任意层级,点 "我的家" 回到默认起步
 *   - 任何能 readdir 的目录都可"选这里"作为项目根
 *
 * 安全边界:ServiceUser uid 直接 node fs(看到 ServiceUser 能 ls 的所有目录)。
 * 项目运行时仍按 unixUser 跑 tmux/claude,cwd 进入时 unix 权限自然限制。
 * 这是"目录选择器宽松、运行权限严格"的折中。
 */
export async function registerFsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/fs/dirs', { preHandler: requireAuth }, async (req, reply) => {
    const { path: queryPath } = req.query as { path?: string };
    const home = homeFor(ctx, req.user!.unixUser);
    const target = (queryPath ?? '').trim() || home;

    if (!path.isAbsolute(target)) {
      return reply.code(400).send({ error: 'path 必须是绝对路径' });
    }

    try {
      const realTarget = fs.realpathSync(target);
      const stat = fs.statSync(realTarget);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: '不是目录' });
      }
      const dirs = fs
        .readdirSync(realTarget, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== '.git' && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(realTarget, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(realTarget);
      return {
        path: realTarget,
        home,
        // 已到根目录(parent === self)时 parent=null,前端禁用"上级"按钮
        parent: parent === realTarget ? null : parent,
        dirs,
      };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reply.code(404).send({ error: '目录不存在' });
      if (code === 'EACCES') return reply.code(403).send({ error: '没有权限读取' });
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
