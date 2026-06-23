# 会话改名 设计

## 背景与诉求
会话开多了，列表里名字（默认「会话 1/2/3…」）分不清谁是谁。需要能给会话**改名字**，手机上就地改、即时生效。

## 现状
- 会话元数据存在 `ConversationStore`（`apps/server/src/lib/conversations.ts`），已有：
  - `name` 字段（`ConversationSchema` 里 `z.string().min(1)`，必填）。
  - 通用 `update(convId, patch)`（局部更新、`id` 不可改、会话不存在返回 `undefined`）。
  - 所以后端**只需加一个改名路由**复用 `update`，零新增存储逻辑。
- 多用户（应用层账号）已上线：路由用 `makeRequireAuth` 校验登录、纯函数 `canSeeProject(user, project)` 做项目可见性过滤。`routes/sessions.ts` 里现有的会话「列表/新建/删除」三个路由都已接好这套过滤。
- 前端会话列表 `apps/web/src/components/ConversationList.tsx`：每个会话一行（圆点 + 名字/状态 + 「关闭」按钮），点名字进入会话。
- 聊天顶栏 `apps/web/src/components/chat/ChatView.tsx` 直接渲染 `conversation.name`。

## 目标
1. 后端新增 `PATCH /api/projects/:id/conversations/:cid`，body `{ name: string }`，复用 `ConversationStore.update`。
2. 前端会话列表每行加「重命名」入口（铅笔图标），点击就地变输入框（预填当前名），回车/确定调用 API，成功后更新列表项名字。
3. 可选：若该会话正在聊天视图打开，改名后聊天顶栏的名字也跟着更新（前端本地同步即可，不必后端推送）。

## 非目标
- 不改多用户/HUD 等无关代码。
- 不引入新依赖。
- 不做后端→前端的实时推送（其它打开端的同步靠现有 5s 轮询自然刷新）。

## 后端设计
位置：`apps/server/src/routes/sessions.ts`，与现有会话路由并列。

```
PATCH /api/projects/:id/conversations/:cid
  preHandler: requireAuth                     // 未登录 → 401
  body: { name: string }
```

校验与流程（与同文件其它会话路由完全一致的顺序）：
1. `project = ctx.projects.get(id)`；若 `!project || !canSeeProject(req.user!, project)` → **404**（项目不存在或不可见，对外一视同仁，不泄露存在性）。
2. body 用 zod 校验：`name` trim 后非空、长度 ≤ 60；不合法 → **400**。
3. `conv = ctx.conversations.get(cid)`；若不存在或 `conv.projectId !== id` → **404**。
4. `updated = ctx.conversations.update(cid, { name })`（存 trim 后的值）。
5. 返回 `{ conversation: { ...updated, alive } }`，`alive` 用本文件已有的存活判定（`tmux.listSessions()` 命中 `tmuxName` 或 `registry.isActive(cid)`）。

zod schema：
```ts
const RenameConvSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
```
注：`z.string().trim()` 会先 trim 再校验长度，返回的 `parse.data.name` 即已 trim。

`alive` 复用：现有 `withAlive(projectId)` 返回整列表；为单条改名加一个小辅助 `aliveOf(conv)`（取一次 `listSessions` set 判定），或直接内联。倾向加内联判定，避免为一条记录拉全列表语义混淆——但实现时若 `withAlive` 已足够简单，可直接复用其判定逻辑（`alive.has(tmuxName) || registry.isActive(cid)`）。

## 前端设计

### api.ts
新增：
```ts
renameConversation: (pid: string, cid: string, name: string) =>
  req<{ conversation: Conversation }>('PATCH', `/api/projects/${pid}/conversations/${cid}`, { name }),
```

### ConversationList.tsx
每行在「关闭」前加一个「重命名」铅笔按钮（`btn ghost sm`）。点击进入该行的编辑态：
- 用 `editingId: string | null` + `draft: string` state 记录当前在编辑哪一行、输入值。
- 编辑态下，名字区域换成 `<input class="input">`（预填当前名，自动聚焦、selectAll），右侧「重命名」换成「保存/取消」。
- 提交：trim 后非空且与原名不同才调 API；调用 `api.renameConversation` 成功后本地把该行 `name` 更新、退出编辑态；失败静默（或 `console`），保持编辑态。
- 交互：回车提交、Esc 取消、失焦提交（手机友好）。空名直接取消（不发请求）。
- 进入编辑态时阻止 `onOpen`（点输入框不应进入会话）。

为把改名结果同步给聊天顶栏，`ConversationList` 的 `onOpen` 仍传整个 `Conversation`；改名只更新列表本地，不影响已打开会话——可选增强见下。

### 可选：聊天顶栏同步
当前 `ProjectDetail` 持有 `openConv` 并把它传给 `ChatView`。最简做法：
- 给 `ConversationList` 加可选回调 `onRenamed?(cid, name)`；`ProjectDetail` 实现它，若 `openConv?.id === cid` 则 `setOpenConv({...openConv, name})`。
- 但通常改名时会话列表是在「未打开会话」的列表页（打开会话后是全屏聊天/终端，看不到列表）。所以同步价值有限——按「容易就做」原则：实现 `onRenamed` 回调更新 `ProjectDetail.openConv`，成本极低，顺手做。

## 测试（TDD，先红后绿）
后端路由测试，新增文件 `apps/server/src/routes/sessions.rename.test.ts`（与 `app.test.ts` 同风格，用 `buildApp` + `app.inject` + cookie）：
1. **成功改名**：admin 建项目→建会话→PATCH 新名→200 且返回 `conversation.name === 新名`；再 GET 列表确认已变。
2. **空名 400**：PATCH `{ name: '   ' }`（纯空白）→ 400。
3. **超长 400**：PATCH `{ name: 'x'.repeat(61) }` → 400。
4. **不可见项目 404**：alice 建项目+会话；bob（或 admin 建的另一普通用户）PATCH → 404。
5. **会话不存在 404**：admin 对存在的项目、伪造 cid PATCH → 404。
6. （顺带）**未登录 401**：无 cookie PATCH → 401。

测试环境下 tmux 无 server，`listSessions()` 返回 `[]`、`registry.isActive` 返回 `false`，故 `alive` 恒 `false`，不影响断言。

## 真实验证
`./start.sh --no-build`（仅后端改动可走快重启；但前端也改了 → 用 `./start.sh` 重建）。
curl 闭环（admin 登录拿 cookie，PORT 6325）：
1. 登录 → cookie。
2. GET 某项目会话列表 → 取一个 cid 与原名。
3. PATCH 改名 → 看返回 `conversation.name`。
4. 再 GET 列表 → 确认名字变了。
5. PATCH 空名 → 期望 400。
不打印口令。
