# 多用户 unix 隔离 + 子用户 设计

日期：2026-06-23

## 背景与定调

`2026-06-21-multi-user-auth-design.md` 引入了**应用层多用户**（用户名 + 口令 + 角色，按 owner 过滤项目视图），但明确**不是安全边界**：底层仍是同一个 unix 进程跑同一个 `claude`，磁盘文件 owner 全是宿主 unix 用户。

现在要把它升级成**真正的多用户**：

- 每个 rcc 主账号绑定一个本机真 unix 用户，tmux/claude/fs 命令以该 unix 用户 uid 执行 → 创建的文件 owner 是各自的、claude 进程读到的 `~/.claude/` 是各自的。
- 一个 rcc 主账号下可有 N 个**子用户**，子用户独立用户名/口令登录，unix 身份继承父主账号，会话/项目/文件夹等按子用户 namespace 分。
- "用别人的 claude" 通过**做别人的子用户**来表达，而不是引入"共享 claude 配置"机制（后者复杂、攻击面大；显式从范围里砍掉）。

## 已和上一版多用户设计的关系

- 上一版"应用层账号、口令登录、按 owner 过滤项目"的能力**全部保留**，不破坏现有可用功能（项目硬要求 ①）。
- 上一版 `User` schema 增加 `unixUser` 字段（可选→兼容存量），存量记录由迁移逻辑回填为运行 rcc 服务进程的 unix 用户名（即"现在 rcc 跑在谁下，存量用户就归谁"），行为零变化。
- 新增 `SubUser` 概念与 `SubUserStore`，与 `UserStore` 同风格（显式 JSON + 原子写 + `.bak`）。
- 鉴权层 `requireAuth` / `resolveUser` 扩展支持子用户登录；下游路由统一拿 `req.user` 的"有效身份" + namespace。
- 项目 / 会话 / 文件夹 / 标星 / 上传等的 `ownerId` 字段**语义改为 namespaceId**，对主账号登录 namespaceId = userId，对子用户登录 namespaceId = subUserId。`canSeeProject` 改成按 namespaceId 比对。

## 已显式不做（已和用户对齐）

- **共享 claude 配置（share 模式）**：不引入 `claudeIdentity` 字段、不做 `/srv/rcc/claude-share/`、不做 ACL/publish/systemd timer。想"用别人的 claude"就走子用户（unixUser 继承别人）。
- **1:1 模型变体（每个 rcc 账号都独立 unix）**：本设计不主动支持，但天然兼容——只要不开子用户、每个主账号绑不同 unix 用户即可。
- **容器/namespace 隔离、setuid worker、主进程 root**：复杂度不划算，本设计不走。
- **跨主账号资源共享/分享/组织**：不做（不是安全边界但也不是协作平台）。

## 三层身份模型

```
┌─ Unix 层 ──────────────────────────────────────────────┐
│  /etc/passwd 上真实存在的账户:                          │
│    wangleyan (uid=1000)                                 │
│    zhangsan  (uid=1001)                                 │
│    lisi      (uid=1002)                                 │
│  各自的 ~/.claude/(订阅/token/settings/hooks)互不相关   │
│  ssh 进来手动 `claude` 用的就是这层,跟 rcc 无关         │
└────────────────────────────────────────────────────────┘
                ↓ rcc 主账号 1:1 绑定 unix 用户
┌─ rcc 主账号层(users.json) ────────────────────────────┐
│  {                                                       │
│    id: "u-zs",                                          │
│    username: "zhangsan",                                │
│    passwordHash: "...argon2...",                        │
│    role: "user",                                        │
│    unixUser: "zhangsan",   ← 本次新增,必填(admin 配置)│
│    ...                                                   │
│  }                                                       │
│                                                          │
│  unixUser 决定 tmux/claude/fs 调用的 sudo -u 目标       │
│   → 进程 uid → 创建文件的 owner                         │
│   → claude 读到的 ~/.claude/(即 owner 自己的家)         │
└────────────────────────────────────────────────────────┘
                ↓ 子用户 N:1 挂到主账号
┌─ 子用户层(subusers.json,本次新增) ───────────────────┐
│  {                                                       │
│    id: "u-zs-dev",                                      │
│    parentId: "u-zs",                                    │
│    username: "zs_dev",                                  │
│    passwordHash: "...argon2...",                        │
│    displayName: "开发",                                 │
│    createdAt: "..."                                     │
│  }                                                       │
│                                                          │
│  独立用户名/口令登录;unix 身份继承父(不可改)            │
│  角色继承父(子用户不能比父更高权限)                     │
│  会话/项目/文件夹/标星按 namespace 分,namespace = 自己id│
│  unix 层零隔离:父主账号 + 全部子用户共用同一 uid        │
└────────────────────────────────────────────────────────┘
```

