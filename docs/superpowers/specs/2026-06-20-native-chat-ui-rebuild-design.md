# remote-cc 原生聊天模式（基于真实 tmux 会话的双路渲染） 设计文档

日期：2026-06-20
状态：已定稿（v3，已实测验证）
关系：在 `2026-06-20-remote-cc-design.md` 基础上**新增**第二套会话「启动方式/视图」，不删除原 tmux 终端方案。原 spec 全部章节继续有效。

## 1. 背景与动机

现有「终端模式」把交互式 Claude Code TUI 跑在 tmux 里，原始字节流灌给 xterm.js。手机端没有可滚动历史、无法范围选择/复制——这是「终端直传 TUI（备用屏幕原地重绘）」的硬限制。

目标：**新增「聊天模式」**，在手机上像原生 AI 网页一样对话（气泡、Markdown、平滑滚动、可选可复制、逐 token 流式），同时**服务器侧跑的就是 100% 原生交互式 Claude Code**（与手敲零区别：斜杠命令/skill 必然支持、无任何自动化/headless 路径的行为或风控差异），并保留 tmux 持久化与 `--resume` 恢复。

**关键洞察（已实测）：** 原生交互式会话既把对话写成干净的结构化 `transcript jsonl`，又在终端屏幕上逐 token 渲染。于是同一个真实会话可喂两路数据：读屏得到**逐字流式预览**，读 transcript 得到**干净的结构化最终渲染**。

## 2. 决策记录（已与用户确认）

1. 两套并存：保留「终端模式」(tmux + xterm，原样)，新增「聊天模式」。每会话用 `Conversation.mode` 区分。
2. 聊天模式跑**原生交互式** Claude Code（不用 headless `-p`），消除风控/斜杠/保真疑虑。
3. **逐 token 流式**：从终端读屏(capture-pane)实时抽取在生成中的助手文本做预览；消息完成后用 transcript 的干净版**覆盖**预览。
4. 持久化用 tmux + claude 原生 `--session-id`/`--resume`：每会话一个 UUID，确定性定位 transcript 与恢复。
5. 交互形态：原生可点选卡片 + 常驻按键条（按键条发真实按键到 pane，驱动 TUI 内的菜单）。
6. 默认权限：沿用项目 `launchCommand`（当前 `Fable-yolo` = `--dangerously-skip-permissions`，即 bypass）。
7. 并行实现、职责拆分、可维护：聊天模式以**新增**为主，复用现有 `Tmux`，与终端模式零共享可变状态。

## 3. 实测事实（本机 `claude 2.1.141`，已验证）

- `claude --session-id <uuid>` 启动交互式会话，transcript 确定性落在 `~/.claude/projects/<编码cwd>/<uuid>.jsonl`；用 `find ~/.claude/projects -name '<uuid>.jsonl'` 定位最稳（uuid 全局唯一，免去编码规则）。
- 别名透传参数：`bash -ic 'Fable-yolo --session-id <uuid>'` 正确展开为 `claude … --session-id <uuid>`。
- `tmux capture-pane -p` 在生成过程中能读到**逐步增长**的助手正文；chrome 规律稳定：助手正文行首 `● `(首行)/2 空格(续行)；生成中底部有 spinner（`✽ Slithering…`），完成有 `✻ Cooked for Ns`；底部输入区是 `───` / `❯ ` / `───` / `  [model] …% | …` / `  ⏵⏵ …`；顶部欢迎框 `╭─── Claude Code …╰───`。
- transcript 的 assistant text 块是**干净 markdown**（无 chrome），含 thinking/tool_use/tool_result/image 等结构块；tool_use 先写后执行，故一轮内逐条追加（步骤级实时）。
- 恢复：tmux 在则 attach；tmux 没了但有 uuid+transcript 用 `--resume <uuid>`；全新则 `--session-id <uuid>`。

## 4. 架构（两套并行，聊天模式复用 tmux）

