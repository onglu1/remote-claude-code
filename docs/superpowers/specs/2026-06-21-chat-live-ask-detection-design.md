# 聊天模式 AskUserQuestion「实时读屏检测」设计

日期：2026-06-21
状态：已与用户确认方案，进入实现

## 背景与问题（已实测定位根因）

聊天视图对 `AskUserQuestion` 选择题的检测**完全依赖 transcript（`.jsonl`）**。但实测证明：Claude Code 在「待答」期间**不会**把这条 `tool_use` 写进 transcript——整个助手回合被缓冲在内存里，直到问题被作答（或会话退出）才落盘。

实测证据：

- 实时复现脚本观测到，菜单 `t=4.9s` 出现在屏幕上（`capture-pane` 可识别），但 `TranscriptTail.activeChain()` 在之后 8 秒多的整个待答窗口里始终不含该 `tool_use`（从未落盘）。
- 已答会话里 `tool_use` 与 `tool_result` 是作答后**一起**出现的（间隔约 1.5s）；某个会话停在菜单未答处退出，`tool_use` 才在退出时被冲刷出来（有 use 无 result）。
- 待答时屏幕上 `✻ …` spinner 仍在，`scrapePane` 返回 `spinner=true` 且 `preview=''`，故前端表现为「永远转圈、无卡片」。

后果（用户症状）：

1. 待答期聊天界面**看不到卡片**（transcript 空，`hasPendingAsk` 恒假）。
2. 在终端答完后，transcript 才落地，聊天界面**才弹出一张已作答的卡片**，无法再用。

历轮修复都在打磨「作答端」与「transcript 驱动的卡片」，但建立在「待答期 transcript 能给出 tool_use」这一**错误前提**上，故检测路径在待答期永不触发。

## 目标与硬约束

- 让待答的 `AskUserQuestion` 在**菜单真正打开时**就在聊天界面显示为**可点选卡片**；点选经服务端闭环驱动原生 TUI 完成作答。
- **唯一改动面是「选择题」这一条路径**：纯并行增量，任何非 AskUserQuestion 的功能（流式预览、运行态、transcript 渲染、rewind、effort、终端视图、KeyBar、TerminalPeek）行为**保持完全不变**。
- 唯一可靠的实时信号源是 `capture-pane`；transcript 仍负责「作答后」的永久记录与最终卡片。两者自然交接，不双卡。

## 关键风险与对策：检测必须是 AskUserQuestion 专属签名

`parseAskPicker` 现用宽泛 footer（`Enter to select | ↑/↓ to navigate`）。Claude Code 里 **rewind picker、slash 面板、权限提示**等多种菜单都带「↑/↓ to navigate」类 footer。现状下 `parseAskPicker` 只在「我们自己驱动菜单时」被调用，不存在误判；一旦每 tick 调用来做「检测」，就可能把 rewind 等误判成 AskUserQuestion，**破坏其他功能**。

对策——实时检测使用 **AskUserQuestion 专属签名**（不改 `parseAskPicker`，新增独立判定）：

- 必含交互选择 footer：同时出现 `to navigate` 与 `Esc to cancel`。
- 必含 AskUserQuestion 特有词缀 `Chat about this`（claude 在用户选项后固定追加 `Type something.` / `Chat about this`）。
- 必能解析出 ≥1 个编号选项。
- 且**不含** rewind 标志（`Restore the code` / `Confirm you want to restore`）。

四条同时满足才判为待答选择题。这样对 rewind/slash/权限提示**零误判**（false positive 优先级最高，宁可漏判：漏判时终端/KeyBar 作答仍可用）。

`Type something.` / `Chat about this` 这两个**追加项不展示**给用户（真实卡片只含原始选项）：取「首个追加词缀之前」的选项为真实选项；其 TUI 编号天然为 `1..N`，故 `optionIndices`（0 起）→ TUI 编号 `i+1` 的映射不受追加项影响。

`multiSelect` 由屏幕推断：footer 含 `Space` 或选项行含 `☐/☑` 则多选，否则单选（默认单选）。无多选夹具，多选按最佳努力实现；单选为主路径，务必稳。

## 数据流

```
capture-pane ──parseAskPickerLive──► (open? options? multiSelect?)
                       │
            tick(): 关→开  emit ask_pending{options,multiSelect}
                    开持续  抑制预览 + running=false（等输入，非思考）
                    开→关  emit ask_pending_clear
                       │
前端 livePending ◄─────┘   渲染 LiveAskCard（顶部「Claude 正在等待你的选择」）
   │ 点选 → ask_pending_answer{optionIndices}
   ▼
服务端 answerPendingAsk → AskController.answerCurrent（按编号导航 + Enter；多选 Space×n + Enter）
   成功：菜单关 → tick 发 ask_pending_clear → 前端清卡 → transcript 落地 → 显示最终（resolved）卡片
   失败：不取消、留菜单 → 发 ask_pending_failed → 前端复位卡片 + 提示「用终端/按键条作答」
```

多题：屏幕一次一题。答完当前题，TUI 推进到下一题，tick 检测到「选项签名变化」再发一次 `ask_pending`，前端换下一张卡。每次点选对当前屏即 `optionIndices`，天然映射。

## 组件与接口（全部并行增量）

### 协议 `packages/shared/src/chatWs.ts`
- 新增类型 `AskPendingOption { index: number; label: string }`。
- 服务器→浏览器，新增：
  - `{ type:'ask_pending'; options: AskPendingOption[]; multiSelect: boolean }`
  - `{ type:'ask_pending_clear' }`
  - `{ type:'ask_pending_failed'; error?: string }`
- 浏览器→服务器，新增：
  - `{ type:'ask_pending_answer'; optionIndices: number[] }`
