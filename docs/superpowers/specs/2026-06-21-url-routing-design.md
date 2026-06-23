# URL 路由（多级地址 + 刷新恢复 + 可分享深链）— 设计

## 背景与问题

当前整个应用是**单 URL + `useState` 导航**：

- `App.tsx` 用 `useState<View>`（`projects` / `project` / `metrics`）切顶层页面。
- `ProjectList` 内部用 `managing` state 渲染 `UserAdmin`。
- `ProjectDetail` 内部用 `tab`（sessions/files/tasks）+ `openConv` + `view`（chat/terminal，`localStorage` key `rcc:view:<convId>` 记忆）渲染 `ChatView`/`Terminal`。

后果：浏览器**刷新 / 前进 / 后退**就回到主页，得重新一层层点进去；也无法把"某会话的聊天视图"这种深层位置作为 URL 分享或收藏。

## 目标

- 不同层级菜单各有自解释的 URL；**刷新可恢复**、**URL 可分享直达**某会话某视图。
- 前进 / 后退符合直觉。
- **不引入 react-router 等新依赖**（项目风格极简），自写一个小路由。
- **后端无需改动**：`staticSite.ts` 已有 SPA 回退（非 `/api` 的 GET 全回 `index.html`），深链刷新返回 200 text/html。
- **不删除 / 不改动**现有功能（HUD / 改名 / 资源 / 多用户 / 聊天⇄终端切换）。组件 `ChatView` / `Terminal` / `ResourcePanel` / `UserAdmin` / `ConversationList` 的内部逻辑与签名保持不变。

## URL 方案（镜像 API 路径，自解释）

| URL | 含义 |
| --- | --- |
| `/` | 项目列表 |
| `/projects/:projectId` | 项目（默认「会话」tab） |
| `/projects/:projectId/files` | 项目「文件」tab |
| `/projects/:projectId/tasks` | 项目「Task / Evidence」tab（仅科研项目） |
| `/projects/:projectId/conversations/:convId/chat` | 该会话**聊天**视图 |
| `/projects/:projectId/conversations/:convId/terminal` | 该会话**终端**视图 |
| `/projects/:projectId/conversations/:convId` | 无视图后缀 → 解析为「记忆视图或 chat」，`replace` 成带后缀的规范 URL |
| `/resources` | 资源面板（任意登录可见） |
| `/users` | 用户管理（**仅 admin**，非 admin 重定向到 `/`） |
| 未知路径 | 重定向 `/` |

## 设计

### 1. 纯函数放 shared（TDD）

新增 `packages/shared/src/routes.ts` + `routes.test.ts`，并在 `index.ts` 导出。

`Route` 判别联合：

```ts
type Route =
  | { name: 'projects' }
  | { name: 'project'; projectId: string; tab: 'sessions' | 'files' | 'tasks' }
  | { name: 'conversation'; projectId: string; convId: string; view: 'chat' | 'terminal' | null }
  | { name: 'resources' }
  | { name: 'users' }
  | { name: 'unknown' };
```

- `parseRoute(pathname): Route` — 解析当前 `location.pathname`。
- `buildRoute(route: Route): string` — 反向构造 URL（始终以 `/` 开头、无尾斜杠）。

要点：

- 解析对路径段做 `decodeURIComponent`，构造对 id 段做 `encodeURIComponent`，保证含特殊字符的 id round-trip。
- 容忍尾斜杠（`/projects/x/` 等价 `/projects/x`）。
- 段数 / 字面量不匹配 → `{ name: 'unknown' }`（由调用方重定向 `/`）。
- `project` 的 `tab` 仅接受 `files` / `tasks` 字面量，缺省（`/projects/:id`）→ `sessions`。
- `conversation` 末尾 `chat` / `terminal` → 对应 `view`，缺省 → `view: null`（调用方据记忆规范化）。

**round-trip 单测**覆盖每一层（projects / 三个 tab / 两视图 + 无视图后缀→null / resources / users / unknown / 尾斜杠 / 转义 id）。注意 `view: null` 的无后缀 URL 不是 `build∘parse` 的不动点（build 不会生成无后缀 URL；规范化在 React 层做），测试分别验证 parse 与 build 两个方向。

### 2. React 钩子放前端

新增 `apps/web/src/lib/router.ts`：

```ts
function useRoute(): {
  route: Route;
  navigate(to: Route | string, opts?: { replace?: boolean }): void;
};
```

- 基于 `window.location.pathname` + `history.pushState/replaceState` + `popstate` 监听。
- `navigate` 接受 `Route`（走 `buildRoute`）或字符串路径；`opts.replace` 用 `replaceState` 否则 `pushState`，并派发同步状态更新。
- 组件用 `useRoute()` 拿到当前 `route` 与 `navigate`。

