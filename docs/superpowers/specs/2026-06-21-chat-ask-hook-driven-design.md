# 聊天模式 AskUserQuestion「hook 驱动」设计（取代读屏识别）

日期：2026-06-21
状态：已与用户确认方向与作答安全机制，进入实现
关联：取代 `2026-06-21-chat-live-ask-detection-design.md` 的「读屏检测」前提；该文不删，作为历史与读屏兜底的说明。

## 背景与根因

聊天视图对 `AskUserQuestion` 选择题，先前**完全靠读屏**(`capture-pane` + `parseAskPickerLive`)做两件事：① 检测「待答」② 提取选项。读屏永远做不准，原因实测可见：

- 每个选项在 TUI 里是**多行**渲染（`1. Apple` 下还跟一行说明 `苹果`）。
- claude 会在真实选项后**自动追加** `Type something.` / `Chat about this` 两项。
- 选项上方还有问题正文/`header`，形态多变。
- 多种菜单（rewind / slash / 权限提示）都带「↑/↓ to navigate」footer，宽泛识别会误判。

之前的设计还误以为待答期 transcript 里有该 `tool_use`，实测证明被缓冲在内存里、答完才落盘 —— 即读屏是唯一实时信号源这一前提本身就把方案逼进了死胡同。

## 真值源：PreToolUse / PostToolUse hook（已真机验证）

`AskUserQuestion` 本质是一次工具调用。Claude Code 的 hook 在工具执行前后触发，把**完整结构化输入**以 JSON 经 stdin 交给 hook 命令。实测（`claude 2.1.141`，隔离 tmux 会话）：

- **PreToolUse**：菜单刚打开、待答期（spinner 仍转）即触发。负载含
  `tool_input.questions = [{ question, header, options:[{label, description}], multiSelect }]`，外加 `tool_use_id`、`session_id`、`transcript_path`、`cwd`。问题正文、`header`、每项 `label` 与 `description`、`multiSelect`、多问题 —— 全部零歧义拿到。
- **PostToolUse**：作答后立即触发，负载多出 `answers:{ 问题 → 所选 label }`（多选为数组）。是「已作答 + 选了什么」的权威回执，**无论谁作答**（卡片/终端/手动）都触发。
- **作用域注入**：启动 claude 时加 `--settings <文件>`（实测**叠加**生效，不动用户全局 `~/.claude/settings.json`，仅对 remote-cc 拉起的会话生效），matcher 精确匹配 `AskUserQuestion` → 对其它工具零开销、对 rewind/slash/权限菜单零误判。

## 作答安全：绝对数字键（已真机验证，杜绝「点歪」）

聊天视图与终端视图是**同一个原生 tmux 会话**，光标可能被人工挪动。相对导航（`Down×i`）依赖光标起点，会「点歪」—— 对 AI 作答是致命的。改用**绝对数字键**：

- 实测：菜单开屏光标在 `1`，先 `Down Down` 把光标挪到第 3 项，再按字面量数字键 `1` → `PostToolUse.answers = Apple`（第 1 项），**不是**光标所在的第 3 项。证明数字键按编号**绝对选择**、一次按键**原子提交**、**不受光标位置影响**。
- 另测：开屏直接按 `3` → 原子选中第 3 项（Cherry）。

故作答 = 给 hook 的第 `i` 个选项（0 起）发字面量数字键 `i+1`。三重保险：

1. **绝对定位**：数字键按编号选，挪光标也点不歪。
2. **按前确认（可选安全闸）**：发键前抓一次屏，仅做**精确断言**「存在 `i+1. <hook 给的精确 label>` 行」。命中才发；对不上（菜单未就绪/不匹配）即**中止转人工**，绝不瞎按。这与「解析整个菜单结构」是两码事：只验证一个已知串是否在场，光标怎么动行号都不变，失败只安全降级、永不误提交。
3. **事后回执**：`PostToolUse.answers` 回真实落点，确认菜单已关、并可回显给用户核对。

整条选择题链路（检测 / 取选项 / 作答）**不需要任何结构化读屏**。

## 目标与硬约束

- 待答的 `AskUserQuestion` 在**菜单打开时**即在聊天界面显示为**富卡片**（问题正文 + 每项说明 + 多选标识）；点选经服务端**绝对数字键**完成，挪光标也不点歪。
- **唯一改动面是「选择题」路径**：纯并行增量。流式预览、运行态、transcript 渲染、rewind、effort、终端视图、KeyBar、TerminalPeek 行为**完全不变**。
- 既有 `askScraper.ts`/`askController.ts`/`parseAskPickerLive` **一行不删**，降级为 hook 不可用（用户关了/旧版 claude/`RCC_ASK_DIR` 未配）时的兜底。
- 仍跑**原生交互式** claude，不引入 headless。

