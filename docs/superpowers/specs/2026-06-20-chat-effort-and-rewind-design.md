# remote-cc 聊天增强：Effort 切换 + 全结构化 Rewind 设计文档

日期：2026-06-20
状态：待定稿（v1）
关系：在 `2026-06-20-native-chat-ui-rebuild-design.md`（原生聊天模式）基础上**新增**两个相互独立、纯增量的聊天能力，不删除、不改动现有终端/聊天主流程。

## 1. 背景与动机

原生聊天模式已落地：同一个 tmux 原生 claude 会话喂两路（读屏出流式预览 + transcript 出结构化消息），手机端可切换聊天/终端两视图。现需在此之上补两个手机端常用能力：

1. **Effort 切换**：当前 effort 固定为 `xhigh`（来自全局 `settings.json` 的 `effortLevel` 与环境变量 `CLAUDE_EFFORT`）。希望聊天里能切换 effort，且**默认提升为 `max`**。
2. **Rewind（回退）**：claude 原生支持把会话/代码回退到某个 checkpoint，并选择恢复模式。希望在手机聊天里以**结构化面板**操作，且**恢复模式要二次确认防误触**。

两者独立、低耦合，可分别开发、分别上线。

## 2. 决策记录（已与用户确认）

1. **Effort 默认 `max`**，可切换；级别取原生支持的 `low|medium|high|xhigh|max|auto`。
2. **Effort 持久化到「会话级」**：每个会话记住一个 effort 值，启动/`--resume` 时用 `--effort` 应用；切换时即时 `/effort` 生效并落盘。
3. Effort 是会话级的**单一值**：因终端与聊天是**同一个 tmux 会话、共用一条启动命令**，故两视图启动都应用该值；**切换 UI 只放在聊天视图**（终端视图不加控件，但其启动同样吃这个值，保持一致）。
4. **Rewind 走全结构化面板**：自定义移动端面板（列 checkpoint、选恢复模式、二次确认全在自绘 UI），后端用「刮屏 + 模拟按键」**闭环驱动**原生 `/rewind` TUI 执行。
5. **恢复模式只要原生三种**：`both`（恢复代码+对话）/ `conversation`（仅对话）/ `code`（仅代码）。原生的 `Summarize from here` 等不纳入。
6. **二次确认防误触**：选 checkpoint → 选恢复模式 → **独立的确认弹窗**（区别于选模式的点击）才真正执行。
7. 纯增量、职责拆分、可维护：新增模块为主，与现有终端/聊天可变状态零共享；不做无关重构。

## 3. 实测事实（本机 `claude 2.1.141`，从 CLI/二进制确认）

### 3.1 Effort
- CLI 有 `--effort <level>`：`Effort level for the current session (low, medium, high, xhigh, max)`（启动时设定）。
- 会话内有斜杠命令 `/effort`，二进制元数据：`name:"effort", supportsNonInteractive:true, description:"Set effort level for model usage", argumentHint:"<low|medium|high|xhigh|max|auto>"`。即**直接发 `/effort max` 一行命令即可即时设定、无需交互、无需重启**。
- 当前 `xhigh` 来源：`~/.claude/settings.json` 的 `"effortLevel":"xhigh"` 与环境变量 `CLAUDE_EFFORT=xhigh`。我们用 `--effort`/`/effort` 覆盖即可，不动全局配置。
- `Fable-yolo` 是别名：`claude --dangerously-skip-permissions --system-prompt-file ~/.claude/CLAUDE-FABLE-5.md`；`bash -ic 'Fable-yolo --effort max --session-id <uuid>'` 可正确展开透传。

### 3.2 Rewind
- 命令元数据：`name:"rewind", aliases:["checkpoint","undo"], argumentHint:"", supportsNonInteractive:false`。
  → **`/rewind` 只能开交互式 TUI，无法用参数非交互执行**。这是结构化方案必须靠刮屏+模拟按键的根因。
