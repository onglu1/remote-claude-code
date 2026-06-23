# 聊天历史「骨架 + 按需取正文」设计

日期:2026-06-21
分支:`feat/chat-lazy-history`

## 背景与问题

聊天会话每次连上来,`chatRegistry.subscribe` 会立刻 `onHistory(getMessages())` 把**整条活动链全量** `ChatMessage[]` 下发,前端 `ChatView` 直接 `setMessages` 全量渲染。而且断线自动重连(`chatWs.ts` 指数退避重连)时,每次重连都**再全量发一遍**。

实测本机 transcript 普遍 5–10MB、最大 39MB,投影成 `ChatMessage[]` 后仍可能是 MB 级。手机弱网频繁重连,"每次点开/重连都全量"既慢又费流量。

最初考虑"按时间段/按轮分页",但有个软肋:**用户输入体量可控,AI 单条回复却可能极大**(读了大文件、跑了一堆命令)。只要某轮 AI 回复巨大,按轮加载该段照样很重。

## 核心思路:骨架 + 按需取正文

把切分维度从"按时间段"换成"**按角色 + 按需取正文**":

- **用户输入全保留**:每条用户消息全文下发。体量小,构成整段对话的"骨架/目录",滚动条一上来就是完整长度,定位方便。用户提示词本身就是该轮的天然摘要,故折叠的旧 AI 回合**无需另外生成摘要**。
- **每个 AI 回合默认折叠**成一个不含正文的占位(只带 `turnId`)。点一下才向服务器请求该轮正文展开。**巨型回复在你主动看之前根本不下传**——这是省流量的关键。
- **最后一个 AI 回合**默认展示其"底部约一屏"文本(`tail`),你刚离开时看到的地方;想看全文/工具卡片再展开。

初始负载因此被牢牢限制在「全部用户输入(小) + 每轮一个占位 + 最后一屏文本」,与回复多大无关。重连同理只发骨架。

## 关键不变量:骨架/实时 边界天然清晰

- **骨架**只覆盖「订阅那一刻 `ChatSession.this.messages` 已有的链」。
- 之后的新消息**全部**走现有的 `onMessage` 全量增量通道,完全不动。

两者边界天然清晰,所以前端就是「历史骨架(新增折叠渲染) + 实时缓冲(沿用现有流式/分组逻辑)」上下拼接,**现有实时与流式代码零改动**,折叠渲染是纯增量新增。

### 运行中订阅的处理(避免同一轮被双渲染)

唯一的坑:若订阅时会话正在生成(`running`),最后那个**进行中**的 AI 回合的已写消息已在 `this.messages`(进骨架),其后续新消息走 `onMessage`(进实时缓冲)——同一轮被劈成两半、双重渲染。

解决:`running` 时,把"最后一个进行中的助手回合"从骨架里**剥出**,作为初始 `live` 一并下发,由 `onMessage` 自然续写;骨架只含其之前的回合(且不给 tail)。于是进行中的回合**只存在于实时缓冲**,绝不与骨架重叠。空闲时 `live` 为空,最后一个助手回合给 tail。

## 数据形态(`packages/shared`)

```ts
/** 折叠回合附带的"底部约一屏"文本(仅最后一个助手回合)。 */
export interface SkeletonTail {
  text: string;        // 该轮文本块拼接后的末尾片段
  truncated: boolean;  // 是否被截断(true 则前端给"展开全部")
}

/** 历史骨架的一项:用户消息全文 / 助手回合折叠占位。 */
export type ChatSkeletonItem =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; turnId: string; tail?: SkeletonTail };

/** 一次历史快照:骨架 + (进行中回合的)实时消息。 */
export interface ChatHistorySnapshot {
  items: ChatSkeletonItem[];
  live: ChatMessage[];
}
```

### 纯函数(`packages/shared/src/skeleton.ts`,单测覆盖)

- `turnSlices(chain: ChatMessage[]): TurnSlice[]` — 把原始消息按回合切片,**保留**回合内的全部原始消息(助手块 + 夹在其间的 `tool_result`-only 用户消息),供取正文与构骨架共用。`TurnSlice = { kind:'user'; message } | { kind:'assistant'; turnId; messages }`,`turnId` 为该回合首条助手消息 uuid。
- `buildHistorySnapshot(chain, { running, tailChars }): ChatHistorySnapshot` — 基于 `turnSlices`;按上文规则产出 `items` 与 `live`;最后一个助手回合(空闲时)算 `tail`。
- `getTurnSlice(chain, turnId): ChatMessage[] | null` — 取某助手回合的完整原始消息切片(供 `load_turn`)。

`tail` 计算:取该回合所有 `text` 块拼接;`length <= tailChars` 则 `tail.text` 为全文、`truncated=false`;否则 `tail.text` 为末尾 `tailChars` 字符、`truncated=true`。默认 `tailChars = 1500`(约一屏手机 markdown 文本,定为具名常量便于调)。

## 协议变更(`packages/shared/src/chatWs.ts`)

服务器 → 浏览器:
- `history` 载荷由 `{ messages: ChatMessage[] }` 改为 `{ items: ChatSkeletonItem[]; live: ChatMessage[] }`(承载 `ChatHistorySnapshot`)。
- 新增 `{ type:'turn_body'; turnId: string; messages: ChatMessage[] }`——某折叠回合的完整正文。
- `message`/`preview`/`turn_state`/… 全部不变。