```
                         手机浏览器
       ┌─────────────────────┴──────────────────────┐
   终端会话(旧, 原样)                          聊天会话(新)
   Terminal.tsx / xterm                       ChatView
     │ WS 字节流 /…/stream                       │ WS 结构化 /…/chat
   registry + ptyBridge(node-pty)             chat/chatRegistry + chatSession
     │                                          │  ├─ 输入: tmux send-keys / paste-buffer
     │                                          │  ├─ 流式预览: 轮询 capture-pane → 去 chrome
     │                                          │  └─ 结构化: 监听 transcript jsonl
     └──────────── 同一个 tmux(-L rcc) 会话引擎 ───────────┘
                         claude(交互式 TUI)
```

聊天模式**不需要 node-pty**：用 `tmux new-session -d` 起会话（tmux 自身保活），I/O 全走 tmux 子命令 + transcript 文件。两套只共用 `Tmux` 封装、项目注册表、鉴权。

## 5. 后端：新增聊天引擎（`apps/server/src/lib/session/chat/`）

- `paneScraper.ts`（纯函数，重点单测）：
  - `stripChrome(pane: string): { messages?, livePreview, running }`——去欢迎框/底部输入区，取最后一个 `❯` 用户回显之后的助手区域，剥 `● `/缩进/spinner，得到在生成中的预览文本；并由 spinner/`esc to interrupt` 判定 `running`。
  - 用 §3 真实快照夹具（boot/spinner/streaming/complete）做单测。
- `transcriptWatcher.ts`：
  - `locate(sessionId)`：glob `~/.claude/projects/**/<uuid>.jsonl`。
  - `readAll()`：解析全量 → 结构化消息（user/assistant/text/thinking/tool_use/tool_result/image），供首连/重连回放。
  - `tail(onMessage)`：记录字节偏移，fs.watch + 兜底轮询读增量；文件未出现时等待其出现。
  - 解析与「行 → 规整 ChatMessage」抽纯函数单测（用真实 transcript 片段夹具）。
- `chatSession.ts`：一个聊天会话的运行时：
  - `ensure()`：tmux 有则用；否则按 `sessionId` 决定 `--resume <uuid>` 或全新 `--session-id <uuid>` 起 `new-session -d`（命令 = `bash -ic '<launchCommand> <idфлаг>'`）。
  - `sendText(text)`：`set-buffer -- text` + `paste-buffer`（多行/特殊字符安全）+ `send-keys Enter`。
  - `sendKey(key)`：`send-keys`（Up/Down/Left/Right/Enter/Escape/C-c）——驱动 TUI 菜单与中断（Esc）。
  - 轮询 `capture-pane`（仅 `running` 时高频 ~6–10Hz，idle 时停）→ 经 `paneScraper` 出 `livePreview`/`turn_state`。
  - 接 `transcriptWatcher` → 出结构化消息。
  - `dispose()`：停轮询/取消 watch；**不** kill tmux（后台续跑）。
- `chatRegistry.ts`：convId → { chatSession, subscribers, seq, eventBuffer }；首个订阅者 `ensure`，多订阅共享，末个离开不杀会话；重连用 transcript 全量 + 当前预览回放。
- `routes/chat.ts`：新 WS 端点 `/api/projects/:id/conversations/:cid/chat`，鉴权同 sessions；收发 §6 协议。

终端侧 `tmux.ts`/`ptyBridge.ts`/`registry.ts`/`routes/sessions.ts` 仅**小改**（Tmux 增 `sendKeys/setBuffer/pasteBuffer/newDetached/sessionExists` 等薄封装；sessions 创建接受 `mode`、列表带 `mode`），不动既有行为。

## 6. WS 协议（新增 `packages/shared/src/chatWs.ts`，旧 `ws.ts` 不动）

客户端 → 服务端：
```
{type:'user_text', text}     {type:'key', key}      // key: up/down/left/right/enter/esc/ctrl-c
{type:'image', dataB64, mime, name}                 // 存临时文件→把路径作为 user_text 发送
{type:'interrupt'}           {type:'resync'}        // 重新拉全量
```
服务端 → 客户端：
```
{type:'history', messages}              // 首连/重连：transcript 全量结构化
{type:'message', message}               // 新增/更新一条结构化消息(含 tool 卡片)
{type:'preview', text}                  // 在生成中的逐字预览(覆盖式)
{type:'turn_state', running}            // 驱动停止按钮/输入禁用/预览显隐
{type:'session', sessionId, name, mode} {type:'error', message}
```
全部 zod 校验（沿用现有 `decode*/encode*` 风格）。

