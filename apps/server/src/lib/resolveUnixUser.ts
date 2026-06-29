/**
 * 按 ownerId(主账号 user.id 或子用户 subUser.id)解析对应 unix 用户名。
 * 与 app.ts 内的同名局部函数语义一致,抽出来让 SessionIndex 复用,避免双实现。
 *
 * 主账号 → 自己的 unixUser;
 * 子用户 → 父主账号的 unixUser(子用户不能改 unix 身份);
 * 未知/缺省 → serviceUser(兼容老数据,零行为变化)。
 */
interface UsersLike {
  get: (id: string) => { unixUser?: string } | undefined;
}
interface SubUsersLike {
  get: (id: string) => { parentId: string } | undefined;
}

export function makeResolveUnixUser(
  users: UsersLike,
  subUsers: SubUsersLike,
  serviceUser: string,
): (ownerId: string | undefined) => string {
  return (ownerId) => {
    if (!ownerId) return serviceUser;
    const u = users.get(ownerId);
    if (u?.unixUser) return u.unixUser;
    const s = subUsers.get(ownerId);
    if (s) {
      const parent = users.get(s.parentId);
      if (parent?.unixUser) return parent.unixUser;
    }
    return serviceUser;
  };
}
