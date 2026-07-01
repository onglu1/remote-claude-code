import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(path|pathRaw|id|name)\}/g, (_, key: string) => values[key] ?? '');
}

export async function registerVscodeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  app.get('/api/projects/:id/vscode', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const template = ctx.config.vscodeUrlTemplate.trim();
    if (!template && !ctx.config.vscodeProxyTarget.trim()) {
      return { enabled: false as const };
    }

    const values = {
      id: encodeURIComponent(project.id),
      name: encodeURIComponent(project.name),
      path: encodeURIComponent(project.path),
      pathRaw: project.path,
    };

    return {
      enabled: true as const,
      url: template
        ? fillTemplate(template, values)
        : `${ctx.config.vscodeProxyPrefix}/?folder=${values.path}`,
    };
  });
}
