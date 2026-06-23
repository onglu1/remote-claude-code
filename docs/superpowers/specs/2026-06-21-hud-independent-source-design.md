# 聊天 HUD「不依赖 claude-hud」的独立数据源设计

日期：2026-06-21
状态：已与用户确认方案，进入实现

## 背景与问题

现在聊天 HUD（`hudScraper.scrapeHud`）**只靠读屏 claude-hud 渲染的状态行**。这有两个硬伤：

1. **强依赖 claude-hud**：没装 claude-hud（或 statusLine 是别的格式）的环境，聊天 HUD 完全失效。
2. **数据不全/不准**：读屏只能拿到 claude-hud 已经格式化好的字符串；context 百分比是 claude-hud 的近似，**5h/周用量只有装了 claude-hud 才有**。

真正的数据源其实是 **Claude Code 喂给 statusLine 命令的 stdin JSON**——claude-hud 只是个把这份 JSON 渲染成一行字的格式化器。该 JSON（已实测）形状：

```json
{ "transcript_path": "...", "session_id": "...", "cwd": "...",
  "model": { "id": "...", "display_name": "..." },
  "context_window": { "context_window_size": 1000000, "used_percentage": 19.2,
    "current_usage": { "input_tokens": 1, "cache_creation_input_tokens": 2,
      "cache_read_input_tokens": 3, "output_tokens": 4 } },
  "rate_limits": { "five_hour": { "used_percentage": 14, "resets_at": 1750500000 },
    "seven_day": { "used_percentage": 14, "resets_at": 1751000000 } } }
```

- context 准确值 = `context_window.used_percentage`（原生，等同 `/context`）；或 `(input+cache_creation+cache_read)/context_window_size`。
- **5h/周用量只在 `rate_limits` 里**（磁盘/transcript 都没有）。
- transcript 每条 assistant 有 `message.usage`，可推 context tokens，但**不含窗口大小**。

## 目标

- 给 HUD 增加一个**不依赖 claude-hud** 的数据源：任何环境只要 remote-cc 配好就能用。
- **不破坏现有行为**：读屏 `scrapeHud` 兜底保留；若用户装了 claude-hud，我们链式调用它，**终端 HUD 原样不变**。
- 聊天 HUD 数据源分层优先级合并，前端用量条样式统一为一行紧凑、手机友好。

## 方案总览

remote-cc 自己挂一个 statusLine 捕获脚本，把 Claude Code 喂进来的 stdin JSON **按会话落到 sidecar 文件**；聊天会话读这个 sidecar 拿到完整 HUD 数据。

```
Claude Code ──(stdin JSON,每次刷新状态栏)──► rcc-statusline.mjs
                                               ├─ 原子写 sidecar:  $RCC_STATUSLINE_DIR/<sessionId>.json
                                               └─ 链式下游: bash $RCC_STATUSLINE_DIR/downstream.sh（原 claude-hud）
                                                  └─ 其 stdout 透传 → 终端状态栏（claude-hud 原样）
                                                  └─ 无下游则自渲染一行兜底

聊天会话 tick():
  sidecar(<sessionId>.json, mtime≤15s) ──完整── ► Hud{source:'statusline'}
   └─否则→ transcript 末条 assistant.usage ──context── ► Hud{source:'transcript'}（叠加 pane 用量若有）
     └─否则→ 现有 scrapeHud(pane) ──► Hud{source:'pane'}
```

### A. 捕获脚本 `apps/server/scripts/rcc-statusline.mjs`

纯 Node builtin、**极度防御、绝不抛错破坏 TUI**：

1. 读全部 stdin 成字符串 `raw`。try 解析 JSON：从 `transcript_path` 的 basename 去掉 `.jsonl` 得 `sessionId`（无则 `session_id` 字段）。
2. 把 `raw` **原子写**到 `${RCC_STATUSLINE_DIR}/${sessionId}.json`（先写 `.<rand>.tmp` 再 `rename`，`mkdir -p`；目录来自 env `RCC_STATUSLINE_DIR`，默认 `~/.claude/rcc-statusline`）。
3. **链式下游**：若 `${RCC_STATUSLINE_DIR}/downstream.sh` 存在，`spawnSync('bash', [downstream])`，把 `raw` 灌它 stdin，stdout/stderr 透传、退出码透传（保留 claude-hud）。否则**自渲染一行**兜底（`[model] ctx N% | 5h N% | wk N%`）。
4. **任何异常都吞**：写文件失败也尽量执行下游；全失败打印空行 exit 0。**绝不能让用户所有 claude 会话状态栏报错**。

### B. 安装脚本 `apps/server/scripts/setup-statusline.mjs`

读/建 `~/.claude/settings.json`：

