# 多用户（应用层账号）设计

日期：2026-06-21

## 背景与定调

remote-cc 当前是「单口令解锁」：一个 `ADMIN_PASSWORD`，解锁后看到的是全部项目/会话。
现在要支持多用户。

**关键定调（已和产品负责人确认，不要推翻）**：

- 这是「**应用层账号**」，**不是安全边界**。底层仍是同一系统账号 + 同一个 Claude 订阅在跑 `claude`；
  Claude Code 进程本就能访问机器上任意目录。划分用户**纯粹是为了每个人视图干净**（各看各的项目/会话）。
- **因此不要做复杂的资源授权系统**。只按「当前用户」过滤列表即可，管理员看全部。不引入 ACL、分享、组织等概念。
- 每用户独立用户名 + 口令（argon2id 哈希存储）。
- 角色 `admin | user`。现 admin（你，env 口令持有者）是超级管理员：看全部项目、管理用户、建项目时可指定 owner。
- 普通用户**能新建自己的项目**（建出来 `ownerId` = 自己）。
- 会话**不加归属字段**，可见性「跟随项目」：能看到某项目，就能看到它下面**所有**会话（零迁移、视图自然干净）。
- 应用内用户管理界面（仅管理员可见）：列出 / 新增用户、改某用户口令、删用户。

## 不破坏现有（项目硬规则①）

- 你（env 口令持有者）必须仍能登录：用户名默认 `admin`（`ADMIN_USERNAME`）+ 原 `ADMIN_PASSWORD`。
- 存量项目（缺 `ownerId`）全部归 admin。
- 存量会话照常可见（可见性跟随项目，零迁移）。
- tmux / 聊天引擎 / 终端 / 文件浏览 / task-evidence 引擎**全部不动**，仅在路由层加「可见性」过滤。
- 保留 `/api/auth/unlock` 作为兼容别名（按 admin 用户名 + 口令处理），避免前端中途态被破坏。

## 数据模型

### User（新增）

`config/users.json`（**不进 git**，加 .gitignore）+ `apps/server/src/lib/users.ts` 的 `UserStore`，
照搬 `ProjectStore` 的「显式 JSON + 原子写（tmp→rename）+ 写前 .bak」风格，配 `users.test.ts`。

User 字段：

```
id: string            // 随机（crypto.randomUUID）
username: string      // 唯一（大小写敏感，按原样存）
passwordHash: string  // argon2id
role: 'admin' | 'user'
createdAt: string     // ISO
```

`UserStore` 方法：
- `load(): User[]`（文件不存在→`[]`，不扫描）
- `findByUsername(username): User | undefined`
- `get(id): User | undefined`
- `add({ username, passwordHash, role }): User`（生成 id/createdAt；拒绝重复 username）
- `setPassword(id, passwordHash): User | undefined`
- `remove(id): void`
- `count(): number`（首启播种判空用）

不在 UserStore 里做 argon2（保持纯数据 + IO，便于单测）；哈希在 context / 路由层算好再传入。

### Project（改）

`packages/shared/src/schemas.ts` 给 `ProjectSchema` 加：
```
ownerId: z.string().optional()   // 为兼容存量设为可选；context 迁移时回填 admin.id
```
`ProjectCreateSchema` 随之带上可选 `ownerId`（admin 创建可指派；普通用户忽略此入参强制设自己）。

### shared 新增类型

```
RoleSchema = z.enum(['admin','user'])
UserSchema = z.object({ id, username, passwordHash, role: RoleSchema, createdAt })
// 给前端/鉴权用的「脱敏当前用户」
AuthUserSchema = z.object({ id, username, role: RoleSchema })
```
`index.ts` 已 `export * from './schemas'`，自动导出。

## 鉴权 / token

### `lib/auth.ts`

- `signToken(secret, ttlMs, userId, now?)`：payload 改为 `{ sub: userId, exp }`。
- `verifyToken(secret, token, now?)`：由返回 `boolean` 改为返回 `{ userId } | null`（签名/过期/解析任一失败→`null`）。
- `COOKIE_NAME` 不变。
- 更新 `auth.test.ts`：签发/校验/过期/防篡改 + 带 sub 往返（解出的 userId 正确）。

### `plugins/requireAuth.ts`（泛化自 requireAdmin）

- `makeRequireAuth(secret, userStore)`：校验 token → 查 user → 把 `req.user = { id, username, role }` 挂上；
  token 无效或用户已被删 → 401。
- `makeRequireAdminRole()`：在 `requireAuth` 之后用，`req.user.role !== 'admin'` → 403。
- 为不破坏，保留 `plugins/requireAdmin.ts` 不动（旧文件），但全部路由改用新的 `requireAuth`。
  （旧 `requireAdmin.ts` 成为死代码，留着零风险；不在本次删除，避免无关改动。）

Fastify 类型扩展：在 `requireAuth.ts` 内 `declare module 'fastify'` 给 `FastifyRequest` 加可选 `user`。

### `routes/auth.ts`

- `POST /api/auth/login`：body `{ username, password }` → `UserStore.findByUsername` → `argon2.verify` →
  签 token（sub=user.id）→ set cookie → 返回 `{ user: { id, username, role } }`。失败 401。
- `GET /api/auth/state`：有效 token 且用户存在 → `{ user: {...} }`；否则 `{ user: null }`。
- `POST /api/auth/lock`：清 cookie，返回 `{ user: null }`。
- `POST /api/auth/unlock`（**兼容别名**）：body `{ password }`，按 `ADMIN_USERNAME` 这个用户校验口令，
  成功等价于以 admin 登录（旧前端只发口令时仍能用）。