- 恢复模式（有文件改动时）：`[{value:"both",label:"Restore code and conversation"},{value:"conversation",label:"Restore conversation"},{value:"code",label:"Restore code"}]`；无文件改动时仅 `conversation`。另有 `summarize`/`summarize_*`（本设计不采用）。
- rewind 以**消息 uuid 锚定**（二进制中按选中消息的 `uuid` 拉取 checkpoint 详情）。
- claude「在每次编辑前给文件打 checkpoint」；会话维度即使无文件改动也有可回退点（故 `conversation` 模式恒在）。
- **真实 spike 已抓屏确认（`claude 2.1.141`，下列为实测）**：
  - **列表阶段**：顶部 `Rewind` + 副标题 `Restore the code and/or conversation to the point before…`；每个 checkpoint 两行——第一行是用户消息文本，第二行是改动摘要（有改动如 `note.txt +2`，无改动为 `No code changes`）；最底一行是 `(current)`；底部 `Enter to continue · Esc to cancel`。**光标是行首 `❯ `**，初始停在 `(current)`（最底）。`Up` 向更早的 checkpoint 移动。
  - **picker 只列「活动分支」的 checkpoint**（被 rewind 掉的游离分支不出现）。
  - **模式菜单阶段**（选中 checkpoint 后 Enter 进入）：副标题 `Confirm you want to restore to the point before you sent this message:`，引用该消息（`│ …` + `│ (Ns ago)`），并显示 `The conversation will be forked.` 与 `The code will be restored -N in <file>.`／`The code will be unchanged.`；选项为**编号 1-5**：`1. Restore code and conversation`(both) / `2. Restore conversation`(conversation) / `3. Restore code`(code) / `4. Summarize from here` / `5. Summarize up to here`。**光标 `❯` 初始在 `1`**，`Down` 逐项下移；`Enter` 确认执行。
  - **执行后**：会话回退（context 用量归 0），原生**输入框被预填被回退的那条消息文本**，屏幕回到正常 prompt。
  - **⚠️ 关键：transcript 不被截断**。claude transcript 是 **append-only + `parentUuid` 树**：rewind 仅在内存移动「头指针」，**文件字节不变**（实测行数 14→14）；直到用户发**下一条**消息，才追加新行，其 `parentUuid` 指回被回退点的父节点，从而**分叉**——老分支节点仍留在文件里成为游离分支。
  - 故**线性读 transcript 在 rewind 后会同时渲染两条分支（bug）**。正确做法是**按 `parentUuid` 从活动头（文件中最后一个带 uuid 的节点）回溯到根、只渲染该活动链**（见 §5.6 修订）。

## 4. 功能一：Effort 切换（持久化每会话）

### 4.1 数据模型（`packages/shared/src/schemas.ts`）
- `EffortLevelSchema = z.enum(['low','medium','high','xhigh','max','auto'])`。
- `ConversationSchema` 增 `effort: EffortLevelSchema.default('max')`（可选写入、读取有默认）。
- `StoredConversation`（`conversations.ts`）随之带 `effort`；旧记录读出时由 schema 默认补 `max`（无需强制迁移，读时即默认）。

### 4.2 存储（`apps/server/src/lib/conversations.ts`）
- 新增 `update(convId, patch: Partial<StoredConversation>): StoredConversation | undefined`：load → 改中目标 → `write`（沿用既有 `.bak` + 原子 rename）。
- `create()` 显式写入 `effort:'max'`（新会话默认）。

### 4.3 启动应用（两视图共用同一会话值）
- 抽一个纯函数 `effortFlag(level?) → '--effort <level>'`（`level` 为空/`auto` 时的处理在实现时定：`auto` 也照传，由 claude 自处理）。
- 聊天 `chatSession.ts` `ensure()`：命令改为 `${launchCommand} ${effortFlag} ${idFlag}`（`--effort` 置于 `--resume/--session-id` **之前**，避免 `--resume [value]` 贪婪吞参）。`ChatSpec` 增 `effort` 字段。
- 终端 `routes/sessions.ts`：`command = ${launchCommand} ${effortFlag} ${launchFlag(sessionId)}`。
- chat 路由 `routes/chat.ts` 装配 `spec.effort = conv.effort`。

### 4.4 即时切换（apply + persist）
- WS 客户端→服务端新增 `{type:'set_effort', level}`。
- 服务端：① `conversations.update(cid,{effort:level})` 落盘；② 给运行中的会话**应用** `/effort <level>`。
- `ChatSession` 增 `setEffort(level)`：`pasteText('/effort '+level)` + `sendKeys(['Enter'])`，但**不**置 `holdPreview`/`running`（`/effort` 是即时命令，不应触发"思考中"判定）。
- 服务端→客户端新增 `{type:'effort', level}`：连接时下发当前值（读 `conv.effort`）；`set_effort` 处理后回发确认。

### 4.5 UI（`apps/web`）
- 聊天顶栏新增 effort 小药丸（显示当前级别，如 `max ▾`），点开 6 项菜单（low/medium/high/xhigh/max/auto），选中→`send({type:'set_effort',level})` 并乐观更新本地显示。
- 当前值来源：监听 `effort` 服务端消息（首连下发 + 切换回执）。
- 复用既有 `SlashPalette`/菜单样式，避免新造轮子。

## 5. 功能二：全结构化 Rewind 面板

### 5.1 模块拆分（单一职责、可测）
```
lib/session/chat/
  rewindScraper.ts   纯函数：pane 文本 → 结构化 picker 状态（唯一脆弱点，fixture 单测）
  rewind.ts          控制器：注入 tmux 能力，状态机 open/execute/cancel（闭环校验）
```

