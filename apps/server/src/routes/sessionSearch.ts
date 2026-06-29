/**
 * GET /api/sessions/search:跨会话搜索接口。
 *
 * 强制按 req.user.namespaceId 过滤(不接受前端传 namespaceId);
 * projectId 可选,提供时走 canSeeProject 二次校验拦截越权;
 * source/visibility/folderId/limit/q 透传给 sessionIndex.search。
 */
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '@rcc/shared';
import type { AppContext } from '../context';
import type { SessionIndex, SearchOptions, SessionSearchResult } from '../lib/sessionIndex';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';

/**
 * 纯函数 handler:测试可直接调,不走 Fastify。
 * 返回 { results } 或 { error, code }。
 */
export interface SearchHandlerDeps {
  sessionIndex: Pick<SessionIndex, 'search'>;
  projects: { get: (id: string) => { id: string; ownerId?: string } | undefined };
}

export interface SearchQueryParams {
  q?: string;
  projectId?: string;
  source?: string;
  visibility?: string;
  folderId?: string;
  limit?: string | number;
}

export type SearchHandlerResult =
  | { ok: true; results: SessionSearchResult[] }
  | { ok: false; error: string; code: number };

export function runSearchQuery(
  deps: SearchHandlerDeps,
  user: AuthUser,
  q: SearchQueryParams,
): SearchHandlerResult {
  const projectId = typeof q.projectId === 'string' && q.projectId ? q.projectId : undefined;
  if (projectId) {
    const p = deps.projects.get(projectId);
    if (!p || !canSeeProject(user, p as never)) {
      return { ok: false, error: 'forbidden', code: 403 };
    }
  }
  const source = q.source === 'claude' || q.source === 'codex' ? q.source : undefined;
  const visibility = ['default', 'starred', 'closed', 'deleted'].includes(q.visibility ?? '')
    ? (q.visibility as 'default' | 'starred' | 'closed' | 'deleted')
    : 'default';
  const limit = q.limit !== undefined ? Math.max(1, Math.min(Number(q.limit), 200)) : 50;
  const opts: SearchOptions = {
    query: typeof q.q === 'string' ? q.q : undefined,
    projectId,
    source,
    visibility,
    limit,
  };
  const results = deps.sessionIndex.search(opts, user.namespaceId);
  return { ok: true, results };
}

export async function registerSessionSearchRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);
  app.get('/api/sessions/search', { preHandler: requireAuth }, async (req, reply) => {
    const user = req.user;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    const r = runSearchQuery({ sessionIndex: ctx.sessionIndex, projects: ctx.projects }, user, (req.query ?? {}) as SearchQueryParams);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { results: r.results };
  });
}
