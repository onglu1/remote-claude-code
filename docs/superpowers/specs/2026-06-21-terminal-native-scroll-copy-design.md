# 终端模式：原生滚动 / 干净复制 / 大文本懒加载 设计文档

日期：2026-06-21
状态：已定稿（与用户确认）
关系：在现有「终端模式」（`Terminal.tsx` + node-pty attach tmux）基础上**并行增量增强**，不删除、不替换任何现有功能。tmux 持久化、`--resume`、聊天模式抓屏全部不动。

## 1. 背景与动机

现有终端模式：xterm.js（仅加载 FitAddon、默认 DOM 渲染器）← WebSocket 字节流 ← node-pty 跑 `tmux attach` ← tmux 会话里的交互式 Claude Code / shell。

用户在终端模式上的三个实际痛点：

1. **滚动卡**。
2. **没法干净复制**：选一段复制出来带多余换行符，没法批量复制。
3. **右侧有丑滚动条**，还盖住文字。

### 根因分析

- **滚动卡 + 复制带换行的根因是「xterm 全屏 attach tmux」**，不是 tmux 持久化本身。从 xterm 视角，tmux 是一个接管整屏的「全屏程序」，于是 xterm 自己的原生 scrollback 用不上：往上翻只能进 tmux 的 copy-mode（整屏重绘 → 卡），选区按视觉行走（折行处插入换行 → 复制脏）。对照 VSCode Remote-SSH 终端之所以顺滑，是因为它把 xterm 直接接到远端 shell，程序输出顺着字节流进了 xterm 原生 scrollback。
- **DOM 渲染器**重绘慢，放大了实时滚动的卡顿。
- **滚动条**是 xterm viewport 默认滚动条，叠在内容上盖住末列。

### 为什么不替换 tmux

`tmux` 不能简单丢弃：聊天模式整套（`paneScraper`/`askScraper`/`hudScraper`）都靠 `tmux capture-pane` 抓**同一个**会话，且持久化/`--resume` 是项目硬性要求。彻底原生（`tmux -CC` 控制模式浏览器客户端）能拿到 iTerm2 级体验，但要实现控制模式协议解析 + pane/window 管理，工作量大、风险高，与「改动简单清晰」相悖——列为**后续可选项（方案 B）**，本次不做。

## 2. 决策记录（已与用户确认）

1. **采用方案 A（增量增强），保留真实 xterm** 作为实时交互面（准确、能跑一切 TUI，不引入会有「叠字/无法清除」问题的本地输入框）。
2. **live xterm 三处增强**：WebGL 渲染器（canvas→DOM 回退）让实时滚动顺滑；自定义细滚动条不挡字；选中→剪贴板复制（快捷键/右键/移动端按钮）。
3. **新增原生「历史/复制」阅读层**：用 `tmux capture-pane -p -J -S … -E …` 抓**真实屏幕字符**（`-J` 合并折行 → 复制无多余换行），渲染成原生 `<div>` 文本流，浏览器**原生选中、原生顺滑滚动**。它抓的是真实屏幕、不做任何解析猜测，故 100% 准确（不会有聊天模式的识别不准）。
4. **进入方式：在 live 终端里向上滚动到顶即无缝切进阅读层**并定位到底部（衔接刚滚过的内容）；回到底部即退回实时。另保留显式按钮兜底。
5. **懒加载**：阅读层按窗口取数，初次只取最新一窗，向上滚到顶再取上一窗 `prepend` 并保持滚动位置不跳；分块缓存，传输永远小块。
6. **职责拆分 / 数据流**：实时 = 现有 WS 字节流**完全不动**；阅读层 = **独立只读 HTTP 拉取**，不碰 WS、不碰会话写入。两条线零共享可变状态。
7. **手机优先保留**：终端模式用户更偏桌面，但阅读层在手机上同样可用（复制按钮 + 原生触摸滚动）。

## 3. 诚实的能力边界

- **全屏 TUI 的实时打字延迟无法消除**：任何远程终端，程序回显都要走一个来回（原生 SSH 亦然）。这与 VSCode Remote-SSH 同级，不在本次目标内。
- **阅读层对全屏 TUI（备用屏幕）**：`capture-pane` 抓的是当前屏 + 历史卷动区的真实字符，能正常复制/滚动；但全屏 TUI 的「应用内历史」（如其自身分页）不归 tmux 历史管，这点同 VSCode 限制。常见 shell 输出（claude 走普通缓冲区打印的对话、git/ls/npm 输出）完全覆盖。

## 4. 架构与组件

分层遵循既有约定：`packages/shared`（zod 类型）+ `apps/server`（`lib/` 领域逻辑 + `routes/` 按域）+ `apps/web`（组件）。

### 4.1 shared