### 5.2 刮屏器 `rewindScraper.ts`（纯函数）
- `parseRewindPicker(pane: string): RewindPickerState`
- `RewindPickerState = { open:boolean; stage:'list'|'mode'; items: RewindItem[]; cursor:number; modes?: RewindMode[]; modeCursor?:number }`
- `RewindItem = { index:number; label:string; age?:string; filesChanged?:boolean }`（`label`=该 checkpoint 对应的用户消息预览）。
- 纯函数、对**真实抓屏 fixture** 做单测；claude 升级导致 TUI 变化时，只需更新此文件 + fixture。

### 5.3 控制器 `rewind.ts`（注入 `TmuxLike` 子集：`sendKeys/pasteText/capturePaneVisible`）
- `open(): Promise<RewindPickerState>`：发 `/rewind` + Enter 打开 picker → 轮询 `capturePaneVisible` 直到 `parseRewindPicker().open===true`（带超时）→ 返回解析结果。
- `execute(index, mode): Promise<{ok:boolean; error?:string}>`：
  1. 从当前 `cursor` **逐键导航**到 `index`：每发一次 `Up/Down` 即重抓屏校验 `cursor` 是否朝目标推进；
  2. `cursor===index` 后发 `Enter` 进入模式菜单（`stage` 变 `mode`）；
  3. 同法导航 `modeCursor` 到目标 `mode`；
  4. **最终 Enter 仅在「目标行已选中 且 目标模式已高亮」双校验通过时发**，执行回退。
- `cancel(): Promise<void>`：发 `Esc`（必要时多次）关闭 picker，回到正常聊天。

### 5.4 安全闭环（关键）
- **绝不盲发按键计数**：每步按方向键后都重抓屏读 `cursor`，确认朝目标移动；到位才进下一步。
- 任一步在 N 次尝试内无法对齐目标（光标不动/越界/解析失败）→ **中止 + 发 Esc 退出 + 回 `error`**，**绝不在不确定时按下执行键**（错回退会丢工作，宁可失败重来）。
- rewind 全程加锁：同一会话同时只允许一个 rewind 流程；进行中拒绝新的 `rewind_open/execute`。

### 5.5 与现有轮询的隔离
- `ChatSession` 增 `rewindActive` 标志。控制器 `open` 置真、`execute/cancel` 收尾置假。
- `tick()` 在 `rewindActive` 期间**跳过 paneScraper 的预览/running 更新**（picker chrome 不该污染聊天预览）；transcript tail 可照常（picker 不写 transcript）。
- 控制器自己用 `capturePaneVisible` 抓屏，与 `tick()` 互不打架（`tick` 此时不动预览）。

### 5.6 transcript 树/分支重渲（核心修订，spike 实测驱动）
- **事实**：transcript 是 append-only + `parentUuid` 树；rewind 不截断文件，发下一条消息才分叉。线性渲染在分叉后会同时显示两条分支（bug）。
- **修订方案：`transcript.ts` 改为「活动分支」渲染**——
  - `parseTranscriptLine` 扩展为同时取 `uuid`/`parentUuid`（含 attachment/snapshot 等**非可渲染但参与链路**的节点；它们没有可渲染消息但 `parentUuid` 链经过它们）。
  - `TranscriptTail` 维护 `byUuid: Map<uuid,{parentUuid, msg|null}>` 与文件顺序 `order: uuid[]`；字节偏移**仍只增量读新字节**（文件 append-only，老字节不变，偏移模型有效）填入 map。
  - 新增 `activeChain(): ChatMessage[]`：从 `order` 最后一个带 uuid 的节点（活动头）沿 `parentUuid` 回溯到根，收集 `msg!=null` 的节点，反转为正序。
- **`ChatSession` 改用 activeChain 差分**：每 tick 取 `activeChain()`，与上次按 uuid 序列比较：是「追加扩展」→ 对新增尾部逐条 `onMessage`（保持增量流式）；「分叉/缩短」→ `onHistory(chain)` 整屏替换。重连时 `activeChain()` 天然给出正确活动链（修复重连后显示游离分支的问题）。
- **rewind 即时反馈**：执行后文件未变（下一条消息前 activeChain 仍为老链），故 `rewind_done` 时由**服务端**按选中行序号定位 transcript 中第 i 条用户文本消息、取其父，发一份「截到该点之前」的 `history` 做即时整屏更新；并回传被回退消息文本，前端**预填 Composer**（对齐原生，便于改写重发）。下一条消息到来时 activeChain 差分自然收敛到正确分支。

### 5.7 WS 协议（`packages/shared/src/chatWs.ts`）
- `RewindModeSchema = z.enum(['both','conversation','code'])`。
- 客户端→服务端新增：
  - `{type:'rewind_open'}`
  - `{type:'rewind_execute', index:number, mode:RewindMode}`
  - `{type:'rewind_cancel'}`
