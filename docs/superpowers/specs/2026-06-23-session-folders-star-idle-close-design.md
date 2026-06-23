# 会话文件夹 · 标星 · 空闲自动关闭 设计

## 背景与诉求

会话数量上来后,侧栏一片混杂。三件事一起做:

1. **文件夹分类**:用户可自定义文件夹(项目内),会话归到唯一一个文件夹里(或"未分类")。
2. **标星**:重要会话打⭐。**标星会话拒绝进垃圾桶**(必须先取消星)。
3. **空闲自动关闭**:会话静默超阈值(默认 3h、UI 可调)→ 杀掉 tmux pane 释放资源,但**保留 conversation 元数据**;用户点回去 → `ensure()` 走 `--resume` 自然拉回,历史与 HUD 从 transcript + sidecar 重渲。

特别注意:claude 经常在等后台(`Bash sleep`、训练脚本、`Task` 起的 subagent、未回的 MCP 工具),空闲探测**不能误关**这些等待中的会话。本设计用五信号合判(详见 §3)。

## 现状

- `Conversation` 见 `packages/shared/src/schemas.ts:75`,字段含 `id/projectId/name/tmuxName/sessionId/effort/alive/createdAt/deletedAt`。`alive` 不入存储,路由处用 `tmux.listSessions() ∪ registry.isActive(id)` 实时算(`apps/server/src/routes/sessions.ts`)。
- `ConversationStore`(`apps/server/src/lib/conversations.ts`)已有完整软删除/恢复/硬删除三套(`softDelete/restore/hardDelete`),路由也都接好了。
- 项目/用户隔离已在线:每个 `Conversation` 隶属 `Project`,`Project.ownerId` 决定可见性,`canSeeProject(user, project)` 在所有会话路由前置校验。
- `TranscriptTail`(`apps/server/src/lib/session/chat/transcript.ts`)已能增量解析 jsonl,识别 `tool_use/tool_result/isSidechain`,提供 `activeChain()` 与 `lastAssistantUsage()`。
- HUD 三源融合(`hudSource.ts`)已经在用 statusline sidecar(`$RCC_STATUSLINE_DIR/<sessionId>.json`)+ transcript usage + pane 读屏;sidecar 15s 视为过期。
- AskHook sidecar(`$RCC_ASK_DIR/<sessionId>.json`,Pre 写 / Post 删)在 `chatSession.tick` 已被消费。
- 前端会话列表 `apps/web/src/components/ConversationList.tsx`,改名/删除/关闭按钮已就位;聊天/终端视图同一个 conversation。

## 目标

1. **数据**:`Conversation` 加 `folderId / starred / lastActivityAt / closedAt`;新加 `FolderStore`。
2. **后端**:文件夹 CRUD 路由 + 会话 PATCH 扩字段 + 批量操作 + 标星拒删 + 关闭/唤醒路由。
3. **活动探测器** `lib/session/activity.ts`(纯函数+注入 IO),五信号合判 busy。
4. **休眠扫描器** `lib/session/idleSweeper.ts`,事件驱动(chatSession.tick 顺便扫)+ setInterval 兜底,超阈值 → kill tmux + 写 `closedAt`。
5. **前端**:侧栏文件夹树(三态点:绿/灰/星)、右键菜单、桌面拖拽(`@dnd-kit/core`)、多选批量、设置面板里的空闲阈值。
6. **配置**:`config/users.json` 加 `settings.idleCloseHours`(0=关闭功能,默认 3)。

## 非目标

- 不改终端/聊天的会话引擎本身,只在外围加生命周期管理。
- 不做跨项目文件夹(每个文件夹绑 `projectId`)。
- 不做文件夹嵌套(平铺一层)。
- 不做拖拽排序文件夹内会话(按 `lastActivityAt` 倒序自动排;手动 `sortOrder` 只给文件夹用)。
- 不在 transcript 之外另写日志/审计;探测器全靠现有文件系统观察。
- 移动端不实现拖拽(走长按菜单)。

## 数据模型

### `Conversation` 扩字段(`packages/shared/src/schemas.ts`)