## 7. 前端：新增聊天组件（`apps/web/src/components/chat/`）

- `ChatView`：容器；管 WS、history/message 合并、preview 覆盖、turn_state。
- `MessageList`/`MessageBubble`：用户/助手气泡；助手 Markdown（代码高亮/表格/列表），可选可复制；在生成中渲染 `preview` 为临时气泡，`message` 到达即替换。
- `ToolCard`：折叠渲染 tool_use+tool_result（Edit/Write 显 diff、Bash 显命令+输出、其余摘要）。
- `Composer`：多行输入；发送；`/` 唤 `SlashPalette`（基于会话 slash 列表，或本地常用集）；图片按钮；`@` 复用 `FileBrowser` 插路径。
- `KeyBar`（常驻）：`↑↓←→/回车/Esc/Ctrl-C` → 发 `key`；空输入框时上键回溯历史输入（前端态）。
- `TerminalPeek`（折叠兜底）：需要时显示当前 `capture-pane` 文本，确保任何 TUI 菜单都能看到并用按键条操作。
- 会话列表按 `mode` 显示徽标，点开路由到 `Terminal` 或 `ChatView`；创建会话时选启动方式。视觉沿用 `themes/tokens.css`。

## 8. 共享 DTO 变更（仅追加，`packages/shared`）

- `Conversation` 追加 `mode: 'terminal'|'chat'`（默认创建时选；存量视为 `terminal`）、`sessionId?`（chat）。`tmuxName` 保留。
- 新增 `ChatMessage`（角色 + 内容块投影）、`ContentBlock`、§6 chatWs schema。旧 `ws.ts` 不动。

## 9. 受影响文件

- **新增**：`lib/session/chat/{paneScraper,transcriptWatcher,chatSession,chatRegistry}.ts`(+各 test)、`routes/chat.ts`、`packages/shared/src/chatWs.ts`、`apps/web/src/components/chat/*`、`apps/web/src/lib/chatWs.ts`、测试夹具(真实快照/transcript 片段)。
- **小改**：`lib/session/tmux.ts`(加薄封装)、`lib/conversations.ts`(存 mode/sessionId)、`shared/src/schemas.ts`(Conversation 字段)、`routes/sessions.ts`(创建带 mode)、`context.ts`/`app.ts`(挂 chatRegistry/route)、`ConversationList`/`ProjectDetail`(mode 徽标+分发+创建选择)、前端依赖(加 markdown 渲染)。
- **不动**：`ptyBridge.ts`、`registry.ts`、`Terminal.tsx`、`lib/ws.ts`、`packages/shared/src/ws.ts`、files/taskEvidence/auth/plugins。
- README 补「两套启动方式」。

## 10. 风险与取舍

- **读屏预览的脆弱性**：仅作过渡预览，完成即被 transcript 干净版覆盖，糙一点无碍；用真实快照夹具单测 `stripChrome`，降低版本耦合风险。
- **TUI 菜单**：bypass 默认下权限菜单不出现；plan 等菜单用 `TerminalPeek` + 按键条兜底，常见菜单可后续做成 ChoiceCard。
- **后端崩溃丢进行中一轮**：tmux 保活 + resume 保住历史，仅丢正在生成的单轮，已接受。
- **多端**：单管理员，多端镜像同一会话即可。
- **任意命令执行**：与原设计一致，单口令 + 私网/CF 隧道收敛。

## 11. 测试策略（vitest 共置）

- `paneScraper`：用 boot/spinner/streaming/complete 真实快照，断言 chrome 剥离、预览抽取、running 判定。
- `transcriptWatcher`：用 transcript 片段夹具，断言行→ChatMessage 解析、增量偏移、工具块配对。
- `chatSession`/`chatRegistry`：注入假 Tmux/watcher，验证 ensure/resume 选路、send 组装、轮询起停、订阅共享、断开续跑。
- `chatWs`：每消息 encode/decode 往返 + 非法拒绝。
- 前端：preview→message 替换、ToolCard、KeyBar 发键、Composer/SlashPalette。
- 终端模式既有测试保持通过（回归）。
- 集成冒烟：真实起一个 chat 会话发一句，断言出现 preview→message 且 transcript 落盘。
