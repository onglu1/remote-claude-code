# remote-cc 设计文档

日期：2026-06-20
状态：待评审

## 1. 背景与目标

在服务器上跑着 Claude Code（当前 `2.1.141`）和多个项目（科研类、开发类）。希望有一个手机优先的网页，作为这些 Claude Code 会话的「远程窗口」：进网关、选项目、对一个会话发提示词、看它像命令行一样流式输出。会话必须能在后台长期运行——关掉浏览器它继续跑，重开恢复成一模一样的状态并继续流式生成。

核心定位：**网页只是远程窗口，所有执行都由服务器上的 Claude Code 本体完成。** 网页不替代、不重建 Claude Code，只负责把它的输入输出透传出来，外加方便的项目浏览与 task/evidence 管理。

第一优先级：做成一个**可维护、可复用、可拓展的脚手架**，参考同机的 `our-memories` 项目的工程化习惯，先把分层立住，再在上面增量长功能。

## 2. 范围与里程碑

按里程碑交付，保证 spec 聚焦：

- **里程碑 1（核心闭环，MVP）**：口令登录 → 项目列表 → 进项目 → 开/恢复一个 tmux 终端会话（xterm.js 终端直传 + 手机功能键栏）→ Cloudflare Tunnel 部署跑通。
- **里程碑 2**：只读文件浏览 + 单项目多会话管理。
- **里程碑 3**：科研项目的 task/evidence 浏览 + 轻量管理（改状态 / 建链接 / 打标签，写回仓库）。

非目标（本期不做）：网页内的代码编辑器、task/evidence 的完整 markdown 编辑（正文编写仍在 Claude Code 会话里做）、多用户/多角色权限、自动发现项目。

## 3. 总体架构

单仓 Node 应用，与 `our-memories` 同构：

```
remote-cc/
  packages/shared/   共享 TS + zod 类型（项目 / 会话 / 文件 / task / evidence DTO，WS 协议）
  apps/server/       Fastify 后端：鉴权、项目注册表、会话引擎、WS 流、文件浏览、task/evidence
  apps/web/          React + Vite 前端：手机优先、简约；xterm 终端、文件浏览器、task/evidence 面板
  config/            projects.json（项目注册表）
  docs/              设计与说明
  deploy/            Docker / Cloudflare 部署
```

数据流（会话）：

```
手机浏览器 xterm.js  ⇄  WebSocket  ⇄  Fastify(node-pty)  ⇄  tmux(-L rcc) 会话  ⇄  claude 进程
```

claude 进程活在独立的 tmux server 里，与后端进程解耦：后端重启、浏览器关闭都不影响它继续运行。

## 4. 技术栈与目录结构（可维护性）

继承 `our-memories` 的约定：Node 22 + npm workspaces；后端 Fastify，按 `lib/`（领域逻辑，单一职责）与 `plugins/`（横切关注点）分层；前端集中 `themes/` 设计 token；**测试与源码同目录共置（vitest）**。

后端 `apps/server/src/`：

- `index.ts` — 进程入口
- `app.ts` — 组装 Fastify 实例、注册 plugins 与 routes
- `config.ts` — 环境变量校验（zod），唯一配置来源
- `lib/`
  - `projects.ts` — 读写项目注册表 `config/projects.json`，增删改查；**无任何目录扫描/枚举**
  - `session/tmux.ts` — `tmux -L rcc ...` 命令的薄封装（建/attach 参数、list、kill、capture-pane）；纯函数为主，注入 exec 便于测试
  - `session/ptyBridge.ts` — 给定 tmux 会话名 + 尺寸，spawn node-pty attach，暴露 `write/resize/onData/dispose`
  - `session/registry.ts` — convId → 活动 bridge 的注册表；创建/获取/释放；启动时用 `list-sessions` 与现存 tmux 对账
  - `files.ts` — 只读文件浏览（列目录、读文件、二进制/图片识别、**路径越界防护**）
  - `taskEvidence.ts` — 解析 `docs/tasks`、`docs/evidence`、两个 `INDEX.md`；状态/链接/标签的读取与写回
- `plugins/`
  - `requireAdmin.ts` — 口令→token 鉴权（仿 `our-memories` 的 `requireEdit`）
  - `security.ts` / `cloudflareIp.ts` / `staticSite.ts` — 安全头、CF 真实 IP、前端静态托管（沿用模式）
  - `ws.ts` — 注册 `@fastify/websocket`，挂会话流端点
- `routes/` — 按域分组：`auth`、`projects`、`files`、`taskEvidence`，以及会话 WS 端点

前端 `apps/web/src/`：