- 新增 `scrollback.ts`：`ScrollbackChunk` zod 类型（`lines: string[]`、`nextBefore: number | null`、`atTop: boolean`）。供前后端共用。

### 4.2 server

- **`lib/session/tmux.ts`** 增两个薄封装（纯参数拼装 + 注入式 exec，便于单测）：
  - `historySize(name)`：`tmux display-message -p -t <name> '#{history_size} #{pane_height}'` → `{ historySize, paneHeight }`。
  - `captureRange(name, start, end)`：`tmux capture-pane -p -J -t <name> -S <start> -E <end>` → 文本。`-J` 合并折行。
- **`lib/session/scrollback.ts`**（新，纯逻辑）：窗口换算。给定 `historySize`、`paneHeight`、`before`（游标，缺省=总行数）、`limit`，算出本窗的 tmux `-S/-E` 行号与下一个 `nextBefore`、`atTop`。把 tmux 的行坐标语义（行 0=可见区首行、负数=历史、底部=paneHeight-1）封装在这里并**纯函数单测**。
- **`routes/`** 新增只读端点：`GET /api/projects/:id/conversations/:cid/scrollback?before=<n>&limit=<n>`，`requireAuth` + 项目可见性校验（与现有路由一致）。组合 `historySize` + `scrollback` 窗口换算 + `captureRange`，返回 `ScrollbackChunk`。会话不存在/ tmux 无该会话 → 空 chunk（容错，不 500）。

### 4.3 web

- **`components/Terminal.tsx`**：
  - 加载 WebGL 渲染器：`new WebglAddon()`，`onContextLoss` 时弃用回退 canvas/DOM；构造失败也回退。不破坏现有 FitAddon/连接逻辑。
  - 选中复制：监听 `Cmd/Ctrl+C`，有 `term.getSelection()` 则 `navigator.clipboard.writeText` 并阻止默认（否则照常把 `^C` 发给会话）；右键菜单复制/粘贴；keybar 增「复制」键（移动端复制当前选区或可见屏）。
  - 滚到顶检测：监听 xterm viewport 的滚动（或 wheel），到顶且继续向上 → 打开阅读层（`ScrollbackReader`），初始定位底部。
- **`components/ScrollbackReader.tsx`**（新）：
  - 打开即 `GET …/scrollback`（无 `before`）取最新一窗，渲染原生 `<div class="sb-line">` 文本流并贴底。
  - 反向无限滚动：滚到顶触发取 `before=nextBefore` 的上一窗，`prepend` 后用「新内容高度差」校正 `scrollTop` 保持不跳。
  - 复制：原生选区 + 「复制全部 / 复制可见」按钮（`navigator.clipboard`）。
  - 关闭：滚到底/点关闭 → 退回 live 终端。
- **CSS**（`index.css` 或组件级）：细、半透明、悬浮、不占字符列的滚动条（live xterm viewport 与阅读层共用一套）。

## 5. 测试策略（TDD）

- **纯逻辑单测**（vitest，与源码共置）：
  - `scrollback.test.ts`：窗口换算的边界（首窗 / 中间窗 / 触顶 / `historySize=0` / `limit>总行数` / `before` 收敛到 0）。
  - `tmux.test.ts`：`historySize`/`captureRange` 的 argv 拼装（含 `-J`、`-S/-E`）用注入 fake exec 断言。
- **路由测试**：`scrollback` 端点鉴权 + 可见性 + 正常/容错返回（fake tmux）。
- **前端**：`ScrollbackReader` 的「滚到顶加载更多 + 保持位置」「复制选区」行为测试（jsdom + mock fetch）；若前端无既有测试设施则以最小集成验证替代。
- **真实冒烟**：起一个 `tmux -L rcc` 会话灌入足量行 → 调 `scrollback` 端点验证分页与 `-J` 合并 → 前端手测滚到顶切换、原生选中复制、滚动条外观。涉及 tmux 的改动必须真实冒烟后才声称完成。

## 6. 不在本次范围（YAGNI）

- 方案 B：`tmux -CC` 控制模式客户端（终极原生，后续可选）。
- 阅读层打开后对会话**新输出的实时追加**（v1 为打开时刻快照 + 向上懒加载；要看最新重新进入即可）。
- 全屏 TUI 应用内分页历史的抓取。

## 7. 验收标准

- 实时终端滚动明显顺滑（WebGL 生效，有回退保险）。
- 右侧滚动条不再盖字、观感干净。
- 向上滚到顶能无缝进入原生阅读层，滚动如浏览网页；选一段复制**不带多余换行**，可批量/一键复制。
- 大历史下传输分块、不卡（懒加载生效）。
- 现有终端实时交互、聊天模式、持久化/`--resume` 全部不回归（`npm test` + `npm run typecheck` + `npm run build` 通过，真实冒烟通过）。
