# 实施计划：聊天 HUD 独立数据源

日期：2026-06-21
设计：`docs/superpowers/specs/2026-06-21-hud-independent-source-design.md`

每步小步提交（中文，说清「为什么」）。TDD：纯函数先写失败用例再实现。

## 步骤

### 1. shared：Hud 扩展字段（向后兼容）

- `packages/shared/src/chatWs.ts`：`Hud` 加 `contextTokens?`、`contextWindowTokens?`、`approxContext?`、`source?: 'statusline'|'transcript'|'pane'`（全可选）。
- typecheck 绿。提交。

### 2. hudSource.ts 纯函数（TDD 核心）

- 先写 `hudSource.test.ts` 失败用例：
  - `formatResetCountdown(sec, now)`：`3h 27m`、`2d 4h`、过期→`now`、整点。
  - `parseStatuslineStdin(json)`：完整 JSON → model/contextPct/contextTokens/contextWindowTokens/contextWindow/fiveHour/weekly/source/raw；坏 JSON → null；缺 rate_limits → 无 5h/周；窗口 1m/200k 标记。
  - `deriveContextFromTranscriptUsage(usage)`：tokens 求和、窗口未知近似 pct + approxContext。
  - `pickHud`：sidecar 优先；无 sidecar 时 transcript+pane 用量合并；都无→pane；全空→null；source 正确。
  - `readStatuslineSidecar`（注入 IO）：新鲜→解析；过期 mtime→null；不存在→null；坏内容→null。
- 实现 `hudSource.ts` 使全绿。提交。

### 3. 捕获脚本 rcc-statusline.mjs

- 写 `apps/server/scripts/rcc-statusline.mjs`。
- 独立验证：构造样例 stdin JSON 管道喂入 → 确认 sidecar 写入且内容正确；设 `downstream.sh=echo HELLO` 确认 stdout 透传。提交。

### 4. 安装脚本 setup-statusline.mjs + package.json

- 写 `apps/server/scripts/setup-statusline.mjs`（备份/幂等/--undo）。
- `apps/server/package.json` 加 `"setup-statusline"`；root 可选加透传。
- 验证：跑一次改写 settings + 生成 bak + downstream.sh 含原命令；再跑幂等；`--undo` 还原。提交。

### 5. 配置接线

- `config.ts`/`.env.example` 加 `RCC_STATUSLINE_DIR`。
- `context.ts` 注入 `statuslineDir` 到 ChatSession deps。
- `start.sh` 末尾幂等调用 setup-statusline。
- 提交。

### 6. ChatSession.tick() 接入分层

- `chatSession.ts`：deps 加 `statuslineDir?` 与 sidecar 读取注入；tick HUD 段改 sidecar→transcript→pane + pickHud；新增读 transcript 末条 usage 的能力（TranscriptLike 加 `lastAssistantUsage()` 或在 tail 暴露）。
- 保留 getLiveHud、保留 scrapeHud 兜底；现有 chatSession 测试不破。
- 补/改 chatSession 测试覆盖分层。提交。

### 7. 前端样式统一

- `Hud.tsx`：context/5h/周 一行、统一 Meter（同高度/标签/配色，高占用警示色）；展开看明细+raw+source。
- `index.css`：改 `.hud-*` 为一行紧凑、可换行不溢出、手机友好。提交。

### 8. CLAUDE.md / .gitignore

- CLAUDE.md 注明 `RCC_STATUSLINE_DIR` 与 `npm run setup-statusline`、start.sh 自动调用。
- `.gitignore` 加 `*.rcc-bak`（与 sidecar 目录若在仓库内）。提交。

### 9. 真验证

- `npm run typecheck` / `npm test` / `npm run build` 全绿。
- 脚本独立验证摘要（sidecar、下游透传、幂等、--undo）。
- `./start.sh` 重启 → 连聊天 WS（tmux 跑冒烟）确认 `hud` `source=statusline` 带真实 5h/周 + context%。
- 确认 claude-hud 仍正常渲染（下游透传）。

## 验证命令

- `npm run typecheck`
- `npm test`
- `npm run build`
- `node apps/server/scripts/rcc-statusline.mjs <<< '<sample json>'`
- `node apps/server/scripts/setup-statusline.mjs` / `--undo`
