# remote-cc 聊天渲染保真:角色归属 / 回合分组 / AskUserQuestion 设计

日期:2026-06-20
分支:`feat/chat-native-render`(worktree `remote-cc-chat-native`,独立端口 6400 / tmux socket `rccn`)
状态:已定稿(solo brainstorming;用户已委派自主实现,验收在最后)
关系:在 `2026-06-20-native-chat-ui-rebuild-design.md` 的双路渲染架构上**纯增量修复与增强**,不删除既有功能、不改终端模式。原 spec 继续有效。

---

## 1. 背景与三个核心问题

聊天模式当前把「读屏预览 + transcript 结构化」两路喂前端。实际使用暴露三类丑陋/错误:

1. **角色归属经常出错**:用户的话被判成系统回复、系统的内容被判成用户。
2. **工具调用拆成多个气泡**:一轮助手工作(说话→调工具→拿结果→再说话)被打散成多个气泡,很丑;期望观感/动画接近原生 Claude Code。
3. **AskUserQuestion 不被识别成选择框**:原生多选提问只当成普通工具卡显示 JSON,无法点选。

附带目标(用户原话):「识别对话各阶段很困难」——需要清晰的回合/阶段边界;**保留**聊天区 Ctrl+O 点击展开的交互;**明显区分**「我发送的」与「系统回复的」。

---

## 2. 根因分析(基于本机真实 transcript,claude 2.1.141)

