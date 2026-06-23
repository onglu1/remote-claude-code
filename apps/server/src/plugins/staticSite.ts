import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** 生产环境托管前端构建产物 apps/web/dist，并对非 /api 路由做 SPA 回退。 */
export async function registerStaticSite(app: FastifyInstance, webDist: string): Promise<void> {
  if (!fs.existsSync(webDist)) {
    app.log.warn(`web 构建产物不存在: ${webDist}（开发模式下用 vite dev 即可）`);
    return;
  }
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    }
    return reply.code(404).send({ error: 'not found' });
  });
}