```ts
export const ConversationSchema = z.object({
  // ... 既有字段不变 ...
  folderId: z.string().nullable().optional(),     // null/缺省 = 未分类
  starred: z.boolean().default(false),
  lastActivityAt: z.string().optional(),          // ISO,初始=createdAt
  closedAt: z.string().optional(),                // 存在=休眠;ensure() 后清空
});
```

`ConversationStore.migrate()` 在现有 sessionId 补全基础上,继续给老数据补 `starred=false`、`lastActivityAt = lastActivityAt ?? createdAt`。`folderId/closedAt` 缺省即 undefined,无需迁移。

### `Folder` 新 schema

```ts
export const FolderSchema = z.object({
  id: z.string().min(1),                          // 'fld_' + 8 hex
  projectId: z.string().min(1),                   // 不跨项目
  ownerId: z.string().min(1),                     // 沿用多用户隔离
  name: z.string().min(1).max(40),
  sortOrder: z.number().int().default(0),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof FolderSchema>;
```

### 持久化:`config/folders.json`

新文件,数组结构,同样原子 tmp+rename + `.bak`。`FolderStore`(`apps/server/src/lib/folders.ts`):
- `listByProject(projectId, viewerId)` — 按可见性过滤(项目可见性已由调用方校验,本方法只过滤 `ownerId`)。
- `create(projectId, ownerId, name)` — 同项目内同名拒(409)。
- `rename(folderId, name)`、`reorder(orderedIds)`、`remove(folderId)`。
- `remove` 同时把 `conversations.json` 内 `folderId === folderId` 的全部置 null(单事务:先改 conversations 再删 folder,保证不出现悬空 folderId)。

### 不变量

- `deletedAt` 与 `closedAt` 正交:`closedAt` 不阻止 deletedAt;但 `starred=true` 阻止 `softDelete`。
- `folderId` 引用必须有效:store 写之前校验,无效引用直接拒(400)。
- 文件夹删除 → 内部会话 `folderId` 全部置 null(回到未分类),不一并删会话。

## 活动探测器(§3 核心)

### 五信号

| 信号 | 实现 | 误判方向 |
|---|---|---|
| ① 未闭合 `tool_use` | 增量解析 transcript,`openToolUseIds = Set<tool_use_id>`,见 `tool_use` 入、见 `tool_result.tool_use_id` 出。sidechain 节点用独立集合,任一非空即 busy | 几乎不会假阳性,极少假阴性(claude 已收 result 但卡在自己思考中,会被信号④覆盖) |
| ② AskHook sidecar 存在 | `fs.existsSync($RCC_ASK_DIR/<sessionId>.json)` | 极准 |
| ③ transcript mtime 滑窗变 | 90s 滑窗内 `stat(jsonl).mtimeMs` 跳过即 busy | 极准,但 claude 输出完一段后到下一次工具调用之间有静默,故只是辅助 |
| ④ statusline sidecar mtime 滑窗变 | 同上,`$RCC_STATUSLINE_DIR/<sessionId>.json` | claude 主进程在动就会刷;能覆盖"模型在长思考但还没写 transcript" |
| ⑤ pane hash 滑窗变 | `tmux capture-pane -p -t <tmuxName>` → sha1 前 16,90s 滑窗对比 | 能抓 bash 在 stream stdout(run_in_background=true 后台 stream)、TUI 动画 |

**判定**:任一为真 → busy → `lastBusyAt = now()`。`idleForMs = now() - lastBusyAt`。

### 接口