## 数据模型变更

### `UserSchema`（`packages/shared/src/schemas.ts`）

新增字段：

```
unixUser: z.string().min(1).optional()
```

- **必填**的语义在路由层强制（POST/PATCH 用户接口要求 admin 显式传），但 schema 上为 optional 以兼容存量。
- context 迁移时给缺 `unixUser` 的存量记录回填为 `os.userInfo().username`。

### `SubUserSchema`（新增）

```
SubUserSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1),       // 指向 UserSchema.id
  username: z.string().min(1),       // 在全局(含主账号)命名空间唯一
  passwordHash: z.string().min(1),
  displayName: z.string().min(1).max(40),
  createdAt: z.string(),
  // 子用户偏好独立(空闲自动关闭等);跟 User.settings 同形,默认值一致
  settings: z.object({
    idleCloseHours: z.number().int().min(0).max(48).default(3),
  }).default({ idleCloseHours: 3 }),
})
SubUser = z.infer<typeof SubUserSchema>
```

**用户名全局唯一性强制**：`SubUserStore.add()` 在写盘前同时查 `UserStore.findByUsername` 与 `SubUserStore.findByUsername`，任一命中即拒绝。`UserStore.add()` 反向亦然（既查自己也查 SubUserStore）。这要求两个 store 互相持有引用——在 context 构建时注入。

### `AuthUserSchema`（脱敏当前用户，给前端 + 鉴权挂载用）

```
AuthUserSchema = z.object({
  id: z.string().min(1),                              // 子用户登录则 = subUser.id;主账号 = user.id
  username: z.string().min(1),
  role: RoleSchema,                                   // 子用户继承父的 role
  kind: z.enum(['user', 'subuser']),                  // 新增:区分两种身份
  parentId: z.string().min(1).optional(),             // kind=subuser 时存在
  unixUser: z.string().min(1),                        // 新增:有效 unix 用户名
  namespaceId: z.string().min(1),                     // 新增:资源归属 key(主账号=id;子用户=id)
})
```

下游路由统一用 `req.user.namespaceId` 替代原本的 `req.user.id`。`req.user.unixUser` 用于命令包装。

### `ProjectSchema` / `ConversationSchema` / `FolderSchema`

`ownerId` 字段字面不动，但**语义**从"user.id"改为"namespaceId"。runtime 行为：

- 主账号 `wangleyan` 创建的项目 ownerId = `u-wly`
- 子用户 `zs_dev` 创建的项目 ownerId = `u-zs-dev`（而不是 `u-zs`）
- 同父主账号下的另一个子用户 `zs_rs` 看不到 `zs_dev` 创建的项目（按子用户分的最严意义；和用户拍板一致）

## 鉴权层（`lib/auth.ts` / `plugins/requireAuth.ts`）

`signToken` / `verifyToken` 的 token payload 不变（仍是 `{ sub, exp }`），但 **sub 现在可能是 user.id 也可能是 subUser.id**。

`resolveUser` 改为：

```
function resolveUser(secret, users, subUsers, token): AuthUser | null {
  const payload = verifyToken(secret, token);
  if (!payload) return null;
  const u = users.get(payload.sub);
  if (u) return toAuthUser(u);            // 主账号路径
  const su = subUsers.get(payload.sub);
  if (su) {
    const parent = users.get(su.parentId);
    if (!parent) return null;             // 父被删,子用户失效
    return toAuthUserFromSub(su, parent); // unixUser/role 继承父
  }
  return null;
}
```

`POST /api/auth/login`（`routes/auth.ts`）：

- 收到 `{ username, password }`。
- 先查 `UserStore.findByUsername`，匹配 + argon2.verify 成功 → 主账号登录，sub = user.id。
- 再查 `SubUserStore.findByUsername`，匹配 + argon2.verify 成功 → 子用户登录，sub = subUser.id。
- 都不匹配 → 401。

