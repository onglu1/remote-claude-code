import type { Role } from '@rcc/shared';

/**
 * 项目可见性(轻量授权,纯为视图干净)。
 * 多用户隔离设计 2026-06-23:按 namespaceId 比对(主账号 namespace=user.id,子用户 namespace=subUser.id),
 * 让"主账号"和"它的各子用户"互不可见,体现"子用户=主账号的独立工作空间"语义。
 * unix 隔离是另一回事(由 sudo wrapper 实现),authz 只管 UI 视图。
 */
export function canSeeProject(
  user: { role: Role; namespaceId: string },
  project: { ownerId?: string },
): boolean {
  return user.role === 'admin' || project.ownerId === user.namespaceId;
}