## 数据流

```
claude(--settings 注入 hook, env RCC_ASK_DIR)
  │  AskUserQuestion 待答 → PreToolUse  ─► rcc-ask-hook.mjs pre  ─► 写 $RCC_ASK_DIR/<sessionId>.json {toolUseId,questions,ts}
  │  作答完成（任意来源）→ PostToolUse ─► rcc-ask-hook.mjs post ─► 删 $RCC_ASK_DIR/<sessionId>.json
  ▼
ChatSession.tick():
  readPendingAsk(dir, sessionId)
    无→有   emit ask_pending{question,header,options[{index,label,description}],multiSelect,qIndex,qTotal} + running=false + 抑制预览
    有持续  维持（不重复发同一签名）
    有→无   emit ask_pending_clear
  ▼
前端 LiveAskCard（问题正文 + 各项说明 + 多选）
  点选 index → ask_pending_answer{optionIndices}
  ▼
ChatSession.answerPendingAsk → AskDriver.answer(questions, picks)
   单选：按前确认 → 发字面量数字键 i+1
   多选：逐项数字键 toggle → Enter（最佳努力）
   >9 项 / 数字键不可用：降级 AskController（箭头 + label 校验 + Enter）
  ▼
PostToolUse 删 sidecar → 下个 tick emit ask_pending_clear → 卡片交接给 transcript 最终卡
```

多问题：sidecar 一次给全部 N 题；TUI 一次显示一题。服务端按序逐题发卡（`qIndex/qTotal`），每题作答前用「按前确认」核对当前屏是该题的选项，答完末题后等 sidecar 消失清卡。最佳努力，拿不准即转人工。

## 组件与接口（全部并行增量）

### 新：`scripts/hooks/rcc-ask-hook.mjs`（node hook，入库）
- `pre`：读 stdin JSON，取 `session_id`/`tool_use_id`/`tool_input.questions`，原子写 `$RCC_ASK_DIR/<session_id>.json`。
- `post`：删 `$RCC_ASK_DIR/<session_id>.json`。
- `RCC_ASK_DIR` 未设 → 立即 `exit 0` 空操作（即便被别的会话误触发也无害）。任何异常吞掉、`exit 0`，绝不阻断工具。

### 新：`apps/server/src/lib/session/chat/askHookSettings.ts`
- `ensureAskHookSettings(askDir): { settingsPath; env }`：幂等确保 `askDir` 存在、把含**绝对** hook 路径的 settings JSON 写到稳定路径，返回 `--settings` 用的路径与要注入的 `RCC_ASK_DIR` env。
- 纯拼装 + 一次性 IO，单测注入临时目录。

### 新：`apps/server/src/lib/session/chat/askSidecar.ts`
- `askSidecarPath(dir, sessionId)`。
- `readPendingAsk(dir, sessionId): AskHookPending | null`：读+`JSON.parse`，坏/缺→null。
- `toAskPending(payload, qIndex): AskPending`：把 hook 负载某一题映射成协议 `AskPending`（含 description/header/qIndex/qTotal）。
- 纯函数，临时目录单测。

### 新：`apps/server/src/lib/session/chat/askDriver.ts`
- `answerByNumber(tmux, name, questions, picks, opts): Promise<AskResult>`：单选发 `i+1` 字面量数字键（可选按前确认）；多选逐项 toggle + Enter；`>9` 或确认失败 → 返回 `fallback`，由调用方转 `AskController`。
- 注入 `tmux`（`capturePaneVisible` + `sendLiteralKeys`），fake 单测断言「按了哪些键」。

### 改：`apps/server/src/lib/session/tmux.ts`
- 加 `sendLiteralKeys(name, text)` → `tmux send-keys -l <text>`（发字面量，区别于既有按键名 `sendKeys`）。既有方法不动。