`POST /api/auth/unlock`（兼容别名）：仍按 admin 主账号处理，不接受子用户。

## 命令包装（核心：sudo wrapper）

### 设计目标

- 单一注入点：所有"会引起 unix 副作用"的命令调用统一过一个 `runAs(unixUser, file, args)` 工具。
- **零开销路径**：当目标 unixUser === 当前进程的 `os.userInfo().username` 时直接 exec，不走 sudo。这保证现有单 unix 用户场景下行为不变。
- 跨 unix 路径：拼成 `sudo -n -u <unixUser> -- <file> <args...>`（`-n` non-interactive，配错 sudoers 立刻失败而不挂起）。
- 可注入 fake：`runAs` 接受 `ExecFn`，单测用 fake 验证拼装。

### `lib/session/runAs.ts`（新增）

```
export interface RunAsDeps {
  exec: ExecFn;                          // 复用 tmux.ts 的 ExecFn 类型
  currentUser: string;                   // 默认 os.userInfo().username,测试可注入
}

export function makeRunAs(deps: RunAsDeps) {
  return function runAs(unixUser: string, file: string, args: string[]) {
    if (unixUser === deps.currentUser) {
      return deps.exec(file, args);
    }
    return deps.exec('sudo', ['-n', '-u', unixUser, '--', file, ...args]);
  };
}
```

### `Tmux` 改造（`lib/session/tmux.ts`）

每个 `Tmux` 实例**绑定一个 unixUser** + socket 名按 unixUser 派生：

```
new Tmux({
  socket: `rcc-${unixUser}`,            // 按 unix 用户分 socket
  unixUser,
  runAs,                                 // 注入
})
```

`exec(...)` 内部全部替换为 `runAs(unixUser, 'tmux', args)`。`Tmux.sessionName(...)` 不变。

由于 `Tmux` 现在按 unixUser 实例化，`AppContext` 改为持有 `getTmux(unixUser: string): Tmux`（内部 lazy `Map` 缓存）。下游按 `req.user.unixUser` 取。

`AppContext` 字段调整：

```
{
  ...
  getTmux: (unixUser: string) => Tmux,              // 替代原 tmux: Tmux
  askLaunchFor: (unixUser: string) => AskLaunch,    // 替代原 askLaunch: AskLaunch
  // 其余 store / registry 不变
}
```

`SessionRegistry`（终端会话）的 `makeRealBridgeFactory` 改为接受 `getTmux` 而非单例 Tmux；在握手时（已知 unixUser）解析具体 Tmux 实例后再构造 bridge。

`ChatRegistry` 的工厂签名扩展：spec 加 `unixUser`，工厂内部用 `getTmux(spec.unixUser)` + `askLaunchFor(spec.unixUser)`。

`IdleSweeper` 同样改为接受 `getTmux`，对每个会话按其 unixUser 路由发 `kill-session`。

不动 `chatSession.ts` / `paneScraper.ts` / `transcript.ts` 内部——它们只依赖注入进去的 Tmux 实例。

### claude 启动命令（`lib/session/chat/launch.ts` + `chatSession.ensure`）

`buildClaudeCmd` 不变（它输出的是 bash 命令字符串），关键在 `tmux new-session` 的封装：

- `cwd` 仍是 project.path（子用户与父共用 project，path 在父的家目录里没问题；跨主账号的 project 由项目添加时 admin 设定，不可能跨 unix）。
- `-c <cwd>` 必须是目标 unixUser 可读可进入的目录（path 在 admin 录入项目时 stat 校验过；增加一条校验：`path` 必须在目标 unixUser 可达的范围内 —— 见 sudoers 段对 stat 的白名单）。
- `bash -ic <cmd>` 让 bash 加载目标 unixUser 自己的 `.bashrc`（`Fable-yolo` 别名走对方的；这是原生体验所必需）。
- `HOME` 由 sudo 默认行为切到目标 unixUser 的家（`sudo -u zhangsan` 默认带 `-H` 等价行为，但稳妥起见显式加 `-H`：`sudo -nH -u <unixUser>`，确保 `~/.claude/` 解析到 `/home/zhangsan/.claude/`）。