```ts
// apps/server/src/lib/session/activity.ts
export interface ActivityIO {
  transcriptStat(p: string): { mtimeMs: number; size: number } | null;
  transcriptTail(p: string, fromOffset: number): { text: string; end: number };
  sidecarStat(dir: string, sessionId: string): { mtimeMs: number } | null;
  paneHash(tmuxName: string): string | null;
  now(): number;
}

export interface ActivityState {
  // 每会话维护
  transcriptOffset: number;
  transcriptPending: string;
  lastTranscriptMtime: number;
  lastStatuslineMtime: number;
  lastAskSidecarSeen: boolean;
  lastPaneHash: string | null;
  lastPaneHashAt: number;
  openToolUseIds: Set<string>;        // 主线
  openToolUseIdsSidechain: Set<string>;
  lastBusyAt: number;
}

export function createActivityState(now: number): ActivityState;

export function tickActivity(
  state: ActivityState,
  ctx: { transcriptPath: string | null; tmuxName: string; sessionId: string; statuslineDir: string; askDir: string },
  io: ActivityIO,
  windowMs: number,                   // 默认 90_000
): { busy: boolean; idleForMs: number; reasons: string[] };
```

纯函数;state 由调用方拥有(chatSession 持有一份;sweeper 自己持有一份)。`reasons` 是 5 信号哪几个命中,便于 debug/日志。

### 休眠扫描器

```ts
// apps/server/src/lib/session/idleSweeper.ts
export class IdleSweeper {
  constructor(
    private readonly ctx: { conversations: ConversationStore; users: UserStore; tmux: Tmux; registry: ChatRegistry; },
    private readonly io: ActivityIO,
    private readonly opts: { intervalMs?: number; windowMs?: number; defaultThresholdHours?: number },
  );
  start(): void;
  stop(): void;
}
```

- `start()` 起 `setInterval(intervalMs ?? 60_000)`。
- 每 tick:
  1. 取所有未在垃圾桶、未休眠的 conversations。
  2. 对每条:若它有 chatSession 在 registry 里,从 chatSession 拉最新 activityState;否则探测器自带状态机滚一遍。
  3. 算 `idleForMs`,阈值取 `users.getSettings(ownerId).idleCloseHours * 3600_000`;0 表示关闭自动关闭,跳过。
  4. 超阈值 → `tmux.killSession(tmuxName)` + `conversations.update(id, { closedAt: now })` + WS 广播 `convClosed`。
- 进程关停时 `stop()` 清 interval。

### 关闭与唤醒

- **关闭**:杀 `tmux kill-session -t <tmuxName>`(transcript jsonl 在 `~/.claude/projects/` 不动,无损);`closedAt = now`;若 chatRegistry 里有就 `stopPolling()` 并删 entry。
- **唤醒**:`POST /api/projects/:id/conversations/:cid/resume` → `tmux.ensure(...)` 走现有路径,内部用 `launchFlag(sessionId)` → 有 transcript 就 `--resume`,无则 `--session-id`;成功后 `conversations.update(id, { closedAt: undefined })`;返回 conversation 让前端切灯转绿。
- **wake-on-visit**:前端点击休眠会话,实际就是调 resume 后再走进入会话的既有流程。前端不需要区分"先 resume 再进入"——把 resume 作为进入会话路径的前置 step。

## 后端 API

### HTTP

```
GET    /api/projects/:id/folders                  → { folders: Folder[] }
POST   /api/projects/:id/folders                  body { name } → { folder }
PATCH  /api/projects/:id/folders/:fid             body { name?, sortOrder? } → { folder }
DELETE /api/projects/:id/folders/:fid             → { reassigned: number }

PATCH  /api/projects/:id/conversations/:cid       body { name?, folderId?, starred?, effort? } → { conversation }
DELETE /api/projects/:id/conversations/:cid       软删除;若 starred=true → 409 { error: 'starred_locked' }

POST   /api/projects/:id/conversations/:cid/close   手动关闭(等同 sweeper 关闭) → { conversation }
POST   /api/projects/:id/conversations/:cid/resume  唤醒 → { conversation }

POST   /api/projects/:id/conversations/batch      body { ids, action: 'move'|'star'|'unstar'|'close'|'softDelete', payload? }
  → { succeeded: string[], failed: { id, reason }[] }
  失败示例:softDelete 命中 starred_locked、move 命中 folder 不存在
```

所有路由前置 `requireAuth` + 项目可见性 `canSeeProject` + (文件夹路由)文件夹归属本项目 + (文件夹路由)`folder.ownerId === user.id` 或管理员。

