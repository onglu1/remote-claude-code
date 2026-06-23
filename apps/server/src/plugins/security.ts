import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/** 基础安全响应头 + 可选信任 Cloudflare 真实 IP（仅用于日志）。 */
export default fp(async function security(
  app: FastifyInstance,
  opts: { trustCloudflare: boolean },
) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'no-referrer');
    if (opts.trustCloudflare) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string') {
        (req as unknown as { realIp: string }).realIp = cf;
      }
    }
  });
});