### IdleSweeper（`lib/session/idleSweeper.ts`）

`listAllAlive()` 返回所有 unix 用户的会话；sweeper 按 `getTmux(unixUser)` 路由到对应 `Tmux` 实例发 `kill-session`。activity 检测的几个信号（transcript mtime / askDir / statusline / pane hash）：

- transcript / askDir / statusline 路径都按 unix 用户解析（见下节"路径与 sidecar"），sweeper 也按 unix 用户解析。
- pane hash 通过 `getTmux(unixUser).capturePaneVisible(name)` 取，自动走 sudo。

### File 浏览 / 上传（`lib/files.ts` / `routes/files.ts` / `routes/chat.ts`）

文件浏览的 `listFiles` / `readFile`：

- 当前实现直接用 `fs.readdirSync` / `fs.readFileSync`。改为通过 `runAs(unixUser, 'stat'|'cat'|'ls', ...)` 拿 metadata，再用 `runAs` 取文件内容。
- 兼容性顾虑：node `fs` 直接调系统调用，性能比 spawn 高很多；改为 sudo + 命令行工具有开销。**优化**：当 unixUser === currentUser 时仍走 node `fs`（零开销路径覆盖单用户场景）。跨 unix 才走 sudo。

聊天图片上传（`POST /api/projects/:pid/conversations/:cid/uploads`）：

- 当前把 base64 文件落在 `<project>/.rcc-uploads/`。需要让 owner 是目标 unixUser。
- 同样走 zero-overhead 优化：currentUser 时直接写；跨 unix 时 `runAs(unixUser, 'tee', [path])` 或 `runAs(unixUser, 'cp', [tmpPath, finalPath])` 中转一次。

### 不动的部分

- `chatSession.ts`、`ChatRegistry`、`TranscriptTail`、`paneScraper`、`askSidecar`、Ask hook 注入逻辑：完全不动。它们只依赖注入进去的 `Tmux` 实例，自然带上 unix 隔离。
- 聊天 HUD、聊天 WS、终端 WS：不动。
- `IdleSweeper` 的判定逻辑：不动，只换路径解析。

## 路径与 sidecar

`config.ts` 现有路径全都"挂在 repoRoot/data/ 下"，单用户场景下没问题。多用户下要按 unix 用户子目录分：

| 路径 | 现状 | 多用户下 |
|---|---|---|
| `askDir`（`RCC_ASK_DIR`） | `<repoRoot>/data/rcc-ask/` | `<repoRoot>/data/rcc-ask/<unixUser>/` |
| `statuslineDir`（`RCC_STATUSLINE_DIR`） | `<repoRoot>/data/rcc-statusline/` | `<repoRoot>/data/rcc-statusline/<unixUser>/` |
| `ask-hooks.settings.json` 落点 | `<askDir>/ask-hooks.settings.json` | `<askDir>/<unixUser>/ask-hooks.settings.json`（即每个 unix 用户独立一份 settings 副本） |

**为什么按 unix 用户分**：sidecar 文件是被 hook 进程（claude 子进程，跑在 unixUser 下）写的，跨 unix 互写会撞权限；按 unix 用户分子目录让每个 unix 用户独占自己那块。子用户之间共享父的 unix 子目录（因为 unix 身份相同）——这一致地体现了"unix 是硬边界，子用户在 unix 之内是软隔离"的原则。

**实现**：

- `config.ts` 暴露 `askDirFor(unixUser)` / `statuslineDirFor(unixUser)` helper，等价于 `path.join(baseDir, unixUser)`，并在用到前 `mkdir -p`（用 `runAs` 以目标用户身份创建，确保 owner 对）。
- `ensureAskHookSettings` 接收 `askDir`（已含 unixUser），落点不变（脚本内部仍是 `<askDir>/ask-hooks.settings.json`）。
- `askLaunchExtra` 由 `chatRegistry` 在每次创建 `ChatSession` 时按 spec.unixUser 生成（替代 `context.askLaunch` 全局单例）。
- `ChatRegistry` 的工厂签名扩展 spec，加 `unixUser`。

`FS_BROWSE_ROOT`：