- 既有 `ask_answer` / `ask_state`（transcript 卡片用）**保持不变**。

### `askScraper.ts`（不改 `parseAskPicker`）
- 新增 `parseAskPickerLive(pane): { open: boolean; options: AskPendingOption[]; multiSelect: boolean }`：实现上面的专属签名 + 追加项过滤 + 多选推断。

### `askController.ts`（不改 `answer`）
- 新增 `answerCurrent(optionIndices: number[]): Promise<AskResult>`：只作答**当前屏**这一题；**失败不 Esc 取消**（留菜单给手动兜底）。配套私有 `navigateSoft`（失败返回结果、不取消）。

### `chatSession.ts`
- tick()：transcript 段不变；抓屏后用 `parseAskPickerLive` 判定：
  - 开且签名变 → `events.onAskPending`；记 `lastAsk` 与 `lastAskSig`。
  - 开 → 若 `running` 则 `setRunning(false)`，清 `holdPreview`，**return**（跳过既有预览/运行段，原段一字不改）。
  - 由开转关（`lastAskSig` 非空且现在不开）→ `events.onAskPendingClear`，清 `lastAsk/lastAskSig`。
- 新增 `answerPendingAsk(optionIndices)`：置 `askActive`（驱动期 tick 静默，复用既有机制），调 `AskController.answerCurrent`；失败发 `onAskPendingFailed`。
- 新增 `getLiveAsk(): AskPending | null`（重连补发用）。
- 新增事件 `onAskPending/onAskPendingClear/onAskPendingFailed`（加入 `ChatSessionEvents`）。

### `chatRegistry.ts`
- `ChatSubscriber`、扇出、`ChatSessionLike`、`ChatHandle` 加上三个新事件与 `answerPendingAsk`、`getLiveAsk`。
- 新订阅者加入时：`sub.onHistory(...)` 之后，若 `getLiveAsk()` 非空则 `sub.onAskPending(...)`（重连/多镜像补发，因为待答态不在 transcript 历史里）。`resync` 同理补发或发 clear。

### `routes/chat.ts`
- 订阅成功后：若 `handle.getLiveAsk()` 非空，`send ask_pending`。
- `socket.on('message')` 增 `case 'ask_pending_answer': handle.answerPendingAsk(msg.optionIndices)`。
- 三个新服务器事件透传为对应 WS 消息。

### `apps/web/src/lib/chatWs.ts`
- `ChatHandlers` 增 `onAskPending/onAskPendingClear/onAskPendingFailed`；`onmessage` switch 增三个 case。

### `apps/web/src/components/chat/ChatView.tsx`
- 新状态 `livePending: { options; multiSelect } | null` 与 `liveState: 'open'|'driving'|'failed'` + `liveError`。
- 接 `onAskPending`（设卡、open）、`onAskPendingClear`（清卡）、`onAskPendingFailed`（failed + 提示）。
- 在 `TurnList` 之后渲染 `LiveAskCard`（当 `livePending` 非空）。
- 既有预览/思考块的 `!hasPendingAsk` 守卫改为 `!hasPendingAsk && !livePending`（抑制待答期的预览/转圈）。
- **去重**：`messages` 一旦含 `AskUserQuestion` 的 `tool_use`（transcript 卡片已就位）即 `setLivePending(null)`，确保任何时刻只有一张卡。
- 点选 → `send ask_pending_answer{optionIndices}`，本地置 `driving`。

### `apps/web/src/components/chat/LiveAskCard.tsx`（新）
- 复用既有 `askcard` 系列 CSS。单选点击即提交；多选 toggle + 「发送选择」。`driving` 显「作答中…」并禁用；`failed` 显「自动作答失败，请用下方按键条或终端作答」。不动既有 `AskChoiceCard`。

## 错误处理

- 自动驱动失败：不取消菜单，发 `ask_pending_failed`，前端提示改用终端/KeyBar；菜单仍在，手动可答。
- 误判防护：四条专属签名 + 排除 rewind 标志；漏判退化为现状（终端可答），不波及其他功能。
- 重连/刷新：待答态不在 transcript 历史，靠 `getLiveAsk()` 在订阅/resync 时补发。
- 多镜像客户端：经 registry 扇出，所有客户端同步显示/清除。

## 测试

- `askScraper.test.ts`：`parseAskPickerLive` 对真实 ask 夹具 → open、真实选项 `[Apple,Banana]`（过滤掉追加项）、`multiSelect=false`；对 rewind 样屏与普通屏 → `open=false`。
- `askController.test.ts`：`answerCurrent` 单选（导航 + Enter，且后续题仍开时**不**取消 → ok）；失败**不**发 Esc（留菜单）。
- `chatSession.test.ts`：tick 检测到 ask → `onAskPending`（真实选项）；菜单消失 → `onAskPendingClear`；待答期 `running=false` 且不发 `onPreview`；非 ask 屏行为不变（既有用例须全绿）；`answerPendingAsk` 调 `answerCurrent` 并在失败时发 `onAskPendingFailed`。
- `chatWs.test.ts`（shared）：新消息 encode/decode 往返。
- 真实冒烟 `scripts/smoke-ask-live.ts`：起隔离 tmux 会话触发 AskUserQuestion，断言待答期 `parseAskPickerLive.open` 且 `ChatSession` 发出 `ask_pending`，自动作答后菜单关闭、发出 `ask_pending_clear`，结束清理。
- 回归：`npm test`、`npm run typecheck`、`npm run build` 全绿。

## 明确不做（YAGNI）

- 不从屏幕解析问题正文/描述（方案 B 的全保真读屏，更脆，且本期不需要）。
- 不改 transcript 渲染、不改 rewind/effort/终端任何逻辑。
- 多选为最佳努力（缺夹具），单选为一等公民。
