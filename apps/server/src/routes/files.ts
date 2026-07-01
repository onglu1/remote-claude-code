import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@rcc/shared';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';
import { FileBrowser, PathTraversalError } from '../lib/files';

function browserFor(project: Project): FileBrowser {
  const roots =
    project.browseRoots && project.browseRoots.length > 0
      ? project.browseRoots.map((r) => path.resolve(project.path, r))
      : [project.path];
  return new FileBrowser(roots);
}

export async function registerFileRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/projects/:id/files', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath = '' } = req.query as { path?: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    try {
      return { entries: browserFor(project).listDir(relPath), path: relPath };
    } catch (e) {
      const code = e instanceof PathTraversalError ? 403 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });

  app.get('/api/projects/:id/file', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath } = req.query as { path?: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    if (!relPath) return reply.code(400).send({ error: 'missing path' });
    try {
      return { file: browserFor(project).readFile(relPath) };
    } catch (e) {
      const code = e instanceof PathTraversalError ? 403 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });

  app.put('/api/projects/:id/file', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath, content } = req.body as { path?: unknown; content?: unknown };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    if (typeof relPath !== 'string' || !relPath) {
      return reply.code(400).send({ error: 'missing path' });
    }
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'missing content' });
    }
    try {
      return { file: browserFor(project).writeTextFile(relPath, content) };
    } catch (e) {
      const code = e instanceof PathTraversalError ? 403 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
}
