import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import type { Config } from './config';
import { buildContext, type AppContext } from './context';
import security from './plugins/security';
import { registerStaticSite } from './plugins/staticSite';
import { registerAuthRoutes } from './routes/auth';
import { registerAdminRoutes } from './routes/admin';
import { registerProjectRoutes } from './routes/projects';
import { registerFileRoutes } from './routes/files';
import { registerFsRoutes } from './routes/fs';
import { registerTaskEvidenceRoutes } from './routes/taskEvidence';
import { registerResearchRoutes } from './routes/research';
import { registerSessionRoutes } from './routes/sessions';
import { registerChatRoutes } from './routes/chat';
import { registerMetricsRoutes } from './routes/metrics';

export interface BuildAppOptions {
  /** 测试时可注入已构建好的 context（跳过 argon2 等）。 */
  context?: AppContext;
  serveStatic?: boolean;
}

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const ctx = opts.context ?? (await buildContext(config));

  await app.register(cookie);
  await app.register(security, { trustCloudflare: config.trustCloudflare });
  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true }));

  await registerAuthRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerProjectRoutes(app, ctx);
  await registerFileRoutes(app, ctx);
  await registerFsRoutes(app, ctx);
  await registerTaskEvidenceRoutes(app, ctx);
  await registerResearchRoutes(app, ctx);
  await registerSessionRoutes(app, ctx);
  await registerChatRoutes(app, ctx);
  await registerMetricsRoutes(app, ctx);

  if (opts.serveStatic ?? true) {
    await registerStaticSite(app, config.webDist);
  }

  return app;
}