- **首次备份** `settings.json.rcc-bak`（仅当尚不存在该备份）。
- **幂等**：若 `statusLine.command` 已指向我们的脚本，只确保 `downstream.sh` 在，直接返回。
- 否则：把**现有** `statusLine.command` 原文写入 `${dir}/downstream.sh`（避免引号地狱，下游用文件而非内联），把 `statusLine` 设为 `{type:'command', command:'RCC_STATUSLINE_DIR=<abs> node <abs rcc-statusline.mjs>'}`。
- 支持 `--undo`：从备份恢复（删 statusLine 注入，恢复原 settings）。
- `start.sh` 末尾**幂等调用一次**（已配好即 no-op）；`package.json` 加 `setup-statusline` 脚本；CLAUDE.md 注明手动 `npm run setup-statusline`。

### C. 配置 `RCC_STATUSLINE_DIR`

- `config.ts`/`.env.example` 加 `RCC_STATUSLINE_DIR`（默认 `~/.claude/rcc-statusline`，相对路径相对仓库根但默认是绝对的 home 路径）。
- `context.ts` 把该目录注入聊天会话 deps（`statuslineDir`），ChatSession 读 sidecar 用。

### D. 聊天 HUD 数据源分层（`hudSource.ts`，纯函数 TDD）

新增 `apps/server/src/lib/session/chat/hudSource.ts`：

- `formatResetCountdown(sec, now)`：把 `resets_at`（秒级 epoch）算成倒计时字符串如 `3h 27m`/`2d 4h`（已过期→`now`）。
- `parseStatuslineStdin(json): Hud | null`：从 stdin JSON 解出 `model`（display_name 优先）、`contextPct`（`context_window.used_percentage` 取整）、`contextTokens`、`contextWindowTokens`、`contextWindow`（窗口标记 `1m`/`200k`）、`fiveHour{pct,text}`、`weekly{pct,text}`（text 用 `formatResetCountdown` 算）；`source:'statusline'`，并保留 `raw`（自渲染一行镜像）。
- `deriveContextFromTranscriptUsage(usage)`：`{tokens, pct?}`；窗口未知时 `tokens>200k` 视为 1M 否则 200k 估 pct，**标注近似**（`approxContext:true`）；至少给 tokens。
- `pickHud({statusline?, transcript?, pane?}): Hud | null`：**优先 sidecar（完整）→ 否则 transcript 的 context（无用量）叠加 pane 的用量(若有) → 否则 pane**。给 `Hud` 加 `source?: 'statusline'|'transcript'|'pane'`。
- sidecar 读取做成可注入 IO：`readStatuslineSidecar(deps, dir, sessionId, now)`，读 `${dir}/${sessionId}.json`，`mtime` 超 ~15s 视为过期忽略。

### E. ChatSession.tick() 接入

`tick()` 里 HUD 部分改成：

1. 先尝试 sidecar（按 `spec.sessionId` + 注入 dir）。
2. 再 transcript（复用 tail 已定位的 jsonl，读最后一条 assistant 的 `message.usage`）。
3. 再现有 `scrapeHud(pane)`。
用 `pickHud` 合并，签名去重后 `onHud`。**保留 `getLiveHud`、保留现有读屏兜底**，不破坏现有行为/测试。

### F. shared 扩展

`chatWs.ts` 的 `Hud` 扩展（全部可选、向后兼容）：`contextTokens?`、`contextWindowTokens?`、`approxContext?`、`source?`。`HudUsage` 不变。

### G. 前端样式统一

`Hud.tsx` + `index.css`：把 **context / 5h / 周** 三个量**并到一行**、同一种细条样式（同高度、同标签格式、同配色：低=常态色 `--accent`、高=警示色 `--danger`）；整体一行紧凑、手机友好、可换行不溢出；点击展开看明细/`raw`。沿用 `themes/tokens.css` 变量，不引依赖、不用浏览器存储。

## 不做 / 边界

- 不碰多用户/改名/资源面板逻辑。
- 不改终端视图（claude-hud 经下游链式调用原样渲染）。
- 不做 headless `-p`；HUD 数据来自 statusLine stdin（Claude Code 原生喂入），与会话运行方式无关。
- sidecar 目录在 home 下（默认），不在仓库内；若用户改到仓库内，把目录与 `*.rcc-bak` 加 .gitignore。

## 风险与缓解

- **脚本破坏所有会话状态栏**：极度防御，所有异常吞掉、空行 exit 0；下游用文件避免引号；先写 tmp 再 rename 避免半文件。
- **下游链式回归 claude-hud**：setup 把原 command 原文存 downstream.sh，rcc 脚本灌 stdin 透传 stdout/退出码，行为等价。
- **sidecar 过期/串话**：按 `<sessionId>.json` 命名隔离会话；mtime>15s 忽略（会话停了不显示陈旧数据）。
- **settings.json 损坏**：首次备份 `settings.json.rcc-bak`，`--undo` 可还原；写入用原子方式。
