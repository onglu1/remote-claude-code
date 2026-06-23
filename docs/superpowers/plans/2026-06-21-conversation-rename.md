# 会话改名 实现计划（TDD 分步提交）

对应设计：`docs/superpowers/specs/2026-06-21-conversation-rename-design.md`

## 步骤

### 1. 后端：失败测试（红）
- 新增 `apps/server/src/routes/sessions.rename.test.ts`：
  - 成功改名（200 + 列表生效）
  - 空名 / 纯空白 → 400
  - 超长（>60）→ 400
  - 不可见项目 → 404
  - 会话不存在 → 404
  - 未登录 → 401
- 跑 `npm test`，确认改名相关用例红（路由还不存在 → 404/统一报错）。
- 提交：`test(server): 会话改名路由用例(成功/空名超长400/不可见与不存在404/未登录401)`

### 2. 后端：实现路由（绿）
- 在 `routes/sessions.ts` 加 `RenameConvSchema`（`z.string().trim().min(1).max(60)`）。
- 加 `PATCH /api/projects/:id/conversations/:cid`：requireAuth → project 可见性 404 → body 400 → conv 存在且属该项目 404 → `update(cid,{name})` → 返回 `{ conversation: {...updated, alive} }`。
- `alive` 复用本文件存活判定。
- 跑 `npm test`、`npm run typecheck`，转绿。
- 提交：`feat(server): 会话改名路由 PATCH conversations/:cid(复用 update + 多用户可见性过滤)`

### 3. 前端：api + 列表改名 UI
- `apps/web/src/lib/api.ts` 加 `renameConversation`。
- `ConversationList.tsx`：每行加铅笔「重命名」入口 → 就地输入框（预填、聚焦、回车/失焦提交、Esc 取消、空名取消），成功后本地更新名字。
- 沿用 `themes/tokens.css`/`index.css` 既有 `.row/.input/.btn` 风格，不加新依赖。
- 提交：`feat(web): 会话列表就地重命名(铅笔→输入框,回车/失焦保存)`

### 4. 可选：聊天顶栏同步
- `ConversationList` 加 `onRenamed?(cid,name)`；`ProjectDetail` 实现，若 `openConv?.id===cid` 则更新 `openConv.name`。
- 提交：`feat(web): 改名后同步已打开会话名(ProjectDetail.openConv)`

### 5. 验证
- `npm run typecheck`、`npm test`、`npm run build` 全绿。
- `./start.sh` 重启（前端有改动，需重建）。
- curl 改名闭环（见 spec）+ 空名 400。
- 汇报。
