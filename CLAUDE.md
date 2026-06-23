# remote-cc — 项目开发约定

服务器上 Claude Code 会话的「远程窗口」。手机优先网页网关,口令登录、显式登记项目、对常驻 Claude Code 会话收发、tmux 持久化恢复,外加只读文件浏览与科研项目的 task/evidence 管理。

## 这个项目的硬性要求（每次开发都遵守，无需再问）

1. **不删除现有可用功能**。新能力一律**并行增量添加**、可切换而非替换。例：会话不区分类型——「聊天视图」与「终端视图」是**同一个原生 tmux 会话**的两种展现,前端可随时切换(默认聊天,localStorage 记住上次)。所有会话都以 `--session-id <uuid>` 启动,故两视图通用。聊天侧 `lib/session/chat/*` 与终端侧零共享可变状态。
2. **改动简单清晰、职责拆分明确、后期可维护**。文件小而专注(单一职责)、依赖注入便于测试、follow 既有分层(`lib/` 领域逻辑 + `plugins/` 横切 + `routes/` 按域)。不做无关重构。
3. **服务器侧必须跑"真正原生的 Claude Code"**。聊天模式也用**原生交互式** `claude`(tmux 里跑项目的 `launchCommand`,默认 `Fable-yolo`),**不用 headless `-p`/stream-json 自动化路径**——以保证斜杠命令/skill 原生可用、且无任何风控/行为差异。
4. **会话持久化用 tmux + claude 原生 resume**。每个聊天会话分配一个 `sessionId`(UUID),启动用 `--session-id <uuid>`、恢复用 `--resume <uuid>`;关浏览器会话后台续跑,后端重启用 resume 续上、历史从 transcript 重渲。
5. **手机优先、交互便捷、贴近原生 AI 网页**;**流式是硬要求**(聊天模式逐字流式来自读屏,完成后用 transcript 干净版覆盖)。
6. **中文**交流与文档。

## 工程纪律（superpowers）

- 动手前先 **brainstorming** 出设计 → **writing-plans** 出计划;设计/计划存 `docs/superpowers/{specs,plans}/`。
- **TDD**:后端 `apps/server` 与 `packages/shared` 用 vitest **测试与源码共置**(`*.test.ts`);纯逻辑(解析/拼装)抽成纯函数单测,IO/外部命令用注入的 fake。
- **频繁小步提交**;提交信息中文、说清「为什么」。
- **用真实集成验证,不只单测**:涉及 tmux/claude 的改动,跑真实冒烟(见 `apps/server/scripts/smoke-chat.ts`)确认端到端,再声称完成。
- 后台进程一律用 **tmux**(可观测),不用 nohup。

## 启动与配置

- **统一用 `./start.sh` 启动服务**(构建前端 + 停旧实例 + 在 tmux 会话 `remote-cc-server` 内以宿主进程启动)。`./start.sh --no-build` 快速重启;`./start.sh stop` 停止。**首次 clone**:`cp start.example.sh start.sh && chmod +x start.sh`,然后按本机情况微调(`start.sh` 已 gitignore,本机修改不会污染上游)。
- **⚠️ 改完代码必须重启才生效(本服务非热更新)**。后端是常驻进程、前端是已构建的静态 `dist`,**改了源码不会自动更新**。开发完务必重启:改了前端跑 `./start.sh`(会重新构建前端);**只改后端**可跑 `./start.sh --no-build`(更快,沿用已有 dist)。重启不丢聊天/终端会话(tmux + `claude --resume`)。
- **开机自启**(可选):往用户 crontab 加 `@reboot cd /path/to/remote-cc && ./start.sh --no-build`,机器重启时自动拉起服务。
- *(可选,默认不用)* `./start-dev.sh` 是热更新模式(后端 `tsx watch` 改即重启 + 前端 `vite build --watch` 改即重建,刷新浏览器生效),仅在主动开发时手动开;**不设为默认**,因为存了半成品/语法错的代码会让后端重启失败、网页打不开。回到稳定模式:`./start-dev.sh stop && ./start.sh`。
- **所有运行配置在 `.env`**(不进 git)。**改端口只改 `.env` 的 `PORT`**(当前 6325),无需改脚本/代码。关键项:`PORT`、`HOST=127.0.0.1`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`TMUX_SOCKET=rcc`、`PROJECTS_CONFIG`、`FS_BROWSE_ROOT`、`RCC_STATUSLINE_DIR`(聊天 HUD sidecar 目录,默认 `<repoRoot>/data/rcc-statusline`)、`RCC_ASK_DIR`(AskUserQuestion hook sidecar 目录,默认 `<repoRoot>/data/rcc-ask`)。**所有运行时数据(sidecar、log、config 私本)都落项目内 `data/`、`logs/`、`config/*.json`,gitignore 不进库。**
- **聊天 HUD 独立数据源(可选,opt-in)**:聊天 HUD 想拿原生 5h/周用量、context%,可以跑 `npm run setup-statusline` **一次**,把捕获器 `scripts/rcc-statusline.mjs` 装进 `~/.claude/settings.json` 的 `statusLine`——它按会话落 sidecar 给聊天 HUD 用,并**链式透传**原 statusLine 保终端原样;还原 `npm run setup-statusline -- --undo`(首次自动备份 `settings.json.rcc-bak`)。HUD 取数优先级:sidecar→transcript 推算→读屏兜底,所以**不装也能用**,只是少了精确用量。`start.example.sh` 默认**不**自动调用 setup-statusline(避免帮用户改 `~/.claude/settings.json`)。
- **外网访问/内网穿透**:本服务默认监听 `127.0.0.1:$PORT`,**不要直接暴露公网**。本项目**不内置**部署/隧道方案——按本机情况自选反向代理 + TLS(Cloudflare Tunnel、Tailscale、frp+nginx、自建 VPN 等任意一种),相关脚本放本机 gitignore 的 `deploy/` 目录或仓库外即可,不进 git。安全须知见 `README.md` 的「Security」一节。
- 常用命令:`npm test`、`npm run typecheck`、`npm run build`。
- 不提交:`.env`、`dist/`、`config/conversations.json`、`*.bak/*.log`、`*.rcc-bak`(已 gitignore)。