现有 `PATCH /api/projects/:id/conversations/:cid` 路由(改名)扩字段:body schema 加 `folderId / starred / effort` 全部 optional,逐个非空才生效;校验 `folderId` 不为 null/undefined 时,该 folder 必须存在且 `projectId === id`。

### WS 广播

走现有 chat-ws 与 session-ws 的事件管道。新增事件:
- `convClosed { id, closedAt }`
- `convOpened { id }`
- `convPatched { id, patch }` — folderId/starred/name/effort 任一改动后广播
- `folderCreated { folder }` / `folderPatched { id, patch }` / `folderRemoved { id, reassignedTo: null }`

前端订阅后做侧栏本地状态同步,避免轮询。

## 前端设计

### 侧栏(`ConversationList.tsx` 重构为 `SidebarTree.tsx` 或拆 sub-components)

数据形状:
```
未分类(虚拟桶) ┐
文件夹 A       ├ Conversation[]
文件夹 B       ┘
[+ 新建文件夹]
─────────
🗑 垃圾箱
```

每个 conversation 条目左侧 dot 三态(用 SVG 或 CSS):
- 绿点 = alive(tmux 在 + 非休眠)
- 灰点 = sleeping(`closedAt` 存在)
- ⭐ 叠加(独立 icon,不替代 dot)

点击 sleeping 会话 → 触发 `wakeAndOpen(cid)`:UI 显示"恢复中..." → `POST .../resume` → 成功后走原 `onOpen` 流程。

### 右键 / 长按菜单(`SessionContextMenu.tsx`)

- `移到文件夹 ▸` 子菜单列本项目文件夹 + "未分类" + "新建文件夹…"
- `⭐ 加星 / 取消星`
- `关闭(休眠)` — alive 会话才出现
- `重命名…` — 沿用既有
- `删除` — 调既有 softDelete API;starred 时:按钮 disabled + tooltip"先取消星才能删除"

桌面端:鼠标右键唤起。移动端:长按 500ms 唤起。**选 `@radix-ui/react-context-menu`**——已有 `@radix-ui/react-dialog` 这类依赖(实施时确认,若 radix 全无则手写一个最小版,200 行内,避免新增大依赖)。

"新建文件夹…"选项的交互:点击后**就地把子菜单替换成一个 `<input>`**(自动聚焦),回车提交、Esc 取消;成功后把会话移入新文件夹一气呵成,不弹模态。

### 拖拽(`@dnd-kit/core`)

新依赖:`@dnd-kit/core@^6.x`(无障碍好,触摸/鼠标统一 sensor)。
- 会话条目 = draggable。
- 文件夹标题 + "未分类"桶 = droppable。
- 拖动时高亮目标桶;放下 → 乐观更新 + 调 `PATCH .../conversations/:cid { folderId }`;失败回滚 + toast。
- 移动端 sensor 不启用拖拽(`useSensor(PointerSensor, { activationConstraint: { distance: 8 } })`,移动端长按走菜单)。

### 多选批量(`MultiSelectToolbar.tsx`)

- 桌面:cmd/ctrl+click 加选、shift+click 范围、esc 退选。
- 移动端:每个条目左侧出 checkbox(进入"多选模式";由长按任一会话激活,或顶栏的"选择"按钮激活)。
- 选中态 ≥ 1 时,侧栏顶部显示工具栏:`已选 N · 移到… / ⭐加星 / 关闭 / 删除 / 取消`。
- 批量动作走 `POST .../conversations/batch`,服务端返 `{ succeeded, failed }`,前端逐项更新本地状态;有失败 toast 显示原因(如 starred_locked)。

### 设置面板(`SettingsPanel.tsx`)

用户菜单加"设置"项。最小内容:
- 标题"空闲自动关闭",数字输入(0–48,步长 1,单位 h)
- 0 = 关闭功能(不自动关任何会话);默认 3
- 帮助文字:"超过 N 小时无任何活动,会话的 tmux 会被关闭以释放资源。点击休眠会话会自动恢复,历史不丢。"