- 服务端→客户端新增：
  - `{type:'rewind_list', items:RewindItem[]}`（`items` 为空表示无可回退点）
  - `{type:'rewind_done', mode:RewindMode, ok:boolean}`
  - 失败复用既有 `{type:'error', message}`。
- 注册表 `ChatRegistry`/`ChatHandle` 增 `rewindOpen/rewindExecute/rewindCancel` 转发到会话上的控制器。

### 5.8 UI（`apps/web/src/components/chat/RewindPanel.tsx` + `ChatView` 接线）
- **入口**：顶栏「↶ 回退」按钮；`running===true` 时**禁用**（生成中不开 rewind）。
- 点击 → `send({type:'rewind_open'})`；收到 `rewind_list` → 打开底部弹层（sheet）。
- **列表**：每条 checkpoint 显示消息预览 `label` + 时间 `age` + 改动标记（有 `filesChanged` 显示徽标）。空列表显示"暂无可回退点"。
- **选模式**：点某条 → 就地展开三按钮：`恢复代码+对话` / `仅对话` / `仅代码`。（可按 `filesChanged` 置灰 `code`/`both`，实现时定；不确定则全开，由后端双校验兜底。）
- **二次确认**：点模式 → 弹独立确认框「确认将『<模式中文>』回退到此处？此操作不可轻易撤销。」[取消] [确认回退]。
- **执行**：确认 → `send({type:'rewind_execute',index,mode})` → 弹层转圈；收 `rewind_done` → 关闭弹层（消息区已由 `history` 重渲）。
- **取消**：弹层任意环节关闭 → `send({type:'rewind_cancel'})`，后端 Esc 关原生 picker。
- 兜底：保留 `TerminalPeek`，异常时用户仍可肉眼看原生屏并用 `KeyBar` 手动收拾。

## 6. 测试策略（TDD，测源共置 `*.test.ts`）

- **纯函数单测**：
  - `effortFlag` 拼装；`set_effort` 的命令文本拼装。
  - `rewindScraper.parseRewindPicker` 对真实抓屏 fixture：列表/光标/模式阶段/边界（空列表、单条、长预览换行）。
- **注入 fake 单测**：
  - `rewind.ts` 控制器：用 fake tmux（可编程返回一串"抓屏快照"）驱动，断言导航按键序列、双校验通过才发执行键、不一致即中止+Esc。
  - `ChatSession.setEffort` 不翻转 running；`rewindActive` 期间 `tick` 跳过预览。
  - `ConversationStore.update` 落盘正确。
- **真实端到端冒烟**（扩展 `apps/server/scripts/smoke-chat.ts` 或新增 `smoke-rewind.ts`）：真实 tmux+claude 起会话→发消息产生 checkpoint→`/effort max` 生效核验→`rewind_open`/`execute(conversation)` 走通→transcript 重渲一致。涉及 tmux/claude 的改动必须跑真实冒烟再声称完成。

## 7. 实施顺序（计划阶段细化为任务清单）

0. **抓屏 spike — 已完成**：真实 `claude 2.1.141` 抓到列表/模式菜单/执行后/分支结构，结论已回填 §3.2、§5.6（fixture 文本将内联进刮屏器测试）。
1. **Effort（小、独立、低风险）**：schema+store → 启动拼装（两视图）→ `set_effort`/`setEffort`/`effort` 协议 → 顶栏 UI → 单测 + 冒烟核验 `/effort` 即时生效。
2. **transcript 活动分支重渲**（rewind 的正确性前提，但本身独立有价值）：`parseTranscriptLine` 取 uuid/parentUuid → `TranscriptTail.activeChain()` → `ChatSession` 改 activeChain 差分。单测覆盖：线性、分叉树、重连。
3. **Rewind 主体**：`rewindScraper`（内联 spike 文本单测）→ `rewind` 控制器（fake 单测，闭环校验）→ `rewindActive` 隔离 + `rewind_done` 即时 history → WS 协议 + 注册表转发 → `RewindPanel` UI（列表/选模式/二次确认）→ 真实端到端冒烟。

## 8. 风险与对策

- **TUI 布局漂移**（claude 升级）：刮屏器隔离为纯函数 + fixture，更新成本可控；控制器闭环校验保证"看不懂就不动手"。
- **误回退丢工作**：双校验 + 不确定即中止；二次确认防误触；执行后整屏重渲对齐真实状态。
- **`--effort` 与 `--resume` 参数顺序**：`--effort` 前置规避 `--resume [value]` 贪婪；实现时以真实启动核验。
- **共享会话的 effort 一致性**：会话级单值、两视图启动都吃，避免"切了视图 effort 变了"的割裂。
