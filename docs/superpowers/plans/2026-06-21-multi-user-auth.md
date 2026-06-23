# 多用户（应用层账号）实现计划

对应 spec：`docs/superpowers/specs/2026-06-21-multi-user-auth-design.md`
TDD：每个纯逻辑先写失败测试再实现；频繁小步提交（中文、说清「为什么」）。

## 提交顺序与任务

### T0 docs
- spec + plan 各自提交。

### T1 shared：User/Role + Project.ownerId
- `packages/shared/src/schemas.ts`：加 `RoleSchema` / `UserSchema` / `AuthUserSchema`；`ProjectSchema` 加可选 `ownerId`；`ProjectCreateSchema` 带上。
- `schemas.test.ts`：UserSchema 合法/非法 role；Project 带/缺 ownerId 均合法。
- 验证：`npm -w @rcc/shared run test`、`typecheck`。提交。

### T2 server lib：auth token 带 userId
- `lib/auth.ts`：`signToken(secret, ttlMs, userId, now?)` payload `{sub,exp}`；`verifyToken` 返回 `{userId}|null`。
- `lib/auth.test.ts`：往返解出 userId、过期、篡改、缺 token。
- 注意：此改动会让现有 `requireAdmin.ts`（用布尔）与各路由 WS（用布尔）类型不符——下一步统一切换；本步先让 auth 单测过。提交。

### T3 server lib：UserStore
- `lib/users.ts` + `lib/users.test.ts`（照搬 ProjectStore 风格）。
- 验证单测。提交。

### T4 server lib：canSeeProject + ProjectStore.migrate
- `lib/authz.ts` + `lib/authz.test.ts`。
- `lib/projects.ts` 加 `migrate(adminId)`；`projects.test.ts` 加用例（回填、幂等、不覆盖、ProjectSchema 现接受 ownerId）。
- 验证单测。提交。

### T5 server 鉴权层 + config + context
- `config.ts`：`usersConfigPath`、`ADMIN_USERNAME`。
- `plugins/requireAuth.ts`：`makeRequireAuth` / `makeRequireAdminRole` + fastify 类型扩展。
- `context.ts`：UserStore、首启播种 admin、`projects.migrate(adminId)`、暴露 users。
- 验证 typecheck。提交。

### T6 server routes：auth + admin + 过滤
- `routes/auth.ts`：login/state/lock + unlock 别名。
- `routes/admin.ts`（新）：users CRUD，挂 requireAuth+adminRole；禁删最后一个 admin。
- `routes/projects.ts`：requireAuth + canSeeProject 过滤 + 创建设 owner。
- `routes/sessions.ts` `chat.ts` `files.ts` `taskEvidence.ts`：requireAuth + canSeeProject（REST 与 WS 各自）。
- `routes/fs.ts`：requireAuth（仅登录）。
- `app.ts`：注册 admin 路由。
- `app.test.ts`：改 unlock→login 风格 + 加多用户视图/admin 鉴权用例。
- 验证 server 全测 + typecheck。提交。

### T7 前端
- `lib/api.ts`：login/authState({user})/lock + admin CRUD。
- `Login.tsx`：用户名输入。
- `App.tsx`：存 user、按 role 给入口。
- `ProjectList.tsx`：owner 标签 + 用户管理入口（admin）。
- `components/UserAdmin.tsx`：新增。
- 验证 web typecheck + build。提交。

### T8 验证与收尾
- `.gitignore` 加 `config/users.json`。提交。
- `npm run typecheck` / `npm test` / `npm run build` 全绿。
- `./start.sh` 重启（tmux 会话 remote-cc-server）。
- curl 真验证（PORT=6325）：health → admin login → state=admin → admin 建用户 → 该用户登录 → 双账号 /api/projects 不同视图。
- 汇报。

## 风险点

- WS 握手鉴权：原来只 `verifyToken` 布尔；改成解 userId 后还要查 user + canSeeProject，注意 user 可能已删（→close）。
- 播种时机：context 构建时算 argon2 hash（异步），已是 async，OK。
- 兼容别名 unlock：若 admin 用户名被改且 env 口令仍在，应按 ADMIN_USERNAME 这个用户校验（不是硬编码 admin）。
- 不可删最后一个 admin：admin CRUD DELETE 要校验。