## 架构速览

- `packages/shared` — zod 类型 + WS 协议(终端 `ws.ts` 字节流 / 聊天 `chatWs.ts` 结构化)。
- `apps/server` — Fastify:鉴权、项目注册表(零扫描,显式 `config/projects.json`)、会话引擎(终端 `lib/session/*` 用 node-pty;聊天 `lib/session/chat/*`)、文件浏览、task/evidence。
- `apps/web` — React + Vite:终端 `Terminal.tsx` + 聊天 `components/chat/*`。
- 会话进程活在独立 `tmux -L rcc`,与后端解耦。

### 会话生命周期(休眠 + 文件夹 + 标星)

- **会话三态**:**alive**(tmux 在)、**sleeping**(`closedAt` 存在,tmux 已关)、**deleted**(`deletedAt` 存在,在垃圾桶)。前端 SidebarTree 的"三态点"按这个直接映射(绿/灰/红 + 星叠加)。
- **空闲自动关闭**:`IdleSweeper`(`lib/session/idleSweeper.ts`)每 60s 扫一遍 `listAllAlive` 会话,对每个跑 `activity.tickActivity()` 五信号合判 busy;空闲超用户阈值(`users.settings.idleCloseHours`,默认 3,0=关功能)→ `tmux kill-session` + 写 `closedAt` + `registry.forceClose`。阈值在前端齿轮 `SettingsPanel` 改,走 `GET/PATCH /api/me/settings`。
- **五信号**(`lib/session/activity.ts`):① 未配对 `tool_use`(transcript 增量解析)② `askDir/<sid>.json` 存在 ③ transcript mtime 滑窗变 ④ statusline sidecar mtime 滑窗变 ⑤ pane hash 滑窗变。任一为真即 busy。窗口默认 90s。冒烟 `apps/server/scripts/smoke-idle.ts` 跑真实 claude + Bash sleep 验证。
- **休眠恢复**:点击休眠会话或菜单"恢复" → `POST .../conversations/:cid/resume` → `tmux.newDetached` + claude `--resume` → 清 `closedAt`。历史从 transcript 自然重渲(transcript 文件不动)。手动"关闭(休眠)"走 `POST .../close`,与垃圾桶软删除是两条独立路径。
- **文件夹**(`config/folders.json` + `FolderStore`):按 (projectId, ownerId) 隔离,平铺一层(不嵌套),删非空时内部会话 folderId 自动置 null。前端 `SidebarTree` 按 folderId 分组,右键/长按 `SessionContextMenu` 子菜单 + 桌面端拖拽(`@dnd-kit/core`)+ 多选 `MultiSelectToolbar` 三路入口。
- **标星**(`Conversation.starred`):布尔;true 时 `DELETE` 路由返 409 `starred_locked`,前端按钮 disabled、批量删除把它列入 failed。**不影响生命周期**(标星会话仍可被 IdleSweeper 关掉转休眠,只是不能进垃圾桶)。
- **批量动作**:`POST .../conversations/batch` body `{ ids, action: 'move'|'star'|'unstar'|'close'|'softDelete', payload? }`;后端"尽力而为",单条失败进 failed 不阻断整批,前端 alert 汇总。

### 多用户身份(unix 隔离 + 子用户)