- `main.tsx` / `App.tsx` / `lib/router.tsx`
- `lib/api.ts` — REST 客户端；`lib/ws.ts` — 终端 WebSocket 客户端
- `themes/` — `tokens.css` + 主题，集中那套「简约非科技风」，统一全站观感
- `components/`
  - `Terminal` — xterm 封装 + fit-addon + 手机功能键栏（Esc / Ctrl+O / Ctrl+C / ↑↓ / Enter / Tab）
  - `FileBrowser` — 列表式逐层浏览 + 文件查看
  - `TaskEvidenceBoard` — task/evidence 渲染、状态、关联互跳、轻量管理
  - `ProjectList` / `ConversationList` / `Login`

拓展心智：**加一个新能力 = 新增一个 `lib/` 模块 + 一组 route + 一个前端组件**，互不污染；共享 DTO 全在 `packages/shared`，前后端类型一致；每个模块配共置测试。

## 5. 鉴权与安全

- 单管理员口令 `ADMIN_PASSWORD`，启动时 argon2id 哈希进内存（或直接给 `ADMIN_PASSWORD_HASH`）。
- `POST /api/auth/unlock { password }` 校验通过后签发 httpOnly Cookie token（`SESSION_SECRET` 签名，TTL 可配 `TOKEN_TTL_HOURS`）。
- 所有受保护 REST 与 WS 升级都校验 token。
- `TRUST_CLOUDFLARE=true` 时从 `CF-Connecting-IP` 取真实 IP。
- 路径越界防护：`files` 与 `taskEvidence` 一切路径先 `realpath`，再校验落在目标项目根内，拒绝符号链接逃逸。
- 注意（取舍）：会话引擎本质是按管理员配置执行命令并开 shell，等价于远程终端。这是产品核心诉求，风险通过「单口令 + 私网/CF 隧道 + 仅管理员」收敛，不再额外做命令白名单。见 §12。

## 6. 项目注册表（显式配置，零扫描）

- 唯一来源：`config/projects.json`。服务端**绝不遍历/爬/扫描任何目录来发现项目**。
- 每个项目条目：

```json
{
  "id": "htransformer",
  "name": "sample-research",
  "path": "/path/to/workspace/sample-research",
  "type": "research",
  "launchCommand": "claude",
  "notes": ""
}
```

字段：`id`（唯一）、`name`（显示名）、`path`（绝对路径）、`type`（`dev` | `research`，**手动设定，不靠探测**）、`launchCommand`（自定义启动命令模板，默认 `claude`，工作目录即 `path`）、`notes`（可选）。

- 网页「添加项目」= 填写信息后向注册表**追加一条**（原子写 + 备份）。无自动分类、无自动发现。
- UI 差异由 `type` 决定：`dev` 进去默认一个会话 + 文件浏览；`research` 额外显示 task/evidence 面板，会话可多开。
- 文件浏览说明：浏览的是**已登记项目内**的目录，点哪列哪、单次按需读取，属于用户主动触发的读取，不是后台扫描。（如需进一步限制为白名单子目录，可在条目里加 `browseRoots`，本期默认整项目根可浏览。）

## 7. 会话引擎（核心）

**一个会话 = 一个具名 tmux 会话，内跑一个 `claude` 进程。** 用独立 tmux server socket `-L rcc`，与用户自己的 tmux 完全隔离。

- 会话命名：`rcc-<projectId>-<convId>`，避免与用户既有 tmux 冲突。
- 建/恢复：node-pty spawn `tmux -L rcc new-session -A -s <name> -c <project.path> -x <cols> -y <rows> -- <launchCommand>`。`-A` = 不存在则建、存在则 attach，天然让「首次创建」与「重连恢复」走同一条路径。
- 输入：浏览器键入 → WS → `pty.write(bytes)` 原样写入 tmux 当前 pane（终端直传）。手机功能键栏发送对应控制序列（如 Ctrl+O = `\x0f`）。
- 输出：node-pty `onData` → WS → `xterm.write`，原汁原味 CLI/TUI 流式。
- 尺寸：xterm resize → WS `resize` → `pty.resize(cols, rows)`；tmux 窗口随动。单客户端使用，尺寸一致无冲突。
- 重连恢复：新 WS → 后端新建一个 `attach` pty → tmux 自动重绘当前屏幕；需要更早的历史时，调 `tmux capture-pane -p -S -<N>` 回放最近 N 行（前端「加载更多历史」按钮触发）。
- 断开：WS 关闭 → 释放 attach pty，但**不 kill tmux 会话**，claude 继续跑。
- 列表/状态：`tmux -L rcc list-sessions` 过滤 `rcc-` 前缀，得出各会话存活状态。
- 关闭会话：`tmux -L rcc kill-session -t <name>`。
- 后端重启恢复：启动时 `list-sessions` 对账，重建 registry，前端重连即恢复。

已评估并放弃的备选：纯后端常驻 PTY + 缓冲（后端重启即丢会话）；headless `--print --output-format stream-json`（事件干净但非交互式终端、复刻不了 Ctrl+O 等 TUI 行为）。二者都不如 tmux 贴合「远程的 Claude Code 本体 + 随时恢复」。

