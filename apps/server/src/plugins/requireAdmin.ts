import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, COOKIE_NAME } from '../lib/auth';

/** 生成一个校验 cookie token 的 preHandler。失败返回 401。 */
export function makeRequireAdmin(secret: string) {
  return async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies?.[COOKIE_NAME];
    if (!verifyToken(secret, token)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