- 现状是单一 env，例如 `/home/wangleyan/projects`。
- 多用户下逻辑改：browse 根 = **目标 unixUser 的 `FS_BROWSE_ROOT`**，从 env `RCC_FS_BROWSE_ROOT_<UNIXUSER>` 读，缺省回退到 `~<unixUser>/projects`（即对方家目录的 projects 子目录）。
- 也可用 `.env` 一条 `FS_BROWSE_ROOT_MAP=zhangsan:/home/zhangsan/proj,lisi:/srv/lisi-work`。**选简单**：用前者（per-user env），约定 home/projects 兜底。

## 路由层 namespace 过滤

### `lib/authz.ts`

`canSeeProject` 改成按 `namespaceId`：

```
canSeeProject(user, project) =
  user.role === 'admin' || project.ownerId === user.namespaceId
```

### 资源创建

- `POST /api/projects`：`ownerId = req.user.namespaceId`（admin 仍可传 body.ownerId 指派给任意 namespaceId）。新增校验：admin 必须把 project.path 选在某 unix 用户可达的范围（这一条放到 admin 路由层，普通用户路径上 ownerId 强制是自己 namespaceId，跨 unix 不可能）。
- `POST /api/projects/:pid/conversations`：会话不带独立 ownerId（继承项目）。
- `POST /api/projects/:pid/folders`：folder.ownerId = `req.user.namespaceId`。

### `req.user.unixUser` 使用点

| 地方 | 怎么用 |
|---|---|
| `routes/sessions.ts` / `routes/chat.ts` 拉起会话 | 取 `getTmux(req.user.unixUser)` |
| WS 握手（终端 / 聊天） | 同上;ws 在 verifyToken 之后从 user 解出 unixUser |
| `routes/files.ts` | 走 `runAs(req.user.unixUser, ...)` |
| `routes/chat.ts` 上传 | 同上 |
| reflow 路由 | `getTmux(unixUser)` + 传给 `buildClaudeCmd` 不变 |

## sudoers 配置规范

文件：`/etc/sudoers.d/remote-cc`（**不进 git**；由部署者按本机情况配，仓库内放 `deploy/sudoers.remote-cc.example`）。

```
# 服务跑在哪个 unix 用户(运行 ./start.sh 的人),把它当 ServiceUser
# 这里以 wangleyan 为例
wangleyan ALL=(zhangsan,lisi) NOPASSWD: \
  /usr/bin/tmux, \
  /usr/local/bin/claude, \
  /usr/bin/stat, \
  /usr/bin/cat, \
  /usr/bin/ls, \
  /usr/bin/find, \
  /usr/bin/tee, \
  /usr/bin/cp, \
  /usr/bin/mkdir

# 不允许 root 目标、不开 ALL=(ALL)、不开通配,严格命令路径白名单。
```

**安全考量**：

- 命令路径用绝对路径，避免 PATH 攻击。
- `mkdir` 进入白名单是为了 `mkdir -p` sidecar 目录（per-user）。
- `find` 进入白名单是为了 `locateTranscript` 跨 `~/.claude/projects/` 搜索；落点是确定的 sessionId 文件名，无 shell 注入面（runAs 走 execFile，不过 shell）。
- 不开 `bash` 或 `sh`：`bash -ic` 仍由 tmux 在目标 uid 下运行，**不是** 通过 sudo 直接执行；sudo 这里只跑 tmux 二进制本身，bash 是 tmux fork 出来的子进程。
- `tee` 进白名单为图片上传走 `runAs` 写文件。

**部署文档**（项目根 `README.md` 新增"多用户部署"章节）会列出：

1. 用 `useradd` 在本机建好目标 unix 用户。
2. 在 `/etc/sudoers.d/remote-cc` 按本机 claude 二进制路径填白名单（用 `which claude` 找出）。
3. `visudo -c -f /etc/sudoers.d/remote-cc` 校验。
4. 在 rcc 管理 UI 给主账号填 `unixUser`。

## 子用户管理 API + UI

### 后端 `routes/admin.ts` 扩展

```
GET    /api/admin/subusers            // admin 看全部;非 admin 看自己父下的(给主账号自己管子用户)
POST   /api/admin/subusers            // body: { parentId, username, password, displayName }
PATCH  /api/admin/subusers/:id        // body: { password? | displayName? }
DELETE /api/admin/subusers/:id        // 删子用户;不级联删子用户名下的资源,只让它们"无主"
```

