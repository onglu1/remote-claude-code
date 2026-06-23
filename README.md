# remote-cc

> A mobile-first web window into a persistent [Claude Code](https://docs.claude.com/en/docs/claude-code) session running on your server. Open the page from your phone, talk to Claude Code, close the tab — the session keeps running on your server inside `tmux`, ready to resume the next time you open the page.

[![CI](https://github.com/onglu1/remote-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/onglu1/remote-claude-code/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

---

## What it is (English)

**remote-cc** is a small Fastify + React webapp that lets you reach a real, interactive `claude` (Claude Code CLI) running on a server you control, from anywhere — usually a phone. Two views over the **same** session:

- **Chat view (default)** — looks and feels like a native AI chat app: bubbles, Markdown, smooth scroll, selectable text, token-by-token streaming, collapsible tool-use cards.
- **Terminal view** — `xterm.js` piping the raw TUI bytes for full-keyboard heavy work.

Under the hood every session is just an **interactive** `claude` process inside `tmux -L rcc`, started with `--session-id <uuid>` so it can be resumed deterministically. **No `-p` / stream-json automation path is used**, so slash commands, skills, and Claude Code's UX work exactly as they do natively. Close the browser, kill the backend, reboot the box — the tmux session lives on, and the next render comes from `claude`'s own transcript file.

Why you might want it:

- Run long Claude Code sessions on a beefy workstation / GPU box / colo server, drive them from your phone in bed.
- Persist multi-day work without leaving a terminal open.
- Single auth, multiple projects, zero directory auto-scanning (you register projects explicitly).

What it is **not**:

- Not a hosted SaaS. You run it on your own machine.
- Not an automation harness. There is exactly one human in front of `claude`, and that's you.
- Not safe to expose publicly without a reverse proxy + strong password (see [Security](#security)).

---

## 中文文档

服务器上 Claude Code 会话的「远程窗口」。手机优先的网页网关:口令登录、显式登记项目、对一个常驻的 Claude Code 会话收发、tmux 持久化随时恢复,并提供只读文件浏览与(科研项目的)task/evidence 浏览与轻量管理。

核心理念:**网页只是远程窗口,所有执行都由服务器上的 Claude Code 本体完成。** 关掉浏览器,会话在后台继续跑;重开即恢复成一模一样的状态并继续流式输出。

### 两种视图(同一会话,随时可切换)

会话**不区分**类型——一个会话就是 `tmux -L rcc` 里一个原生 `claude` 进程(始终以 `--session-id` 启动)。同一个会话可用两种视图打开,进入后随时切换、记住上次选择:

- **聊天视图**(默认):像原生 AI 网页那样对话——消息气泡、Markdown、平滑滚动、文字可选可复制、逐 token 流式、工具调用折叠卡片。**服务器侧跑的就是 100% 原生交互式 Claude Code**(斜杠命令/skill 原生支持、无任何 headless/自动化路径的行为差异)。
- **终端视图**:xterm.js 直传 TUI 字节流——完整终端、所有快捷键,适合桌面/重度操作。

聊天视图的实现:同一个原生 tmux 会话喂两路数据——轮询 `capture-pane` 读屏出**逐字流式预览**,监听 claude 自己写的 `transcript jsonl`(用 `--session-id <uuid>` 确定性定位)出**干净的结构化最终渲染**;输入用 `tmux send-keys`/`paste-buffer`;常驻按键条把真实按键发回 pane 驱动 TUI 内的选择菜单,必要时可展开「原始终端」兜底查看。因为终端视图也用同一个 `--session-id` 启动,两种视图共用同一个 tmux 会话、随意切换。设计细节见 `docs/superpowers/specs/2026-06-20-native-chat-ui-rebuild-design.md`。

### 架构

```
                         手机浏览器(同一会话,视图可切换)
        ┌───────────────────┴────────────────────┐
   终端视图 xterm.js                        聊天视图 ChatView
        │ WS 字节流                              │ WS 结构化(history/message/preview)
   Fastify(node-pty) ─┐                  ┌─ Fastify(capture-pane + transcript tail)
                      └──── tmux(-L rcc) 会话:claude 交互式 TUI(--session-id)────┘
```

- `packages/shared` — 共享 zod 类型与 WS 协议(终端 `ws.ts` + 聊天 `chatWs.ts`)
- `packages/research-core` — 科研项目用的 `rlab` 骨干 CLI(task/evidence 模型)
- `apps/server` — Fastify:口令鉴权、项目注册表、会话引擎(终端 `session/*` + 聊天 `session/chat/*`)、文件浏览、task/evidence
- `apps/web` — React + Vite,手机优先、简约设计(xterm 终端 + `components/chat/*` 聊天 UI)

会话进程活在独立的 `tmux -L rcc` server 里,与后端解耦:后端重启、浏览器关闭都不影响它继续运行;聊天模式后端重启后用 `--resume <session-id>` 续上、历史从 transcript 重渲。

### 依赖

- Node ≥ 22
- `tmux` ≥ 3.0
- [`claude`](https://docs.claude.com/en/docs/claude-code) (Claude Code CLI),宿主可直接执行
- 一个交互式 shell 默认能跑 `claude`(本项目默认 `launchCommand` 是 `Fable-yolo`,你可以改成 `claude` 或其它 alias)

会话引擎依赖 tmux + claude 这两个宿主二进制,故**不容器化**。

### 快速开始(开发)

```bash
nvm use                  # Node 22
npm install
cp .env.example .env     # 然后改 ADMIN_PASSWORD 与 SESSION_SECRET
npm run dev:server       # 后端 :4400(用 set -a; . ./.env; set +a 注入环境变量)
npm run dev:web          # 前端 :5173,代理 /api 到后端
```

后端不自带 dotenv,启动前请注入环境变量,例如:

```bash
set -a && . ./.env && set +a && npm run start
```

### 构建与上线(宿主进程)

```bash
npm run build            # 构建前端到 apps/web/dist
set -a && . ./.env && set +a && npm run start   # 启动;server 同时托管 dist
```

或用仓库自带的启动脚本模板。**`start.sh` 本身 gitignored**(每台机器有定制,不进仓库)——首次 clone 后:

```bash
cp start.example.sh start.sh && chmod +x start.sh
./start.sh               # 构建前端 + 停旧实例 + 在 tmux 包里拉起
./start.sh --no-build    # 快速重启(沿用已有 dist)
./start.sh stop          # 停止
```

聊天 HUD 想拿原生 5h/周用量与 context% 数据,在首次启动后**手动**跑一次(opt-in,会改 `~/.claude/settings.json`,自动备份原文件):

```bash
npm run setup-statusline           # 装捕获器
npm run setup-statusline -- --undo # 还原
```

不装也能用,HUD 会退回读屏推算模式。

开机自启(可选):往用户 crontab 加

```
@reboot cd /path/to/remote-cc && ./start.sh --no-build
```

### 暴露公网(自选)

**本项目不内置部署方案** —— 跟典型的全栈 OSS 项目一致。默认监听 `127.0.0.1:$PORT`,公网访问请自行选反向代理 + TLS(Cloudflare Tunnel / Tailscale Funnel / frp + nginx + Let's Encrypt / 自建 WireGuard 等任意一种)。任何方案前请先看 [Security](#security)。

### 登记项目(零扫描)

项目来自显式注册表 `config/projects.json`,服务端**绝不扫描目录发现项目**。可在网页「添加项目」里登记,或直接编辑该文件(`config/projects.example.json` 是模板):

```json
[
  {
    "id": "sample-research",
    "name": "Sample Research",
    "path": "/path/to/workspace/sample-research",
    "type": "research",
    "launchCommand": "Fable-yolo"
  }
]
```

- `type`:`dev`(开发,含会话 + 文件浏览)或 `research`(科研,额外含 task/evidence 面板),手动设定。
- `launchCommand`:自定义启动命令,默认 `Fable-yolo`(在交互式 `bash -ic` 里执行,故 `.bashrc` 的别名/PATH 都生效),工作目录即 `path`。**最常见**的写法是直接 `claude` 或 `claude --model opus`。
- `browseRoots`(可选):限制可浏览的子目录白名单。
- 添加项目时路径用「逐级点选目录」选择器(不用手输),浏览根由 `FS_BROWSE_ROOT` 配置(默认 `$HOME`)。

### 测试

```bash
npm test                 # shared + research-core + server 单元测试
npm run typecheck        # 全包 typecheck
```

task/evidence 的网页编辑(状态/链接/标签)写入 `docs/.rcc-meta.json` 侧车文件,**不改动你手写的 INDEX 与正文**。

---

## 多用户部署(可选)

remote-cc 现在支持把每个 rcc 主账号绑定到本机一个真 unix 用户,让 tmux/claude 以该 unix 身份跑 —— 创建的文件 owner 是各自的、claude 读到的 `~/.claude/`(订阅/token)也是各自的。一个主账号下还能挂多个**子用户**,各自独立用户名/口令登录,unix 身份继承父,资源在 web 层按子用户独立 namespace。

**单用户场景零迁移**:不配 unixUser 字段就和单用户老逻辑一样,跟 admin 跑在同一个 unix 下。

### 安装步骤

1. **创建目标 unix 用户**(本机操作,rcc 不替代 useradd):
   ```bash
   sudo useradd -m -s /bin/bash zhangsan
   sudo passwd zhangsan
   ```
2. **让目标 unix 用户登一次自己的 claude**(为了它有自己的 `~/.claude/.credentials.json`):
   ```bash
   sudo -u zhangsan -i  # 或者 su - zhangsan
   claude /login        # 走完 OAuth
   exit
   ```
3. **配 sudoers**:把 `deploy/sudoers.remote-cc.example` 按本机情况(ServiceUser 名、目标 unix 名、claude 二进制路径)改好,放到 `/etc/sudoers.d/remote-cc`:
   ```bash
   sudo cp deploy/sudoers.remote-cc.example /etc/sudoers.d/remote-cc
   sudo vim /etc/sudoers.d/remote-cc      # 改用户名 + 路径
   sudo visudo -c -f /etc/sudoers.d/remote-cc  # 语法校验
   sudo chmod 0440 /etc/sudoers.d/remote-cc
   ```
4. **(可选)配 per-unix 浏览根**:`.env` 里加 `RCC_FS_BROWSE_ROOT_zhangsan=/home/zhangsan/projects`(缺省回退 `~zhangsan/projects`)。
5. **rcc 网页:admin 登录 → 用户管理 → 新增用户**,unixUser 字段填 `zhangsan`。
6. **新用户登录验收**:用 zhangsan/口令登 rcc,建项目(path 在 zhangsan 家目录下),开聊天发一条 prompt,`ls -la <文件>` 验证 owner=zhangsan。
7. **(可选)子用户**:admin 或主账号在用户管理里给 zhangsan 挂子用户 zhangsan_dev/zhangsan_research,各自独立口令登录、独立 namespace,但 unix 身份都是 zhangsan。

### 工作流

- **想用自己的 claude + 文件 owner 是自己** → 做主账号
- **想用别人的 claude + 文件 owner 也是别人** → 做别人的子用户
- **想跨子用户/主账号共享 claude 订阅而 owner 不同**:本设计不支持(攻击面大),走"做对方的子用户"或"自己登 claude"

### 安全须知

- **sudoers 白名单严格**:绝不开 `(ALL)` 通配,绝不开 `bash`/`sh`,命令路径用绝对路径。
- **不开 root 目标**:sudoers `User=` 一栏只列普通 unix 用户,不含 root。
- **`bash -ic` 不经过 sudo**:tmux 在目标 uid 下 fork bash,sudo 这里只跑 tmux 二进制本身。
- 跨 unix 文件浏览也走 sudo + stat/cat;**ServiceUser 与目标相同时零开销路径直 exec**。

## Security

This thing runs `claude` and arbitrary shells on the host machine on behalf of whoever logs in with `ADMIN_PASSWORD`. Practically that means it's a remote terminal. **Treat it accordingly:**

- **Set a strong `ADMIN_PASSWORD` and `SESSION_SECRET`** in `.env`. The default `change-me` will refuse to start in production.
- **Never expose the service directly to the public internet.** Default bind is `127.0.0.1`. Front it with a reverse proxy that does TLS termination and (ideally) IP allow-listing or an extra auth layer.
- **Project paths are not sandboxed.** The session has the same filesystem access as the user that ran `start.sh`. Run the service as a low-privilege user — not as root.
- **No multi-tenant security model.** All admins see all projects. Use it for yourself or trusted teammates.
- **`launchCommand` is executed by `bash -ic`.** Don't put untrusted strings there.

Found a vulnerability? Don't open a public issue — file a private security advisory via GitHub (`Security` → `Report a vulnerability`).

## Status

Pre-1.0. APIs, schemas, and on-disk config formats may change between minor releases until 1.0. Issue reports are welcome; expect occasional breaking changes until things settle.

## License

[MIT](LICENSE).

## Acknowledgements

- [Claude Code](https://docs.claude.com/en/docs/claude-code) — the actual AI agent that does the work.
- [tmux](https://github.com/tmux/tmux) — the persistence layer.
- [xterm.js](https://xtermjs.org/), [Fastify](https://fastify.dev/), [React](https://react.dev/), [Vite](https://vitejs.dev/), [vitest](https://vitest.dev/), [zod](https://zod.dev/).