## 授权（轻量，只为干净视图）

### 纯函数 `lib/authz.ts`

```
canSeeProject(user: { id; role }, project: { ownerId? }): boolean
  = user.role === 'admin' || project.ownerId === user.id
```
单测覆盖：admin 看任意、owner 看自己、非 owner 看不到、ownerId 缺失时仅 admin 可见。

### 路由接线

- `routes/projects.ts`：全部加 `requireAuth`。
  - `GET /api/projects`：`load().filter(p => canSeeProject(req.user, p))`。
  - `GET /api/projects/:id`：取到后 `canSeeProject` 不通过 → **404**（不暴露存在性）。
  - `POST /api/projects`：`ownerId = req.user.id`；若 `req.user.role==='admin'` 且 body 带 `ownerId`，用 body 的。
  - `DELETE /api/projects/:id`：取到后校验可见性，不可见 → 404。
- `sessions.ts` / `chat.ts` / `files.ts` / `taskEvidence.ts`：取到 project 后 `canSeeProject` 不通过 → 404 / WS close。
  - REST 用 `requireAuth` preHandler；WS 在握手里 `verifyToken` 解出 userId → 查 user → `canSeeProject`，不行就 `socket.close`。
- `fs.ts` 的 `/api/fs/dirs`：只需登录态（任意登录用户可浏览目录以新建自己的项目）→ 用 `requireAuth`（不加 admin）。

会话 REST/WS **逻辑完全不动**，只在前面加「项目可见」这一道闸。

## context / config

### `config.ts`

- 新增 `usersConfigPath`（与 projects.json 同目录的 `config/users.json`）。
- 新增 `ADMIN_USERNAME`（env，默认 `admin`）。

### `context.ts`

- 构建 `UserStore`。
- **首次启动若 users.json 为空**（`count()===0`）：用现有 `ADMIN_PASSWORD` / `ADMIN_PASSWORD_HASH` 播种一个 admin：
  username=`ADMIN_USERNAME`，role=`admin`，passwordHash=已有 hash 或现算。之后 users.json 即唯一来源。
- `ProjectStore.migrate(adminId)`：把缺 `ownerId` 的存量项目回填为 admin.id（原子写，幂等）。
- 把 `users`（UserStore）暴露到 `AppContext`。`adminHash` 字段保留（unlock 别名仍可能用），但登录主路径走 UserStore。

## 前端

- `lib/api.ts`：
  - `login(username, password) → { user }`；`authState() → { user: AuthUser | null }`；`lock()`。
  - 保留 `unlock(password)`（兼容）。
  - admin 用户 CRUD：`adminListUsers()`、`adminAddUser({username,password,role})`、
    `adminSetPassword(id, password)`、`adminDeleteUser(id)`，对应 `/api/admin/users` GET/POST/PATCH/DELETE。
- `Login.tsx`：加用户名输入（默认填 `admin` 方便），调 `login`。
- `App.tsx`：保存当前 `user`；`authState` 改读 `{user}`；按 `user.role==='admin'` 决定是否给 ProjectList 传「用户管理」入口。
- `ProjectList.tsx`：列表已由后端过滤；admin 视图给每行显示 owner 标签（拿 users 映射 ownerId→username）；
  顶部加「用户管理」按钮（仅 admin）。
- 新增 `components/UserAdmin.tsx`：列用户、加用户（用户名+口令+角色）、改口令、删用户。手机友好，沿用现有 `.input/.btn/.field` 风格与 `themes/tokens.css`。
- `routes/admin.ts`（新）：`/api/admin/users` CRUD，preHandler `[requireAuth, requireAdminRole]`；`app.ts` 注册。
  - POST：argon2 哈希口令后 `UserStore.add`。
  - PATCH `/:id`：改口令（argon2 哈希后 setPassword）。
  - DELETE `/:id`：删用户；**禁止删除最后一个 admin**（防自锁）。

## 测试（TDD，先红后绿）

纯逻辑单测：
- `lib/auth.test.ts`：token 带 sub 往返、过期、篡改。
- `lib/users.test.ts`：add/load/findByUsername/setPassword/remove/重复名/.bak/count。
- `lib/authz.test.ts`：canSeeProject 全分支。
- `lib/projects.test.ts`：新增 `migrate` 回填 ownerId、幂等、不覆盖已有 owner。
- `packages/shared/src/schemas.test.ts`：UserSchema/RoleSchema、Project 带 ownerId 仍合法、缺 ownerId 仍合法。

集成（app.test.ts 风格，inject 注入 context）：
- 未登录 401；`login` 错误口令 401、正确拿 cookie；带 cookie `state` 返回 user；
- 普通用户与 admin 的 `/api/projects` 视图不同；
- admin 建用户、普通用户登录可用；非 admin 调 `/api/admin/users` 403。

真实验证（curl，端口取 `.env` 的 PORT=6325）：
health → admin login 拿 cookie → state 应为 admin → admin 建测试用户 → 该用户登录 →
两账号 `GET /api/projects` 不同视图。

## 不做 / 边界

- 不做密码强度策略、登录限流、找回口令（应用层账号，非安全边界）。
- 不做会话归属、项目分享、跨用户可见。
- 不动 tmux / claude / 聊天 / 终端 / 文件 / task 引擎本身。
- 不删除旧 `requireAdmin.ts`（留作零风险死代码，避免无关改动）。
