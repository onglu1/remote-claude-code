import type { Role } from '@rcc/shared';

/**
 * 项目可见性(轻量授权,纯为视图干净)。
 * 多用户隔离设计 2026-06-23:按 namespaceId 比对(主账号 namespace=user.id,子用户 namespace=subUser.id),
 * 让"主账号"和"它的各子用户"互不可见,体现"子用户=主账号的独立工作空间"语义。
 * unix 隔离是另一回事(由 sudo wrapper 实现),authz 只管 UI 视图。
 *
 * 管理员降级 2026-06-25:admin 不再自动 bypass。admin 平时(普通入口、API 普通路径)
 * 跟其他用户一样只看自己 namespace 的项目;想跨 namespace 看/改/删需走专门的
 * /api/admin/projects/* 路由(那条路只由 makeRequireAdminRole 守、绕过 canSeeProject)。
 * 这避免了"我平时都用 admin,然后被所有人项目刷屏"的体验问题。
 */
export function canSeeProject(
  user: { role: Role; namespaceId: string },
  project: { ownerId?: string },
): boolean {
  return project.ownerId === user.namespaceId;
}
