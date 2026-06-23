import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';

// 文件夹名:trim 后 1..40 字符;与 FolderSchema 的 name 约束一致。
const NameSchema = z.object({ name: z.string().trim().min(1).max(40) });
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * 文件夹 CRUD:按项目 + 当前用户隔离。
 * - GET 列举:仅返回本项目本用户的(按 sortOrder 升序、同序按 createdAt)。
 * - POST 创建:同(projectId,ownerId,name)三联唯一 → 409 duplicate。
 * - PATCH 改名/排序:校验所有权(folder.ownerId === user.id)。
 * - DELETE:把内部会话 folderId 置 null,返回 reassigned 计数。
 *
 * 项目可见性走 canSeeProject;此处 folder 所有权再做一层(避免管理员误改普通用户的文件夹归属)。
 */
export async function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/projects/:id/folders', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return { folders: ctx.folders.listByProject(id, req.user!.id) };
  });

  app.post('/api/projects/:id/folders', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const parse = NameSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    try {
      const folder = ctx.folders.create(id, req.user!.id, parse.data.name);
      return { folder };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('duplicate')) return reply.code(409).send({ error: 'duplicate' });
      throw e;
    }
  });

  app.patch('/api/projects/:id/folders/:fid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const folder = ctx.folders.get(fid);
    if (!folder || folder.projectId !== id || folder.ownerId !== req.user!.id) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    const parse = PatchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    try {
      let updated = folder;
      if (parse.data.name !== undefined) {
        const r = ctx.folders.rename(fid, parse.data.name);
        if (r) updated = r;
      }
      // sortOrder 单条修改 YAGNI:批量 reorder 走单独端点(本期不暴露)。
      return { folder: updated };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('duplicate')) return reply.code(409).send({ error: 'duplicate' });
      throw e;
    }
  });

  app.delete('/api/projects/:id/folders/:fid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const folder = ctx.folders.get(fid);
    if (!folder || folder.projectId !== id || folder.ownerId !== req.user!.id) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    const { reassigned } = ctx.folders.remove(fid);
    return { reassigned };
  });
}
