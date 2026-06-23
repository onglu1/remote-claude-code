import type { Role } from '@rcc/shared';

/**
 * 角色优先级:admin > user。用于:
 * - 路由层校验"子用户 role <= 父 role"
 * - runtime resolveUser 把 sub.role clamp 到不超过 parent.role(数据手改的兜底)
 */
const RANK: Record<Role, number> = { user: 1, admin: 2 };

export function roleRank(r: Role): number {
  return RANK[r];
}

/** sub <= parent 即合法。 */
export function canHaveRole(parentRole: Role, subRole: Role): boolean {
  return roleRank(subRole) <= roleRank(parentRole);
}

/** 取两个角色里 rank 较小者(即更弱的)。用于 runtime clamp。 */
export function minRole(a: Role, b: Role): Role {
  return roleRank(a) <= roleRank(b) ? a : b;
}