- **三层模型**:**Unix 用户**(物理 OS 账号,各自 `~/.claude`)→ **rcc 主账号**(1:1 绑 unix 用户,`users.json` 有 `unixUser` 字段)→ **子用户**(N:1 挂在主账号下,`subusers.json`,独立用户名/口令登录,unix 身份继承父,资源 namespace=自己)。详见 `docs/superpowers/specs/2026-06-23-multi-user-unix-isolation-design.md`。
- **命令包装**(`lib/session/runAs.ts`):所有 tmux/claude/stat/cat 调用过 `runAs(unixUser, file, args)`。**零开销路径**:目标 unix === ServiceUser 时直 exec(等同单用户老逻辑,行为零变化);跨 unix 时拼 `sudo -n -H -u <user> --`(non-interactive 配错立刻报错,-H 切 HOME 让 claude 读对方 `~/.claude`)。
- **Tmux 实例化绑 unixUser**:`new Tmux({ socket, unixUser, currentUser })`;socket 名 `rcc-<unixUser>`(跨 unix tmux server 各自一份),内部所有 exec 走 `runAs`。`AppContext.getTmux(unixUser)` lazy 缓存。
- **AuthUser 字段**:`{ id, username, role, kind: 'user'|'subuser', parentId?, unixUser, namespaceId }`。**namespaceId** 是资源归属 key:主账号=user.id,子用户=subUser.id(子用户与父独立,与同父其他子用户也独立);`canSeeProject` / projects / folders 全部按 namespaceId 比对。`req.user.unixUser` 用于命令包装,`req.user.namespaceId` 用于归属过滤。
- **sidecar 按 unix 用户分子目录**:`askDir/<unixUser>/` 和 `statuslineDir/<unixUser>/`(hook 进程跑在目标 uid 下,settings.json 也每个 unix 用户独立一份;子用户共享父的 unix 子目录)。`context.askLaunchFor(unixUser)` lazy 创建。
- **不引入"share claude 配置"**:想用别人的 claude 订阅 → 做别人的子用户(unix 身份继承=共享对方 `~/.claude`);"借别人订阅但文件 owner 是自己"这种状态被刻意砍掉,攻击面太大。
- **登录路径**:`POST /api/auth/login` 先查 UserStore,再查 SubUserStore;`resolveUser` 同时支持两种 sub(token sub 既可能是 user.id 也可能是 subUser.id;子用户 parent 被删 → 401)。**`/api/auth/unlock` 兼容别名只走主账号 admin**,子用户不能用这条。
- **不做的事**:每 rcc 账号独立 unix(可向前兼容,但本期 N:1 优先);root 主进程 / setuid worker / 容器隔离;跨账号资源分享。
- **部署门槛**:`/etc/sudoers.d/remote-cc` 白名单(命令绝对路径,不开 ALL/bash);每个 unix 用户自己登一次 claude 拿订阅;admin 在 UI 给主账号填 unixUser。详细步骤见 `README.md` 多用户部署章节 + `deploy/sudoers.remote-cc.example`。

### 聊天模式实现要点

同一个原生 tmux 会话喂两路:轮询 `capture-pane` 经 `paneScraper` 去 chrome 出**逐字流式预览**;`TranscriptTail` 监听 claude 写的 `~/.claude/projects/<cwd>/<sessionId>.jsonl`(用 `find … -name <sessionId>.jsonl` 定位)出**结构化消息**。输入用 `tmux send-keys`/`paste-buffer`;`KeyBar` 发真实按键驱动 TUI 菜单,`TerminalPeek` 兜底看原始屏。详见 `docs/superpowers/specs/2026-06-20-native-chat-ui-rebuild-design.md`。

**选择题(AskUserQuestion)走 hook 真值,不读屏**:启动 claude 时经 `--settings`(叠加,不动全局配置)注册 `scripts/hooks/rcc-ask-hook.mjs` 的 `PreToolUse`/`PostToolUse`(matcher 精确 `AskUserQuestion`)+ env `RCC_ASK_DIR`。Pre 把工具输入(问题/选项/说明/多选)原子写 `$RCC_ASK_DIR/<sessionId>.json`、Post 删之;`chatSession.tick` 读 sidecar 出**富卡片**(`LiveAskCard`),作答用 `AskDriver` 的**绝对数字键**(按编号选、不受光标位置影响,挪光标也不点歪),完成由 sidecar 消失(PostToolUse)确认。`askDir` 未配时整条退回既有读屏 `parseAskPickerLive`/`AskController` 兜底。**单选单问题是一等公民**(已真机冒烟);**多选、多问题为最佳努力/实验性**(多选统一降级 AskController;多问题仅单测覆盖、真机未验),拿不准时终端/KeyBar 手动作答始终可用。详见 `docs/superpowers/specs/2026-06-21-chat-ask-hook-driven-design.md`。