### 自助改口令（子用户与主账号通用）

```
PATCH  /api/me/password               // body: { oldPassword, newPassword }
```

- 主账号登录改 UserStore；子用户登录改 SubUserStore；oldPassword 必须验证通过。
- 子用户不能改父主账号口令，反之亦然。
- 已有 `/api/me/settings` 同样要支持子用户（写 SubUserStore.updateSettings）。

权限规则：

- `admin role` 看/管所有子用户。
- 主账号 user（非 admin）看 / 管自己的子用户（parentId === self.id）。
- 子用户登录不能再开子用户（防止递归），路由层拒绝。

### `apps/web/src/components/UserAdmin.tsx`

- 列表加 `unixUser` 列。
- 主账号每行下方可展开列出其子用户，admin 可加 / 改密 / 删。
- 新增主账号 form 加 `unixUser` 输入框（必填）。

### `apps/web/src/components/SubUserAdmin.tsx`（普通用户视角）

非 admin 主账号登录后侧栏多一个"我的子用户"入口，能管自己的子用户。

## 迁移策略

context 启动时：

1. `users.migrate()`（新增方法）：给所有缺 `unixUser` 字段的存量用户回填 `os.userInfo().username`（运行服务的当前 unix 用户）。这意味着部署升级后**所有现有 rcc 用户继续以 ServiceUser 身份跑**，零行为变化。admin 想"真隔离"时手动改 `unixUser` 字段并配 sudoers。
2. `projects.migrate(adminId)`：原有逻辑保留（缺 ownerId → admin.id）。**额外**：把 ownerId 已经是某存量 user.id 的项目，由于 namespaceId 语义变化但 user.id === namespaceId（主账号场景），无须改。子用户场景的项目本就是这次新引入的，不存在存量。
3. `conversations.migrate()`：不动（不涉及 ownerId）。
4. `folders` 现有 `ownerId` 字段：跟 conversations 类似，继承自创建时的 user.id；主账号场景 user.id === namespaceId，零迁移。
5. sidecar 路径迁移：启动时若发现 `<askDir>/` 下有非 `<unixUser>` 子目录的存量 sidecar，**就地保留**（不移动），新会话直接落到 `<askDir>/<unixUser>/`。旧 sidecar 是上一次崩溃残留，无业务价值。

## 测试策略

遵循项目 TDD 纪律：测试与源码共置，`*.test.ts`，纯逻辑单测，IO 用 fake。

### 新增单测

- `lib/session/runAs.test.ts`：currentUser → 直 exec、跨 unix → 拼 `sudo -nH -u`、注入失败错误透传。
- `packages/shared/src/schemas.test.ts` 扩展：`UserSchema` 带 `unixUser` 仍合法、缺 `unixUser` 仍合法（兼容存量）；`SubUserSchema` round-trip；`AuthUserSchema` 新字段（kind/parentId/unixUser/namespaceId）。
- `lib/subUsers.test.ts`（新文件）：add/load/findByUsername/setPassword/remove/.bak/全局唯一 username（含与主账号冲突的拒绝）。
- `lib/auth.test.ts` 扩展：token sub 既可能是 userId 也可能是 subUserId，verifyToken 不区分（payload 只验签名）。
- `lib/authz.test.ts` 重写：`canSeeProject` 按 namespaceId 全分支（admin 看全部、namespaceId 匹配、不匹配、project 缺 ownerId）。
- `lib/users.test.ts` 扩展：`migrate(fallbackUnixUser)` 回填、幂等。
- `lib/session/tmux.test.ts` 扩展：实例化时绑定 unixUser → socket 名 `rcc-<unixUser>`、argv 头改变；newDetachedArgs 不变（runAs 在 exec 层包，argv 拼装本身不动）。

### 集成测试（`apps/server/src/app.test.ts` 风格）

- 子用户登录拿 token；子用户视角 `/api/projects` 视图与父主账号视图不同；admin 仍看全部。
- 子用户 POST 项目 → ownerId === subUser.id；同父另一个子用户 GET 项目列表看不到。
- 子用户不能管子用户（POST `/api/admin/subusers` 403）。
- token 解析路径：sub 不存在（用户被删）→ 401；sub 是 subUser 但 parent 被删 → 401。