研究三处参考(详见 §10):两个开源 remote 项目都**比本项目更原始**(buckle42=ttyd 套 iframe;JessyTsui=靠屏幕 `>`/`⏺` 前缀猜角色——正是我们要消灭的做法),原生 remote-control 的 AskUserQuestion 在移动端反而是**坏的**(issue #33625 无按钮、#28508 选择不回传)。权威依据来自真实 transcript JSONL schema:

- **`message.role` 不足以判定角色。** 工具结果是以 `type:"user"` / `role:"user"` 写入的(API 约定),`message.content` 是含 `tool_result` 块的数组,并带顶层 `toolUseResult` / `sourceToolAssistantUUID`。
- **真实人类消息** = `type:"user"` 且 content 为字符串/文本块、**无** `isMeta` / `isCompactSummary` / `isSidechain`、无 tool_result。
- **噪声 user 条目**(当前被错当成用户气泡):
  - `isMeta:true`:命令包装(`<command-name>/effort</command-name>`)、`<local-command-caveat>` 等注入。
  - `isCompactSummary:true`:上下文压缩摘要("This session is being continued…")。
  - `isSidechain:true`:**子代理(Task)侧链**——独立子线程,`parentUuid:null` 自成一棵树。
- **`activeChain()` 从最后写入的节点回溯**:当子代理刚运行/结束时,最后写入的是 sidechain 节点,沿 `parentUuid` 回溯会停在 sidechain 根(parentUuid=null),于是**整段主对话被子代理内部内容替换**——灾难级错配,也是「阶段难识别」的元凶之一。
- **工具分组**:一个 assistant 条目的 content 多为单一块,但**混合/并行**真实存在(`[thinking,text,tool_use]`,甚至多个并行 `tool_use`);某个 `tool_use` 的结果落在**之后另一条** `user`/tool_result 里,靠 `tool_use_id` 配对,**不相邻**。当前「每条 = 一个气泡」必然把一轮打散。
- **AskUserQuestion**:assistant 的 `tool_use` 块,`name:"AskUserQuestion"`,`input.questions[]` 每项 `{question, header, multiSelect, options:[{label,description}]}`;答案是同 `tool_use_id` 的 `tool_result`,结构化结果在顶层 `toolUseResult.answers`(`{问题文本:所选label}`),拒绝则 `is_error:true`。

**结论**:三个问题同根——**没有完整尊重 transcript 的 content-block 语义,且按条而非按回合渲染**。修复方向明确:服务端按 content-block 正确分类并净化主线,前端按回合分组并原生化渲染,AskUserQuestion 走「干净 transcript 渲染 + 闭环驱动原生 TUI」。

---

## 3. 目标与非目标

**目标**
- 角色归属正确:助手/用户/工具结果/噪声各归其位;子代理不再污染主线。
- 一轮助手工作渲染为**单一回合块**(文本/思考/工具卡有序),工具结果按 id 配对进卡片。
- 观感/动画贴近原生 Claude Code;**用户气泡与助手回合明显区分**;保留 Ctrl+O/点击展开。
- AskUserQuestion 渲染为**选择框**(按钮),点选后驱动真实 TUI 完成作答;失败可回退手动按键。

**非目标(YAGNI)**
- 不改/不重建终端模式;不引入 headless `-p`。
- 本期**不**接 Claude Code hooks(turn-state 仍用读屏 + transcript;hooks 列为 §11 未来增强)。
- 不穷举所有 transcript 边角类型;未知类型一律安全忽略。
- 多问题/多选的闭环驱动**尽力而为**,不保证;不确定即回退手动按键(绝不误按执行)。

---

## 4. 方案概览(职责清晰拆分)

```
服务端(净化 + 正确分类)            前端(分组 + 原生渲染)
transcript.ts                        lib/chat/groupTurns.ts(纯函数)
  ├─ classifyEntry(纯函数,新)         └─ messages[] → Turn[](用户回合 / 助手回合)
  │   role 判定走 content-block      components/chat/
  │   丢弃 meta/compact/command        ├─ TurnList / UserTurn / AssistantTurn(新/重构)
  │   标记 isSidechain                 ├─ ToolCard(沿用,微调)
  └─ activeChain 排除 sidechain        └─ AskChoiceCard(新)

AskUserQuestion 闭环(服务端,仿 rewind)
  chat/askScraper.ts(纯函数,解析 TUI 菜单态)
  chat/askController.ts(闭环驱动 + 双校验,失败 Esc 回退)
共享:packages/shared/src/chatWs.ts 仅**追加** ask_answer 客户端消息 + 极小字段
```

核心原则:**wire 协议基本不变**(仍 `ChatMessage[]` 增量流式),分组是前端纯函数派生;服务端只负责「正确分类 + 主线完整性」。AskUserQuestion 复用既有 rewind 的「纯刮屏 + 闭环控制器 + 双校验」成熟范式。

---

## 5. 详细设计

### 5.1 服务端:角色归属与主线净化(`transcript.ts`)

抽出纯函数 `classifyEntry(o): EntryClass`,语义:
- `assistant`:`type==="assistant"` → 渲染 assistant,blocks=text/thinking/tool_use。
- `human`:`type==="user"` 且 **非** meta/compact/sidechain 且 content 含真实 text/image、**不**含 tool_result → 渲染 user。
- `tool_result`:`type==="user"` 且 content 含 tool_result 块(或顶层有 `toolUseResult`/`sourceToolAssistantUUID`) → 渲染为 role:user、blocks=[tool_result](**供前端配对**,但分组时不作为用户回合)。
- `noise`:`isMeta` / `isCompactSummary` / 命令包装 / 其它非 user|assistant 类型 → `msg=null`(**不渲染**,但保留树节点以维持 parentUuid 链)。

`renderMessage` 改为基于 `classifyEntry`:
- `noise` → null。
- `human` / `assistant` / `tool_result` → 产出对应 `ChatMessage`(role 保持 transcript 真相:tool_result 仍 role:user,前端分组消化)。

`TranscriptEntry` 增 `isSidechain: boolean`(parseEntry 读取 `o.isSidechain===true`)。

`TranscriptTail.activeChain` 修复 sidechain 污染:
- 起点改为 **`order` 中最后一个 `isSidechain!==true` 的节点**(而非 `order.at(-1)`)。
- 回溯 `parentUuid` 时跳过 sidechain 节点(主线条目的 parent 本就指向主线,加守卫更稳)。
- 既有「分叉(rewind)只取活动分支」「reset 重读」「文件未出现」行为不变。

> 净化只发生在「是否渲染」层面;树仍保留全部带 uuid 的节点,确保 rewind 分叉/parentUuid 回溯不被破坏(沿用现有 `msg=null` 节点机制)。

### 5.2 共享模型变更(最小追加,`packages/shared/src/chatWs.ts`)

- **不**新增 ContentBlock 类型:AskUserQuestion 复用现有 `tool_use` 块(`name==="AskUserQuestion"`,`input` 即 questions),前端特化渲染。
- `ChatClientSchema` **追加**一条:`{ type:'ask_answer', toolUseId: string, picks: AskPick[] }`,其中 `AskPick = { questionIndex:number, optionIndices:number[] }`(支持多问题、多选;单选即 `optionIndices=[i]`)。
- `ChatServerMessage` **追加**(可选,用于明确状态而非靠猜):`{ type:'ask_state', toolUseId:string, status:'driving'|'done'|'failed', error?:string }`。成功最终仍以 transcript 落地的 tool_result 反映(card 自动转「已作答」)。
- 其余协议不动;`decode/encode` 风格沿用。

### 5.3 前端:回合分组(纯函数 `lib/chat/groupTurns.ts`)

`groupTurns(messages: ChatMessage[]): Turn[]`,`Turn = { kind:'user', message } | { kind:'assistant', id, blocks: ContentBlock[] }`:
- 遍历 messages:
  - **真实用户**(role user 且含 text/image、无 tool_result)→ 结束当前回合,推一个原子 `user` 回合。
  - **assistant** → 若当前不是 assistant 回合则新开,追加其 blocks(text/thinking/tool_use)。
  - **tool_result-only user** → **不**新开/关闭回合(助手回合保持打开);其结果由 `toolResults` 映射消化进工具卡。
- `toolResults: Map<id,{content,isError}>` 仍由全部 tool_result 块汇总(沿用现状)。
- 纯函数 → 真实 transcript 片段夹具单测(线性、含工具往返、并行 tool_use、含 sidechain 被净化后、含 AskUserQuestion)。

### 5.4 前端:原生观感渲染(`components/chat/*` + 样式)

- `TurnList`:渲染 `Turn[]`。`UserTurn`:右侧、强调色、明显「我」气泡(保持简洁文本/图片)。`AssistantTurn`:左侧、扁平(贴近 Claude Code),按序渲染 blocks。
- `AssistantTurn` 内块渲染:
  - `thinking`:折叠(💭),点击展开——沿用现有交互(即用户认可的 Ctrl+O 体验)。
  - `text`:Markdown(代码/表格/列表,可选可复制)。
  - `tool_use`:`ToolCard`(沿用,微调标题/图标/摘要;`⏺`/`✔`/`✘` 状态点);折叠,点击/Ctrl+O 展开,结果按 id 注入。
  - `tool_use(AskUserQuestion)` → `AskChoiceCard`(§5.5)。
- 动画(贴近原生、克制):新回合淡入上移;流式光标(沿用);工具卡展开高度过渡;思考折叠淡入;运行中「Claude 正在思考…」呼吸点。统一走 `themes/tokens.css` 变量,先读 `frontend-design` skill 再落 CSS。
- 流式预览:仍作为「进行中的助手回合」临时显示,transcript 干净版到达即覆盖(沿用);**当存在 pending AskUserQuestion 时前端抑制预览气泡**(避免菜单文字漏成助手预览,兼修「我的被判成系统」的一类泄漏)。

### 5.5 AskUserQuestion:检测 + 选择框 + 闭环驱动 + 回退

- **检测(transcript 驱动,干净)**:某 `tool_use(AskUserQuestion)` 的 id 在 `toolResults` 中**无**结果 = pending(待作答);有结果 = resolved。
- **渲染**:`AskChoiceCard` 从 `input.questions[]` 渲染:`header` 作小标题/标签,`question` 作提问,每个 `option` 一个可点按钮(显示 `label` + `description`);`multiSelect` 时多选 + 确认。resolved 态展示已选答案(读 tool_result 内容字符串;结构化 `toolUseResult.answers` 列为可选增强)。
- **驱动(仿 rewind 闭环,服务端)**:
  - 点击 → 前端发 `ask_answer{toolUseId,picks}`。
  - 服务端 `AskController` + 纯函数 `askScraper`:刮屏解析当前 AskUserQuestion TUI 菜单态(当前题、选项光标、已选集、stage),按 picks 逐步导航(方向键;多选切换;确认),**每步重抓校验**;全部命中才发确认键;任何不确定 → Esc 退出 + 报 `ask_state failed`。
  - 成功后 transcript 落 tool_result → card 自动转 resolved。
  - **TUI 键位以真实会话实测为准**(原生 AskUserQuestion 菜单的导航/确认/多选键),刮屏标志位隔离成纯函数 + spike 夹具单测(同 rewindScraper 策略)。
- **回退**:`AskController` 无法可靠定位/校验时不硬来,回退到既有 `KeyBar`(真实方向键)+ `TerminalPeek`(看原始菜单)——用户永不卡死。这也对冲了原生 #28508「选择不回传」的同类风险(我们靠重抓校验确认 TUI 真的前进)。

### 5.6 流式预览边界改进(`paneScraper`/`chatSession` 微调)

- 维持「只取最后 `❯` 之后的助手区」逻辑;补充:检测到 AskUserQuestion/菜单态时,`chatSession` 不发 preview(由前端 pending 判定兜底,服务端可选加抑制)。
- 不扩大读屏职责(读屏仍仅作过渡预览,完成即被 transcript 覆盖)。

---

## 6. 端到端数据流(以一轮含工具 + 提问为例)

1. 用户发文本 → `ask_*`/`user_text` → tmux paste+Enter;前端乐观回显 user 回合。
2. claude 写 assistant(text/tool_use)→ transcript tail 增量 → 前端并入**同一个**助手回合;读屏出流式预览(覆盖式)。
3. 工具结果以 user/tool_result 落盘 → 前端 `toolResults` 映射 → 注入对应工具卡(不另起气泡)。
4. claude 调 AskUserQuestion(tool_use)→ pending → 前端抑制预览、渲染 `AskChoiceCard` 按钮。
5. 用户点选 → `ask_answer` → `AskController` 闭环驱动 TUI → 答案 tool_result 落盘 → card 转 resolved,助手回合继续。

---

## 7. 测试策略(vitest 共置 + 真实夹具,TDD)

- `transcript.classifyEntry`/`renderMessage`:真实 schema 夹具——human/assistant/tool_use/tool_result/isMeta/isCompactSummary/isSidechain/AskUserQuestion(input+answer)逐一断言归类与净化。
- `TranscriptTail.activeChain`:**新增 sidechain 夹具**断言子代理不污染主线(最后写入为 sidechain 时仍返回主线);保留既有分叉/reset/缺文件用例(回归)。
- `groupTurns`(前端纯函数):线性、工具往返、并行 tool_use、tool_result-only 不起回合、AskUserQuestion 进助手回合。
- `askScraper`(纯函数):真实 AskUserQuestion 菜单快照夹具断言题/选项/光标/多选/stage。
- `askController`:注入 fake tmux,验证导航→双校验→确认;不确定即 Esc 回退、报 failed。
- `chatWs`:新增 `ask_answer`/`ask_state` encode/decode 往返 + 非法拒绝。
- 前端组件:UserTurn/AssistantTurn 渲染、ToolCard 展开、AskChoiceCard 点选发 `ask_answer`、pending/resolved 切换。
- **真实集成冒烟**:扩展 `smoke-chat.ts`,真实起会话跑「含工具的一轮」断言**单一助手回合 + 工具卡配对 + 角色正确**;若可,触发一次 AskUserQuestion 验证 pending 渲染(驱动可手动验)。
- 既有 98+ 测试全绿(回归)。

---

## 8. 受影响文件

- **新增**:`apps/web/src/lib/chat/groupTurns.ts`(+test)、`components/chat/{TurnList,AssistantTurn,UserTurn,AskChoiceCard}.tsx`、`apps/server/src/lib/session/chat/{askScraper,askController}.ts`(+test)、AskUserQuestion 菜单快照夹具、transcript 真实片段夹具。
- **小改**:`apps/server/src/lib/session/chat/transcript.ts`(classifyEntry/净化/sidechain)、`chatSession.ts`(ask 驱动接线 + 预览抑制)、`chatRegistry.ts`+`routes/chat.ts`(转发 `ask_answer`/`ask_state`)、`packages/shared/src/chatWs.ts`(追加消息)、`components/chat/{ChatView,MessageBubble,ToolCard,markdown}.tsx`(改为回合渲染)、`apps/web/src/lib/chatWs.ts`(handler)、`themes/tokens.css`/样式。
- **不动**:终端模式全部(`Terminal.tsx`/`ptyBridge`/`registry`/`ws.ts`)、rewind 既有逻辑(仅作范式参考)、files/auth/taskEvidence。

---

## 9. 风险与取舍

- **读屏脆弱**:仅过渡预览 + AskUserQuestion 刮屏(隔离纯函数 + spike 夹具,claude 升级易适配);内容主体走 transcript 干净版。
- **AskUserQuestion 驱动版本耦合**:键位以实测为准;闭环双校验 + 不确定即回退,保证「绝不误作答」与「用户不卡死」。
- **净化误伤**:分类基于明确字段(isMeta/isCompactSummary/isSidechain/tool_result/类型),未知一律保守(宁可不渲染噪声,也不错配);保留树节点不破坏 rewind。
- **本期不接 hooks**:turn-state 仍可能有轻微抖动(沿用现有 idle 判定);可接受,hooks 见 §11。

---

## 10. 参考实现对照(学到什么)

- **buckle42/claude-code-remote**:ttyd+iframe+tmux send-keys,无 transcript 解析/无角色/无分组——**反例**。可借鉴的仅小 UX:浏览器端图片压缩(1568px/85%)→ 路径注入、`enterkeyhint="send"`、可见性变化重连(均列为可选,非本期核心)。
- **JessyTsui/Claude-Code-Remote**:通知/中继,靠屏幕 `>`/`⏺` 前缀猜角色(=我们要消灭的 bug 源),无工具分组/无 AskUserQuestion。**唯一值得偷**:用 Claude Code **Stop/Notification hooks** 拿权威「完成/等待输入」信号(见 §11)。
- **原生 remote-control**:claude.ai/App 连本地会话、出站轮询、推送。其 AskUserQuestion 在移动端**有缺陷**(#33625 无按钮、#28508 选择不回传、#29214 权限不继承)——印证我们「本地 TUI + send-keys + 闭环校验」反而更可靠,校验步正是对冲 #28508 的手段。

---

## 11. 可选增强(未来,本期不做)

- **Claude Code hooks 驱动 turn-state**:为会话注入 Stop/Notification/UserPromptSubmit hook,把「回合开始/结束/等待输入」写入 per-session 信号文件,服务端 tail(文件解耦、纯函数可测),替代读屏 idle 猜测——可彻底治「阶段难识别」与预览/transcript 切换时机。需注入 hook 配置(新变量,版本/优先级需评估),故列未来。
- AskUserQuestion 结构化答案(`toolUseResult.answers`)进模型、压缩摘要渲染为分隔条、slash 命令渲染为命令 chip、图片压缩上传。
