import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser, User, SubUser } from '@rcc/shared';
import { verifyToken, COOKIE_NAME } from '../lib/auth';
import type { UserStore } from '../lib/users';
import type { SubUserStore } from '../lib/subUsers';

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 requireAuth 校验 cookie token 后挂上的当前用户（脱敏）。 */
    user?: AuthUser;
  }
}

/**
 * 生成校验 cookie token 的 preHandler。
 * 多用户隔离设计 2026-06-23:支持子用户登录,token sub 既可指向 User.id 也可指向 SubUser.id。
 * 校验签名/过期 → 查 stores → 把 req.user 挂上(含 kind/unixUser/namespaceId)。
 * token 无效或对应用户/父主账号被删 → 401。
 */
export function makeRequireAuth(secret: string, users: UserStore, subUsers: SubUserStore) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = resolveUser(secret, users, subUsers, req.cookies?.[COOKIE_NAME]);
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
 * 从 token 解出脱敏当前用户(供 REST preHandler 与 WS 握手共用)。
 * 先查主账号(token.sub === user.id),再查子用户(token.sub === subUser.id 且父存在)。
 * 任一不命中 → null。
 */
export function resolveUser(
  secret: string,
  users: UserStore,
  subUsers: SubUserStore,
  token: string | undefined,
): AuthUser | null {
  const payload = verifyToken(secret, token);
  if (!payload) return null;
  const u = users.get(payload.userId);
  if (u) return toAuthUserFromPrimary(u);
  const s = subUsers.get(payload.userId);
  if (s) {
    const parent = users.get(s.parentId);
    if (!parent) return null; // 孤儿子用户,父被删 → 登录态作废
    return toAuthUserFromSub(s, parent);
  }
  return null;
}

/** 主账号 → AuthUser:namespaceId === user.id;unixUser 兜底 'unknown'(context.migrate 已回填,这条不应触发)。 */
export function toAuthUserFromPrimary(u: User): AuthUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    kind: 'user',
    unixUser: u.unixUser ?? 'unknown',
    namespaceId: u.id,
  };
}

/** 子用户 → AuthUser:role/unixUser 继承父;namespaceId === subUser.id(资源与父独立)。 */
export function toAuthUserFromSub(s: SubUser, parent: User): AuthUser {
  return {
    id: s.id,
    username: s.username,
    role: parent.role,
    kind: 'subuser',
    parentId: parent.id,
    unixUser: parent.unixUser ?? 'unknown',
    namespaceId: s.id,
  };
}
