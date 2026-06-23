import type { Role } from '@rcc/shared';

/**
 * 项目可见性（轻量授权，纯为视图干净，非安全边界）：
 * 管理员看全部；普通用户仅看自己拥有的项目。
 * 会话/文件/task 的可见性「跟随项目」——能看到项目即能看到其下全部资源。
 */
export function canSeeProject(
  user: { id: string; role: Role },
  project: { ownerId?: string },
): boolean {
  return user.role === 'admin' || project.ownerId === user.id;
}
