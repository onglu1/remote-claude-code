# URL 路由 — 实施计划

对应设计：`docs/superpowers/specs/2026-06-21-url-routing-design.md`。

原则：并行增量、不删既有功能、频繁小步中文提交、TDD 先行、真验证再声称完成。

## 步骤

### A. shared 纯函数（TDD）

1. 先写 `packages/shared/src/routes.test.ts`：
   - `parseRoute` 每层：`/` → projects；`/projects/x` → project(sessions)；`/projects/x/files`、`/tasks`；会话两视图 + 无后缀(view:null)；`/resources`；`/users`；未知 → unknown。
   - 尾斜杠容忍；转义 id（`a%2Fb` → `a/b`）。
   - `buildRoute` 每层 round-trip：`parse(build(r)) === r`（除 view:null 无后缀这条，单独验 build 不生成无后缀、parse 无后缀得 null）。
2. 实现 `packages/shared/src/routes.ts`：`Route` 联合 + `parseRoute` + `buildRoute`。
3. `index.ts` 加 `export * from './routes'`。
4. `npm -w @rcc/shared run test` 绿；`npm run typecheck` 绿。
5. 提交（feat(shared): 路由纯函数 + 单测）。

### B. 前端路由钩子

6. 新增 `apps/web/src/lib/router.ts`：`useRoute()`（pathname + pushState/replaceState + popstate）。
7. 提交（feat(web): useRoute 钩子）。

### C. App 路由总线 + 组件接线

8. 新增 `apps/web/src/components/ConversationView.tsx`：按 view 渲 ChatView/Terminal，onSwitchView(replace+localStorage)/onBack。
9. 改 `App.tsx`：登录门保留；按 route 渲染；新增内部 `ProjectRoute`/`ConversationRoute` 解析实体（getProject + listConversations）+ 加载态 + 重定向；users 非 admin 重定向；unknown 重定向。
10. 改 `ProjectList`：去 managing/UserAdmin，回调 navigate 化（onOpen/onOpenMetrics/onOpenUsers/onLock）。
11. 改 `ProjectDetail`：去 openConv/view/会话渲染；tab 由 prop 决定 + 切 tab navigate；onOpen 会话 → 记忆视图 URL；返回 → `/`。
12. `UserAdmin`/`ResourcePanel` onBack 由 App 传 navigate `/`（组件不改）。
13. `npm run typecheck` 绿。
14. 提交（feat(web): App 路由总线 + 组件导航接线）。

### D. 验证

15. `npm test`（含 routes 单测）/ `npm run typecheck` / `npm run build` 全绿。
16. `./start.sh` 重启；curl 深链复核：`/`、`/projects/x`、`/projects/x/conversations/y/chat`、`/resources`、`/users` 应 200 text/html；`/api/health` 仍 200 json。
17. grep `apps/web/dist/assets/*.js` 确认 `parseRoute` / 路由路径进 bundle。
18. 自查 URL↔组件对照与前进/后退/刷新语义，写进汇报。