### 真实集成冒烟（项目硬要求 ②）

新写 `apps/server/scripts/smoke-multiuser.ts`（在 staging 节点跑）：

1. `useradd rcc-test1 rcc-test2`（脚本 doc 提示手动准备）；
2. 装 sudoers 测试副本；
3. rcc admin 建两个主账号 `t1/t2` 绑定上述 unix 用户；
4. 各登录、各建项目、各开会话、各发一条 echo prompt；
5. 跑完后用 `ls -la` 验证两边 cwd 下创建的文件 owner 不同；
6. 各自的 transcript 在各自 `~/.claude/projects/` 里；
7. 跨用户 GET 项目列表确实不可见。

## 不破坏现有功能的复核（项目硬要求 ①）

| 现有功能 | 受影响吗？ | 保护方式 |
|---|---|---|
| 现有单 unix 用户的 admin 跑 claude | 否 | `unixUser` 缺省回填为 ServiceUser；`runAs` 零开销路径直 exec |
| 终端视图（xterm 直传 TUI） | 否 | `SessionRegistry` 拿 `getTmux(user.unixUser)`,其余不动 |
| 聊天视图（流式 + transcript） | 否 | `ChatSession` 不动,只换注入的 Tmux 实例 |
| `--resume` / 软删除 / 标星 / 文件夹 / 多选 / IdleSweeper / HUD | 否 | 全部基于注入,自然继承 |
| 现有用户登录路径 | 否 | login 先查 UserStore,完全等价 |
| `/api/auth/unlock` 兼容别名 | 否 | 不动 |
| 现有 sidecar 路径 | 否 | 启动时不移动旧 sidecar;新会话写新路径 |
| 现有项目可见性（owner 过滤） | 否 | 主账号 namespaceId === user.id,行为等价 |

## 不做 / 边界

- 不做 share 模式（共享别人 claude 配置）：见"已显式不做"。
- 不做密码强度、登录限流、找回口令：上一版多用户结论沿用。
- 不做跨账号资源分享 / 协作 / 组织。
- 不动 tmux / 聊天引擎 / 终端 / task / evidence 核心。
- 不删旧的 `requireAdmin.ts` 死代码（上一版结论沿用）。
- 不内置部署/隧道方案；sudoers / useradd 由部署者按本机办（README 给 example）。

## 配置 / 环境变量新增

```
# 服务运行的 unix 用户(用于 runAs 的零开销判断)。
# 默认 = os.userInfo().username,显式覆盖罕见,但留作 escape hatch。
RCC_SERVICE_USER=wangleyan

# per-unix-user 浏览根。缺省回退 ~<user>/projects。
# 举例:
RCC_FS_BROWSE_ROOT_zhangsan=/home/zhangsan/work
RCC_FS_BROWSE_ROOT_lisi=/srv/lisi-projects

# claude 二进制路径(写进 sudoers 白名单时也用这条).
# 默认 'claude'(由 $PATH 解析,前提是各 unixUser 的 PATH 里都有)。
RCC_CLAUDE_BINARY=/usr/local/bin/claude
```

`.env.example` 同步加这几条注释。

## 文件/模块改动总览

