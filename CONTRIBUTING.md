# Contributing to remote-cc

感谢对 remote-cc 的关注。本项目仍在快速演进中，欢迎 issue / PR，但请遵守以下约定（CLAUDE.md 也有同样的开发约定，给 AI 协作者看的）。

## 提交流程

1. **先开 issue** 描述你想做什么（bug fix 也建议开,方便讨论范围）。
2. fork → 新分支(命名 `feat/...` 或 `fix/...`) → 写测试 → 写实现 → 自测通过。
3. PR 描述里说清「为什么」、「怎么验证」、「对老用户影响」。提交信息中英文均可,主旨说清。
4. CI(GitHub Actions)必须全绿才合。

## 开发约定（来自 CLAUDE.md，硬性）

1. **不删除现有可用功能** — 新能力一律并行增量,可切换不替换。
2. **改动简单、职责清楚、可维护** — 文件小而专、依赖注入便于测试,不做无关重构。
3. **服务器侧跑真正原生的 Claude Code** — 聊天模式也用交互式 `claude`,不走 headless `-p`/stream-json 路径。
4. **会话持久化用 tmux + claude 原生 resume** — `--session-id <uuid>` 启动、`--resume <uuid>` 恢复。
5. **手机优先,流式硬要求**。
6. **TDD** — `apps/server` 与 `packages/shared` 用 vitest 测试源码共置(`*.test.ts`),纯逻辑抽函数单测,IO 用注入的 fake。
7. **真实集成验证** — tmux/claude 相关改动跑真实冒烟(`apps/server/scripts/smoke-chat.ts`)。
8. **后台进程用 tmux,不用 nohup**(可观测)。

## 代码风格

- TypeScript 严格模式,`strict: true`,`noUnusedLocals: true`。
- ESM。Node ≥ 22。
- 命名:文件 `camelCase.ts`(React 组件 `PascalCase.tsx`)、变量/函数 `camelCase`、类型 `PascalCase`。
- 注释:中文为主,讲「为什么」而不是「是什么」。

## 本地开发

```bash
nvm use                 # Node 22
npm install
cp .env.example .env    # 改 ADMIN_PASSWORD / SESSION_SECRET
npm run dev:server      # 后端 :4400
npm run dev:web         # 前端 :5173
npm test                # 跑 shared + research-core + server 测试
npm run typecheck       # 全包 typecheck
```

宿主需有 `tmux` 与 `claude` CLI(Claude Code)。会话引擎以宿主进程操纵 tmux + claude,故无法容器化。

## 报 bug 须知

涉及聊天/终端会话异常的 bug,请提供:
- 浏览器 console + Network 标签的截图(若涉及前端)。
- 后端日志(`logs/server.log` 的相关时间窗口)。
- `tmux -L rcc ls` 输出 + 出问题会话的 `tmux -L rcc capture-pane -t <name> -p` 末尾几屏。
- claude transcript 路径 `~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl` 的末尾几条。

## Security

发现安全问题(尤其是鉴权绕过、命令注入、路径逃逸)请**不要公开 issue**,而是给维护者发 security advisory(GitHub → Security → Report a vulnerability),或邮件联系 repo owner。

会话引擎本质是「按管理员配置开 shell / 跑 claude」,等价于远程终端 — 默认监听 127.0.0.1,**绝不要直接暴露公网**,必须经反向代理 + TLS + 强口令。