### 改：`apps/server/src/lib/session/chat/chatSession.ts`
- 启动拼 launch 命令处：若 `askDir` 配置，注入 `RCC_ASK_DIR` env + `--settings <path>`（来自 `ensureAskHookSettings`）。
- `tick()`：抓屏前先 `readPendingAsk`。有 → 走 hook 路径发 `ask_pending`（全结构）、`running=false`、抑制预览（复用既有机制，原段不改），**并跳过** `parseAskPickerLive`；`RCC_ASK_DIR` 未配时才回退既有 `parseAskPickerLive`。有→无 → `ask_pending_clear`。
- `answerPendingAsk(optionIndices)`：hook 待答 → `AskDriver.answer`，`fallback` 时转既有 `AskController.answerCurrent`；非 hook → 既有路径。失败发 `onAskPendingFailed`。
- `getLiveAsk()`：hook 模式从 sidecar 读，否则既有内存态。
- 多问题状态机：`currentQ`，逐题发卡/驱动。

### 改：`packages/shared/src/chatWs.ts`
- `AskPendingOption` 增 `description?: string`。
- `AskPending`/`ask_pending` 增 `question?`、`header?`、`qIndex?`、`qTotal?`。其余消息（`ask_pending_clear`/`_failed`/`ask_pending_answer`/transcript 卡片用的 `ask_state`/`ask_answer`）**不变**。

### 改：`apps/web/src/components/chat/LiveAskCard.tsx`
- 顶部显示问题正文 + `header` chip；每个选项下显示 `description`；多问题显示 `qIndex+1/qTotal` 进度。沿用现有 askcard 样式，不动 transcript 的 `AskChoiceCard`。
- 单选点击即提交 `optionIndices=[i]`；多选 toggle + 「发送选择」。`driving`/`failed` 态同现状。

### 改：`apps/web/src/lib/chatWs.ts` / `ChatView.tsx`
- 透传新增字段；渲染逻辑与去重（transcript 出现该 `tool_use` 即清 live 卡）维持。

### 改：`.env` 约定 / `CLAUDE.md`
- 新增 `RCC_ASK_DIR`（聊天 ask sidecar 目录，默认 `~/.claude/rcc-ask`）。

## 错误处理与生命周期

- 作答驱动后超时未见 sidecar 消失（PostToolUse）→ 发 `ask_pending_failed`，提示用终端/KeyBar；菜单还在，手动可答（手动答后 PostToolUse 仍会清卡）。
- 清卡三重保险：PostToolUse 删 sidecar（主）/ transcript 出现该 `tool_use`（既有去重）/ 读屏连续 K tick 检测不到菜单（兜底，仅清理陈旧 sidecar，如 Esc 取消未触发 PostToolUse 的情况）。
- 重连/多镜像：待答态以 sidecar 为准，订阅/resync 时 `getLiveAsk` 重读补发；经 registry 扇出所有客户端同步。
- hook 不可用（`RCC_ASK_DIR` 未配/旧版 claude/用户禁用）：整条退回既有读屏路径，功能不回归。

## 测试

- 单测：
  - `askHookSettings`：幂等、settings JSON 含绝对 hook 路径、返回 env。
  - `askSidecar`：写/读/缺/坏 JSON；`toAskPending` 映射（description/header/qIndex/qTotal）。
  - `askDriver`（fake tmux）：单选发 `i+1` 数字键；按前确认命中/不命中（不命中→fallback 不发键）；`>9`→fallback；多选 toggle+Enter。
  - `tmux`：`sendLiteralKeys` 拼 `send-keys -l`。
  - `chatSession`：sidecar 有→`onAskPending`(全结构)、无→`clear`、待答期 `running=false` 且不发 `onPreview`；`answerPendingAsk` 调 driver、失败发 `onAskPendingFailed`；`RCC_ASK_DIR` 未配时既有读屏路径不变（既有 35 用例须全绿）。
  - `chatWs`（shared）：新字段 encode/decode 往返。
- 真机冒烟 `scripts/smoke-ask-live.ts`（扩展）：注入 hook，断言待答期 sidecar 出现且 `ask_pending` 含 `description`；`Down Down` 挪光标后数字键作答仍精确落在目标项（PostToolUse 核对），sidecar 消失 → `ask_pending_clear`。多问题、3 选项各一条。
- 回归：`npm test`、`npm run typecheck`、`npm run build` 全绿。

## 明确不做（YAGNI）

- 不改 `parseAskPicker`/rewind/effort/终端/KeyBar/transcript 渲染。
- 多选、多问题为**最佳努力 + 兜底**；单选单问题是一等公民。
- 不引入 headless；不改全局 `~/.claude/settings.json`（hook 走 `--settings` 叠加）。
- 选项 >9 时不强求数字键，老老实实降级箭头+label 校验。