| 类型 | 位置 | 说明 |
|---|---|---|
| 新文件 | `apps/server/src/lib/session/runAs.ts` | sudo wrapper |
| 新文件 | `apps/server/src/lib/subUsers.ts` | SubUserStore |
| 新文件 | `apps/server/src/lib/subUsers.test.ts` | 单测 |
| 新文件 | `apps/server/src/lib/session/runAs.test.ts` | 单测 |
| 新文件 | `apps/web/src/components/SubUserAdmin.tsx` | UI |
| 新文件 | `deploy/sudoers.remote-cc.example` | 部署样例 |
| 新文件 | `apps/server/scripts/smoke-multiuser.ts` | 冒烟 |
| 改 | `packages/shared/src/schemas.ts` | User 加 unixUser、SubUserSchema、AuthUser 扩展 |
| 改 | `apps/server/src/lib/users.ts` | 加 migrate(fallbackUnixUser) |
| 改 | `apps/server/src/lib/auth.ts` | （payload 不变,仅注释更新） |
| 改 | `apps/server/src/lib/authz.ts` | 按 namespaceId |
| 改 | `apps/server/src/plugins/requireAuth.ts` | resolveUser 支持 subUser |
| 改 | `apps/server/src/lib/session/tmux.ts` | 实例化绑 unixUser、socket 派生、exec → runAs |
| 改 | `apps/server/src/context.ts` | getTmux(unixUser)、subUsers、askLaunchFor(unixUser) |
| 改 | `apps/server/src/config.ts` | RCC_SERVICE_USER / RCC_FS_BROWSE_ROOT_<USER> / RCC_CLAUDE_BINARY |
| 改 | `apps/server/src/routes/auth.ts` | login 查 subUsers |
| 改 | `apps/server/src/routes/admin.ts` | subusers CRUD |
| 改 | `apps/server/src/routes/projects.ts` | namespaceId 过滤 |
| 改 | `apps/server/src/routes/sessions.ts` | 按 unixUser 取 tmux |
| 改 | `apps/server/src/routes/chat.ts` | 同上 + 上传走 runAs |
| 改 | `apps/server/src/routes/files.ts` | listFiles/readFile 走 runAs |
| 改 | `apps/server/src/lib/files.ts` | 同上 |
| 改 | `apps/server/src/lib/session/idleSweeper.ts` | 按 unixUser 路由 |
| 改 | `apps/server/src/lib/session/chat/askHookSettings.ts` | askDir 按 unixUser |
| 改 | `apps/server/src/lib/session/chat/chatRegistry.ts` | spec 加 unixUser |
| 改 | `apps/server/src/lib/session/chat/chatSession.ts` | 注入 unixUser-bound Tmux/askLaunch（接口扩展,内部不动） |
| 改 | `apps/server/src/lib/session/chat/launch.ts` | 注释（sudo 在 tmux 外层加） |
| 改 | `apps/web/src/lib/api.ts` | adminAddSubUser/listSubUsers/setSubUserPassword/deleteSubUser |
| 改 | `apps/web/src/components/UserAdmin.tsx` | unixUser 列 + 子用户展开管理 |
| 改 | `.env.example` | 新环境变量 |
| 改 | `README.md` | 多用户部署章节 |
| 改 | `CLAUDE.md` | 在「会话生命周期」后加「多用户身份」小节,说明三层模型 |

## 风险与回退

- **sudoers 没配/配错** → 启动后第一次跨 unix 调用直接报错（sudo `-n` 立刻失败）。回退：把 user.unixUser 改回 ServiceUser 即恢复单用户行为。
- **claude 二进制不在白名单里** → 同上。回退：visudo 修白名单 + 重启服务。
- **per-user `RCC_FS_BROWSE_ROOT_<USER>` 漏配** → fallback 到 `~<user>/projects`，目录不存在 → listFiles 报 404，前端能看到错。回退：admin 修 env + 重启。
- **存量用户 unixUser 回填错** → 启动日志打 `migrated N users with unixUser=<X>`，admin 一眼看到。回退：手改 users.json 改 unixUser。
- **WS 长连接中途 user 被删** → 现有逻辑已经处理 token 失效（401 / close 1011），扩展同步生效。

## 验收口径

- admin（默认 ServiceUser）登录 → 现有所有功能不变（包括终端、聊天、文件浏览、HUD、IdleSweeper、休眠恢复、文件夹、多选、批量、垃圾箱）。
- 新建一个 unixUser=`zhangsan` 的主账号 → 用 zhangsan 登录 → 建项目 → 开聊天会话 → AI 答完 → `ls -la <cwd>` 看到新文件 owner=zhangsan。
- 给 zhangsan 加子用户 `zs_dev`（不同口令） → 用 zs_dev 登录 → 看到自己的空项目列表（看不到 zhangsan 主账号建的）→ 自建项目 → 同样能跑、文件 owner=zhangsan。
- 跨 unix 文件浏览：admin 用 ServiceUser 不能透过 rcc 看 zhangsan 私有路径（除非 admin 把 zhangsan 项目导入到自己 namespace；这是 admin 行为，可见但 unix 层仍需 ServiceUser 有权限）。
- 拔掉 sudoers 行 → zhangsan 登录开会话立刻报错（错误信息能在前端看到，非静默挂起）。
