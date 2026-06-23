import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { MetricsSampler } from '../lib/metrics';

/**
 * 服务器资源面板：GET /api/metrics 返回整机 GPU/CPU/内存/磁盘快照。
 * 这是服务器全局信息（不按项目过滤），任意登录用户可见；未登录 401。
 * 路由内持有单例 Sampler，复用其 1.5s TTL 缓存以避免高并发刷爆 nvidia-smi。
 */
export async function registerMetricsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users);
  const sampler = new MetricsSampler();

  app.get('/api/metrics', { preHandler: requireAuth }, async () => {
    const metrics = await sampler.getSnapshot();
    return { metrics };
  });
}