浏览器 → 服务器:
- 新增 `{ type:'load_turn'; turnId: string }`——请求展开某折叠回合。

## 服务器变更

### `ChatSession`(`apps/server/src/lib/session/chat/chatSession.ts`)
- `ChatSessionEvents.onHistory` 类型由 `(messages: ChatMessage[])` 改为 `(snapshot: ChatHistorySnapshot)`。
- 新增 `getSkeleton(): ChatHistorySnapshot`——`buildHistorySnapshot(this.messages, { running: this.running, tailChars })`。
- 新增 `getTurnBody(turnId): ChatMessage[] | null`——`getTurnSlice(this.messages, turnId)`。
- 原本两处 `onHistory(整链)` 改为发骨架:`tick()` 链分叉(非前缀)分支、`rewindExecute()` 截断后。均改成 `onHistory(buildHistorySnapshot(chain,…))`。
- 保留 `getMessages()` 作为内部/测试便捷读取(原向订阅者下发历史的用途已被 `getSkeleton` 取代;`tick` 内部仍直接用 `this.messages`)。

### `ChatRegistry`(`chatRegistry.ts`)
- `ChatSubscriber.onHistory`、`ChatSessionLike` 接口随类型更新;`getMessages`→`getSkeleton`,新增 `getTurnBody`。
- `subscribe` 初次推送 `sub.onHistory(session.getSkeleton())`;`resync` 同理。
- `ChatHandle` 新增 `loadTurn(turnId): ChatMessage[] | null` → `session.getTurnBody(turnId)`。

### 路由(`routes/chat.ts`)
- `onHistory` 回调:`send({ type:'history', items: snap.items, live: snap.live })`。
- 新增 `case 'load_turn'`:`const body = handle.loadTurn(msg.turnId); if (body) send({ type:'turn_body', turnId: msg.turnId, messages: body })`。

## 前端变更(`apps/web`)

### 客户端 `lib/chatWs.ts`
- `ChatHandlers.onHistory` 改为 `(snap: ChatHistorySnapshot)`;新增 `onTurnBody(turnId, messages)`。
- `history` case 透传 `{ items, live }`;新增 `turn_body` case。`load_turn` 走既有 `send`。

### `ChatView.tsx`
把单一 `messages` 拆成三态:
- `history: ChatSkeletonItem[]`——骨架(来自 `onHistory`)。
- `expanded: Record<turnId, ChatMessage[]>`——已取正文的回合(来自 `onTurnBody`)。
- `live: ChatMessage[]`——本次连接的新消息,**沿用原有** `onMessage` 去重/乐观回显/`groupTurns`/`toolResults`/`hasPendingAsk`/流式预览全部逻辑(把原 `messages` 改名为 `live` 即可)。

`onHistory(snap)`:`setHistory(snap.items)`;`setLive(snap.live)`;**保留** `expanded`(仅剪枝到仍存在的 `turnId`)——重连后已展开的旧回合不必重新拉取,体验不被打断。

渲染顺序:`<ChatHistory …/>`(历史骨架) → 既有实时块(`TurnList turns=groupTurns(live)` + 预览 + 思考中指示)。

展开旧回合:点击 → `send({type:'load_turn', turnId})`;`onTurnBody` 落 `expanded`;就地把折叠行换成完整 `TurnList`。展开**保持滚动位置**(锚定:展开前后量 `scrollHeight` 差值补偿 `scrollTop`),避免页面跳动。初始/底部仍自动到底。

### 新组件
- `ChatHistory.tsx`——渲染 `items`:`user`→`<UserTurn>`;`assistant` 若在 `expanded` 则 `<TurnList turns=groupTurns(slice) toolResults=…>`,否则渲染折叠行;`tail` 存在则渲染 tail 文本(markdown) + "展开全部"。
- `CollapsedTurn.tsx`——折叠占位行:`⏺ 展开 Claude 的回复` + 加载态。

## 取舍

- 折叠回合只在点开时才下传正文 → 巨型回复在主动查看前**永不传输**(省流量核心)。
- 代价:最后一轮的**工具卡片**需展开后才显示(`tail` 只含文本)。但常见的"短句结尾"场景 `tail` 即全文,与现状观感一致。
- 重连后已展开回合**保留**(`expanded` 不清),不必重拉。
- 旧回合统一**手动点展开**(不做滚动自动展开,以免一路上滑把沿途巨型回复都拉下来,反而费流量)。

## 测试

- `packages/shared/src/skeleton.test.ts`:空链、仅用户消息、含工具调用的助手回合切片、多回合 + 最后一轮 tail 截断/不截断、`running` 剥离进行中回合到 `live`、`getTurnSlice` 命中/未命中。
- `chatSession.test.ts` / `chatRegistry.test.ts`:改断言 `onHistory` 收到骨架快照、`getTurnBody`/`loadTurn` 取正文。
- `smoke-chat.ts`:适配新 `onHistory` 快照;补一段断言——发一轮后 `getSkeleton()` 折叠旧回合、`getTurnBody(turnId)` 能取回完整正文。真实 tmux + claude 端到端跑通再算完成。
- 全量 `npm run typecheck && npm test && npm run build` 绿。