### 3. `App.tsx` 改为路由总线

保留登录门：`user===undefined` 加载中、`null` 渲染 `Login`，登录后停留当前 URL 重渲。

按 `route` 渲染：

- `projects` → `ProjectList`。
- `project` / `conversation`：带 id，需**按 id 解析实体**（深链 / 刷新时只有 id）：
  - 项目：`api.getProject(projectId)`（GET `/api/projects/:id` 已存在，`api.getProject` 已有）。
  - 会话：`api.listConversations(projectId)` 找 `convId` 对应项（避免新增后端接口）。
  - 解析中显示极简加载态（`<div className="app" />`）。
  - 404 / 不可见 → 重定向合理上级：项目没了→`/`，会话没了→该项目 `/projects/:id`。
- `resources` → `ResourcePanel`。
- `users` → 非 admin 先重定向 `/`，admin 渲染 `UserAdmin`。
- `unknown` → 重定向 `/`。

把"按 id 解析实体 + 重定向"抽成一个内部 `ProjectRoute` / `ConversationRoute` 解析组件，避免 `App` 里堆 effect。

**历史语义：**

- 下钻用 push：projects → project → conversation/chat。
- 视图切换（chat⇄terminal）用 **replace**（避免后退在两视图间反复横跳）。
- 无后缀会话 URL 规范化用 **replace**。

### 4. 组件导航接线（保留其余行为 / props 不动）

- **`ProjectList`**：去掉内部 `managing` / `UserAdmin`。回调改 navigate 驱动：`onOpen(p)`→`/projects/:id`、「资源」→`/resources`、admin「用户」→`/users`、「退出」→登出后 `/`。由 `App` 传 navigate 化的回调（沿用现有 `onOpen` / `onOpenMetrics` / `onLock` 三回调形态，新增一个 `onOpenUsers`）。
- **`ProjectDetail`**：去掉 `openConv` / `view` / 会话渲染，只管项目级（顶栏 + tab + 各 tab 内容）。`tab` 由 URL（prop）决定；切 tab → navigate；`ConversationList` 的 `onOpen(conv)`→ navigate 到该会话**记忆视图或 chat** 的 URL；返回 → `/`。`onRenamed` 不再需要同步顶栏（标题归会话视图），`ConversationList` 内部本来就会刷新列表，故 `ProjectDetail` 不必再传 `onRenamed`。
- **新增 `apps/web/src/components/ConversationView.tsx`**：`{ project, conversation, view, onBack, onSwitchView }`，按 `view` 渲染 `ChatView` 或 `Terminal`（两组件签名**不改**）。`onSwitchView`→ navigate 到另一视图 URL（replace）+ 写 `localStorage` `rcc:view:<convId>`；`onBack`→ navigate `/projects/:projectId`。`App` 的 `conversation` 路由解析出实体后渲染它。
- **`UserAdmin` / `ResourcePanel`**：`onBack`→ navigate `/`（组件本身不变）。

### 5. 记忆视图保留

从列表打开会话或访问无后缀会话 URL 时，用 `rcc:view:<convId>` 决定 chat/terminal（默认 chat），逻辑与原 `ProjectDetail.openConversation` 一致，仅迁移到导航 / 规范化处。

## URL ↔ 组件对照表

| URL | 渲染组件 | 进入方式 |
| --- | --- | --- |
| `/` | `ProjectList` | — |
| `/projects/:id` | `ProjectDetail`(tab=sessions) | push |
| `/projects/:id/files` | `ProjectDetail`(tab=files) | replace（同项目切 tab） |
| `/projects/:id/tasks` | `ProjectDetail`(tab=tasks) | replace（同项目切 tab） |
| `/projects/:id/conversations/:cid/chat` | `ConversationView`→`ChatView` | push（从列表进） |
| `/projects/:id/conversations/:cid/terminal` | `ConversationView`→`Terminal` | replace（视图切换） |
| `/projects/:id/conversations/:cid` | 规范化→上面之一 | replace |
| `/resources` | `ResourcePanel` | push |
| `/users` | `UserAdmin`（admin）/ 重定向 `/` | push |
| 其它 | 重定向 `/` | replace |

## 不做 / 非目标

- 不引入路由库；不做查询参数 / hash 路由。
- 不改后端（SPA 回退已就绪，仅 curl 复核）。
- 不动 `ChatView` / `Terminal` / `ResourcePanel` / `UserAdmin` / `ConversationList` 内部逻辑与既有功能。
- 不做无关重构。

## 风险

- 深链解析需两个请求（getProject + listConversations）才能渲染会话视图，首屏多一次轻量加载态——可接受。
- `popstate` 与 React state 同步要小心，避免渲染循环（钩子内只在 pathname 真变时 setState）。