多客户端说明：同一会话被多个浏览器同时 attach 会镜像同屏并共享尺寸（tmux 特性）。单管理员场景可接受，文档注明。

## 8. 文件浏览（只读）

- `GET /api/projects/:id/files?path=...` 列目录：返回 `FileEntry[]`（名称、相对路径、`dir`/`file`、大小、mime）。
- `GET /api/projects/:id/file?path=...` 读文件：文本带语法高亮（前端做）、图片直接显示、二进制给「不可预览」提示并可下载。
- 大文件截断 + 提示；所有路径经 §5 越界防护。
- 前端：列表式逐层进入，面包屑返回，手机友好的大点击区。

## 9. task / evidence 面板（浏览 + 轻量管理）

- 解析：读 `docs/tasks/INDEX.md`、`docs/evidence/INDEX.md` 及各 `NNN-*.md`，抽取编号、标题、优先级、状态（待办/进行/完成/废弃）、来源、task↔evidence 编号关联。
- 展示：渲染 markdown（含图片）；列表/看板视图显示编号、优先级、状态；task 与对应 evidence 互跳。
- 轻量管理（写回仓库）：改 task 状态、手动建立/解除 task↔evidence 链接、打标签。写回采用**原子写（写临时文件再 rename）+ 写前备份**，尽量不破坏手写文档结构（优先改 INDEX 表格行 / front-matter，正文不动）。
- 非目标：网页内编辑正文。

## 10. 数据模型 / 共享 DTO（packages/shared）

zod schema + 推导类型，前后端共用：

- `Project { id, name, path, type: 'dev'|'research', launchCommand?, notes? }`
- `Conversation { id, projectId, name, tmuxName, alive, createdAt }`
- `FileEntry { name, path, kind: 'dir'|'file', size?, mime? }`
- `TaskItem { number, title, file, status, priority?, source?, evidenceLinks: string[], tags: string[] }`
- `EvidenceItem { number, title, file, conclusion?, taskLinks: string[] }`
- WS 协议：
  - client→server：`{ type: 'input', data }` | `{ type: 'resize', cols, rows }`
  - server→client：`{ type: 'data', data }` | `{ type: 'status', alive }` | `{ type: 'exit', code }`

## 11. 部署

- 鉴权与暴露沿用 `our-memories`：Cloudflare Tunnel 把公网域名打到本机端口；CF 侧 No-TLS-Verify（或 `TLS_MODE=off` 走 http）；单口令登录。
- **关键差异（取舍）**：本应用必须能访问宿主机的 `tmux`、`claude` 二进制、`~/.claude`、以及各项目真实路径，与宿主强耦合。因此 MVP **直接以宿主进程运行**（Node 22，用 tmux/systemd 守护），而非完全容器化；Cloudflare connector 跑在宿主。Docker 化作为后续可选项（需大量 host 挂载 + claude 登录态），不在 MVP。
- 配置项（`.env`，仿 our-memories）：`PORT`、`HOST=127.0.0.1`、`ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH`、`SESSION_SECRET`、`TOKEN_TTL_HOURS`、`PUBLIC_ORIGIN`、`TRUST_CLOUDFLARE`、`TMUX_SOCKET=rcc`、`PROJECTS_CONFIG=config/projects.json`。

## 12. 风险与取舍

- **任意命令执行**：会话引擎按管理员配置开 shell/跑 claude，等价远程终端。这是产品本身，不做命令白名单；风险靠单口令 + 私网/CF 隧道 + 仅管理员收敛。务必设强口令、保管好 `SESSION_SECRET`。
- **写回损坏手写文档**：task/evidence 写回有破坏 markdown 的风险；以原子写 + 写前备份 + 只动结构化区域（INDEX 行 / front-matter）降低风险，本期不碰正文。
- **tmux 不可用/版本差异**：依赖宿主 tmux；启动时探测可用性并给出清晰报错。
- **手机 TUI 体验**：xterm 在手机上小屏 TUI 仍有局限；用 fit-addon + 字号 + 功能键栏缓解，必要时里程碑 2 之后再优化。
- **多端 attach 同屏共享尺寸**：单管理员可接受，文档注明。

## 13. 设计语言

手机优先、简约：系统字体栈、克制留白、单一强调色、中性表面；**不用渐变、不用毛玻璃、不走 SaaS 模板感**；导航以列表为主、点击区大。所有视觉常量集中在 `themes/tokens.css`，保证全站一致、易改主题。

## 14. 测试策略

vitest 共置：
- `session/tmux.ts`：注入 mock exec，断言命令拼装、list/kill/capture 解析。
- `session/registry.ts`：用假 bridge 验证创建/获取/释放/对账。
- `files.ts`：临时目录 + 越界用例（`../`、符号链接）必须被拒。
- `taskEvidence.ts`：fixture markdown 验证解析与写回幂等、备份生成。
- `requireAdmin`：口令校验、token 签发/过期。
- 前端：`Terminal` 功能键序列、`api` 客户端、关键组件渲染。
