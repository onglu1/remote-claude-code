import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser } from '@rcc/shared';
import { verifyToken, COOKIE_NAME } from '../lib/auth';
import type { UserStore } from '../lib/users';

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 requireAuth 校验 cookie token 后挂上的当前用户（脱敏）。 */
    user?: AuthUser;
  }
}

/**
 * 生成校验 cookie token 的 preHandler：校验签名/过期 → 查 UserStore →
 * 把 req.user 挂上。token 无效或用户已被删 → 401。
 */
export function makeRequireAuth(secret: string, users: UserStore) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = resolveUser(secret, users, req.cookies?.[COOKIE_NAME]);
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.user = user;
  };
}

/** 在 requireAuth 之后使用：要求管理员角色，否则 403。 */
export function makeRequireAdminRole() {
  return async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.user?.role !== 'admin') {
      await reply.code(403).send({ error: 'forbidden' });
    }
  };
}

/**
 * 从 token 解出脱敏当前用户（供 REST preHandler 与 WS 握手共用）。
 * 校验失败或用户不存在返回 null。
 */
export function resolveUser(
  secret: string,
  users: UserStore,
  token: string | undefined,
): AuthUser | null {
  const payload = verifyToken(secret, token);
  if (!payload) return null;
  const user = users.get(payload.userId);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}