存到 `users.json.settings.idleCloseHours`。

## 测试(TDD)

### 单测(vitest,共置)

新增:
- `apps/server/src/lib/session/activity.test.ts`
  - 5 信号每条独立:fake IO 注入 transcript 片段、mtime、ask sidecar 存在/不存在、pane hash 跳变
  - 组合:1+3 同时 busy、单 5 busy、全空闲
  - sidechain 集合与主线集合独立
  - openToolUseIds 增量:多行进出
- `apps/server/src/lib/session/idleSweeper.test.ts`
  - fake activity 返回 idleForMs,阈值临界 (= → 不关、+1ms → 关)
  - 关闭路径:断言 `tmux.killSession` 调用、`closedAt` 写入、`stopPolling` 调用
  - `idleCloseHours=0` → 跳过
- `apps/server/src/lib/folders.test.ts`
  - CRUD 全套、同项目重名 409、删非空 → 内部会话 folderId 置 null 并返回 reassigned 计数
- `apps/server/src/lib/conversations.test.ts`(扩)
  - migrate:补 starred/lastActivityAt
  - softDelete:starred=true 抛 `starred_locked`
- 路由 `apps/server/src/routes/sessions.folders-star-idle.test.ts`
  - 文件夹 CRUD、可见性 404、跨项目操作 404
  - PATCH conversation 改 folderId/starred/effort
  - DELETE starred → 409
  - close + resume → tmux 与 closedAt 状态机
  - batch:混合成功/失败
- 前端组件单测:`SidebarTree.test.tsx`(分组与三态点)、`SessionContextMenu.test.tsx`(starred 时 delete disabled)、`DraggableSession.test.tsx`(dnd-kit testing utilities)、`MultiSelectToolbar.test.tsx`(选中态切换)

### 集成冒烟(`apps/server/scripts/smoke-chat.ts` 或新 `smoke-idle.ts`)

1. 起一个聊天会话 → 等 transcript 出现。
2. mock `now()` 跳 4h → idleSweeper 跑一次 → 断言 tmux ls 不再有它、conversation.closedAt 已写。
3. 调 resume API → tmux 又起回 → conversation.closedAt 清空 → 聊天历史与之前一致(对比 message id 集合)。
4. **busy 防误关测试**(关键):
   - 起会话 → 发"Bash sleep 5" 让 claude 调 Bash → busy 5s → mock 跳 4h(仍在 sleep 中)→ sweeper 跑 → 断言**不关**(open tool_use)。
   - sleep 结束、tool_result 回 → busy=false → 再跳 4h → sweeper 跑 → 关。
5. **subagent 防误关**:让 claude 调 Task 起 subagent(用一个 trivial 的 prompt 让 sidechain 跑 30s)→ mock 跳 4h → 不关。

### 真实验证(我跑完后让你看)

- 手机端:
  - 长按会话 → 菜单弹起、移动到新文件夹
  - 多选模式批量关闭
- 桌面端:
  - 拖拽到文件夹
  - 关闭后侧栏灰点、点击灰点恢复正常进入
  - 标星会话点删除按钮 disabled
- 真实 idle 场景:
  - 设 `idleCloseHours=1`,放着不动 → 1h 后看灰点
  - 跑个 `Bash sleep 4000`,1h 后 sweeper 不该关

## 真实落地节奏

按 `writing-plans` 出的细分步骤实施,大致是:
1. shared schemas 扩字段 + Folder schema(基础设施,后续都依赖)
2. ConversationStore migrate + starred 拒删 + closedAt 字段
3. FolderStore + 单测
4. activity 探测器纯函数 + 单测
5. idleSweeper 类 + 单测
6. 路由扩字段 + 文件夹 CRUD + close/resume + batch + 路由测试
7. WS 广播事件
8. 前端 shared types 同步、SidebarTree 重构、ContextMenu、三态点
9. 设置面板 + idleCloseHours 写 users.json
10. 拖拽集成
11. 多选批量
12. 集成冒烟、真机验证

每步小步提交 + 中文 commit message,符合 CLAUDE.md 工程纪律。
