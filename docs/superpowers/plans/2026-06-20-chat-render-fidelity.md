# 聊天渲染保真 实现计划

> **For agentic workers:** 用 TDD 逐任务实现;步骤用 `- [ ]`。每个纯逻辑先写失败测试→跑红→最小实现→跑绿→提交。涉及 tmux/claude 的用 fake 注入单测 + 末尾真实冒烟。

**目标:** 修复聊天模式的角色归属错配、把一轮助手工作渲染成单一回合(工具卡配对)、把 AskUserQuestion 渲染成可点选择框并驱动真实 TUI;观感贴近原生 Claude Code,保留 Ctrl+O 展开。

**架构:** 服务端按 transcript content-block 正确分类并净化主线(排除 sidechain/meta/compact);前端纯函数 `groupTurns` 折叠回合 + 原生化渲染;AskUserQuestion 复用 rewind 的「纯刮屏 + 闭环控制器 + 双校验 + 不确定即回退」范式。wire 协议仅追加 `ask_answer`/`ask_state`。

**技术栈:** TypeScript、Fastify、zod、vitest(共置);React + Vite;tmux(socket `rccn`)+ 原生交互式 claude。worktree 端口 6400。

参考 spec:`docs/superpowers/specs/2026-06-20-chat-render-fidelity-design.md`

---

## 文件结构(决策锁定)

新增
- `apps/server/src/lib/session/chat/askScraper.ts`(+`.test.ts`):纯函数,解析 AskUserQuestion TUI 菜单态。
- `apps/server/src/lib/session/chat/askController.ts`(+`.test.ts`):闭环驱动 + 双校验。
- `apps/server/src/lib/session/chat/__fixtures__/ask_*.txt`:真实菜单快照(spike 采集)。
- `apps/server/src/lib/session/chat/__fixtures__/transcript_*.jsonl`:真实片段(net of 敏感信息)。
- `apps/web/src/lib/chat/groupTurns.ts`(+`.test.ts`):messages→Turn[] 纯函数。
- `apps/web/src/components/chat/{TurnList,AssistantTurn,UserTurn,AskChoiceCard}.tsx`。

小改
- `apps/server/src/lib/session/chat/transcript.ts`:`classifyEntry`、净化、`TranscriptEntry.isSidechain`、`activeChain` 排除 sidechain。
- `apps/server/src/lib/session/chat/chatSession.ts`:ask 驱动接线、pending 时抑制 preview。
- `apps/server/src/lib/session/chat/chatRegistry.ts` + `apps/server/src/routes/chat.ts`:转发 `ask_answer`、回 `ask_state`。
- `packages/shared/src/chatWs.ts`:追加 `ask_answer`(client)、`ask_state`(server)、`AskPick`。
- `apps/web/src/components/chat/ChatView.tsx`:改用 `groupTurns` + `TurnList`;pending ask 抑制预览。
- `apps/web/src/components/chat/ToolCard.tsx`:状态点/摘要微调。
- `apps/web/src/lib/chatWs.ts`:`onAskState`、`send(ask_answer)`。
- `apps/web/src/themes/tokens.css` 及聊天样式:回合视觉 + 动画。

不动:终端模式全部、rewind 既有逻辑、files/auth/taskEvidence。

---

## Phase A — 服务端角色归属与主线净化

### Task A1: `classifyEntry` 纯函数(按 content-block 判定)

**Files:** Modify `apps/server/src/lib/session/chat/transcript.ts`;Test `transcript.test.ts`

- [ ] **Step 1: 失败测试**(追加到 transcript.test.ts)

```ts
import { classifyEntry } from './transcript';

describe('classifyEntry', () => {
  const env = (o: object) => ({ type: 'user', uuid: 'x', ...o });
  it('人类文本(字符串 content)= human', () => {
    expect(classifyEntry({ type:'user', message:{ role:'user', content:'你好' } })).toBe('human');
  });
  it('人类文本(text 块)= human', () => {
    expect(classifyEntry({ type:'user', message:{ role:'user', content:[{type:'text',text:'hi'}] } })).toBe('human');
  });
  it('tool_result(数组含 tool_result)= tool_result', () => {
    expect(classifyEntry({ type:'user', message:{ role:'user', content:[{type:'tool_result',tool_use_id:'t',content:'o'}] } })).toBe('tool_result');
  });
  it('顶层 toolUseResult 也判 tool_result', () => {
    expect(classifyEntry({ type:'user', toolUseResult:'x', message:{ role:'user', content:[{type:'tool_result',tool_use_id:'t',content:'o'}] } })).toBe('tool_result');
  });
  it('isMeta = noise', () => {
    expect(classifyEntry({ type:'user', isMeta:true, message:{ role:'user', content:'<command-name>/effort</command-name>' } })).toBe('noise');
  });
  it('isCompactSummary = noise', () => {
    expect(classifyEntry({ type:'user', isCompactSummary:true, message:{ role:'user', content:'…continued…' } })).toBe('noise');
  });
  it('assistant = assistant', () => {
    expect(classifyEntry({ type:'assistant', message:{ role:'assistant', content:[{type:'text',text:'ok'}] } })).toBe('assistant');
  });
  it('非 user|assistant 类型 = noise', () => {
    expect(classifyEntry({ type:'system' })).toBe('noise');
    expect(classifyEntry({ type:'attachment' })).toBe('noise');
  });
});
```

- [ ] **Step 2: 跑红** `npm test -w apps/server -- transcript`(Expected: classifyEntry 未定义)
- [ ] **Step 3: 实现** 在 transcript.ts 增:

```ts
export type EntryClass = 'human' | 'assistant' | 'tool_result' | 'noise';

function contentHasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some(
    (b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result',
  );
}

export function classifyEntry(o: Record<string, unknown>): EntryClass {
  if (!o || typeof o !== 'object') return 'noise';
  if (o.type === 'assistant') return 'assistant';
  if (o.type !== 'user') return 'noise';
  if (o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true) return 'noise';
  const msg = o.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (o.toolUseResult !== undefined || o.sourceToolAssistantUUID !== undefined) return 'tool_result';
  if (contentHasToolResult(content)) return 'tool_result';
  return 'human';
}
```

> 注:`isSidechain` 在 classify 里判 noise 仅影响**渲染**;树节点仍由 parseEntry 保留(见 A3)。

- [ ] **Step 4: 跑绿** `npm test -w apps/server -- transcript`
- [ ] **Step 5: 提交** `feat(server): transcript content-block 角色分类 classifyEntry`

### Task A2: `renderMessage` 改用 classifyEntry(净化 noise)

**Files:** Modify `transcript.ts`;Test `transcript.test.ts`

- [ ] **Step 1: 失败测试**

```ts
it('isMeta 命令包装不渲染', () => {
  const o = { type:'user', uuid:'m1', isMeta:true, message:{ role:'user', content:'<command-name>/effort</command-name>' } };
  expect(parseTranscriptLine(JSON.stringify(o))).toBeNull();
});
it('isSidechain 不渲染', () => {
  const o = { type:'assistant', uuid:'s1', isSidechain:true, message:{ role:'assistant', content:[{type:'text',text:'subagent'}] } };
  expect(parseTranscriptLine(JSON.stringify(o))).toBeNull();
});
it('tool_result-only 仍渲染为 role:user + tool_result 块(供配对)', () => {
  const o = { type:'user', uuid:'tr1', message:{ role:'user', content:[{type:'tool_result',tool_use_id:'t1',content:'out'}] } };
  expect(parseTranscriptLine(JSON.stringify(o))).toMatchObject({ role:'user', blocks:[{type:'tool_result',toolUseId:'t1'}] });
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** 改 `renderMessage`:

```ts
function renderMessage(o: Record<string, unknown>): ChatMessage | null {
  const klass = classifyEntry(o);
  if (klass === 'noise') return null;
  const msg = o.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') return null;
  const blocks = normalizeBlocks(msg.content);
  if (blocks.length === 0) return null;
  const role = klass === 'assistant' ? 'assistant' : 'user';
  return {
    uuid: typeof o.uuid === 'string' ? o.uuid : randomUUID(),
    role,
    blocks,
    ts: typeof o.timestamp === 'string' ? o.timestamp : undefined,
  };
}
```

- [ ] **Step 4: 跑绿**(既有 11 用例 + 新用例全绿)
- [ ] **Step 5: 提交** `fix(server): 渲染净化 meta/compact/sidechain,tool_result 保留供配对`

### Task A3: `activeChain` 排除 sidechain 污染

**Files:** Modify `transcript.ts`(`TranscriptEntry` + `parseEntry` + `activeChain`);Test `transcript.test.ts`

- [ ] **Step 1: 失败测试**(子代理为最后写入时仍返回主线)

```ts
it('子代理 sidechain 不污染主线(最后写入为 sidechain)', () => {
  const file = newFile();
  const sideUser = (uuid:string)=>JSON.stringify({type:'user',uuid,parentUuid:null,isSidechain:true,message:{role:'user',content:'task desc'}})+'\n';
  const sideAsst = (uuid:string,p:string)=>JSON.stringify({type:'assistant',uuid,parentUuid:p,isSidechain:true,message:{role:'assistant',content:[{type:'text',text:'sub work'}]}})+'\n';
  writeFileSync(file,
    userLine('u1', null, 'main q') +
    asstLine('a1', 'u1', 'main a') +
    sideUser('sd1') + sideAsst('sd2','sd1')); // sidechain 在最后
  const tail = new TranscriptTail(() => file);
  const chain = tail.activeChain();
  expect(chain.map((m)=>m.uuid)).toEqual(['u1','a1']);
  expect(JSON.stringify(chain)).not.toContain('sub work');
});
```

- [ ] **Step 2: 跑红**(当前会回溯到 sidechain)
- [ ] **Step 3: 实现**
  - `TranscriptEntry` 增 `isSidechain: boolean`。
  - `parseEntry`:`isSidechain: o.isSidechain === true`。
  - `activeChain` 起点改为最后一个非 sidechain 节点,并在回溯中跳过 sidechain:

```ts
activeChain(): ChatMessage[] {
  this.ingest();
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  let cur: string | null = null;
  for (let i = this.order.length - 1; i >= 0; i--) {
    const e = this.byUuid.get(this.order[i]);
    if (e && !e.isSidechain) { cur = e.uuid; break; }
  }
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = this.byUuid.get(cur);
    if (!e) break;
    if (!e.isSidechain && e.msg) out.push(e.msg);
    cur = e.parentUuid;
  }
  return out.reverse();
}
```

- [ ] **Step 4: 跑绿**(含既有分叉/reset/缺文件回归)
- [ ] **Step 5: 提交** `fix(server): activeChain 排除子代理 sidechain,避免主线被替换`

### Task A4: 真实 transcript 片段夹具(可信回归)

- [ ] 用本机真实片段(脱敏:截断长文本、抹密钥)落 `__fixtures__/transcript_tool_round.jsonl`(含 人类→assistant(text+tool_use)→user(tool_result)→assistant(text))与 `transcript_ask.jsonl`(含 AskUserQuestion tool_use + 其 tool_result answer)。
- [ ] 加一条夹具驱动测试:`activeChain` 在 tool_round 夹具上给出 `[user, assistant, (tool_result user), assistant]` 且角色正确。
- [ ] 提交 `test(server): 真实 transcript 片段夹具(工具往返/AskUserQuestion)`

---

## Phase B — 共享协议追加(最小)

### Task B1: chatWs 追加 `ask_answer` / `ask_state` / `AskPick`

**Files:** Modify `packages/shared/src/chatWs.ts`;Test `chatWs.test.ts`

- [ ] **Step 1: 失败测试**

```ts
it('ask_answer 往返', () => {
  const m = { type:'ask_answer', toolUseId:'t1', picks:[{questionIndex:0, optionIndices:[1]}] } as const;
  expect(decodeChatClient(JSON.stringify(m))).toEqual(m);
});
it('非法 ask_answer 拒绝', () => {
  expect(decodeChatClient(JSON.stringify({ type:'ask_answer', toolUseId:'t1' }))).toBeNull();
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** 在 chatWs.ts:

```ts
export const AskPickSchema = z.object({
  questionIndex: z.number().int().nonnegative(),
  optionIndices: z.array(z.number().int().nonnegative()),
});
export type AskPick = z.infer<typeof AskPickSchema>;
// ChatClientSchema 追加：
//   z.object({ type: z.literal('ask_answer'), toolUseId: z.string(), picks: z.array(AskPickSchema) }),
// ChatServerMessage 追加：
//   | { type:'ask_state'; toolUseId:string; status:'driving'|'done'|'failed'; error?:string }
```

- [ ] **Step 4: 跑绿** `npm test -w packages/shared`
- [ ] **Step 5: 提交** `feat(shared): chatWs 追加 ask_answer/ask_state`

---

## Phase C — 前端回合分组与原生观感

### Task C1: `groupTurns` 纯函数

**Files:** Create `apps/web/src/lib/chat/groupTurns.ts`(+`.test.ts`)

- [ ] **Step 1: 失败测试**(线性、工具往返、tool_result 不起回合、并行 tool_use、AskUserQuestion 进助手回合)

```ts
import { groupTurns } from './groupTurns';
const user = (u:string,text:string)=>({uuid:u,role:'user' as const,blocks:[{type:'text' as const,text}]});
const asst = (u:string,...blocks:any[])=>({uuid:u,role:'assistant' as const,blocks});
const toolRes = (u:string,id:string)=>({uuid:u,role:'user' as const,blocks:[{type:'tool_result' as const,toolUseId:id,content:'o'}]});

it('用户/助手交替 → 两回合', () => {
  const t = groupTurns([user('u1','hi'), asst('a1',{type:'text',text:'yo'})]);
  expect(t.map(x=>x.kind)).toEqual(['user','assistant']);
});
it('一轮多条助手 + 工具结果 → 单一助手回合', () => {
  const t = groupTurns([
    user('u1','do'),
    asst('a1',{type:'text',text:'step1'},{type:'tool_use',id:'b',name:'Bash',input:{command:'ls'}}),
    toolRes('r1','b'),
    asst('a2',{type:'text',text:'done'}),
  ]);
  expect(t.map(x=>x.kind)).toEqual(['user','assistant']);
  const a = t[1] as any;
  expect(a.blocks.map((b:any)=>b.type)).toEqual(['text','tool_use','text']); // tool_result 不进 blocks
});
```

- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现**

```ts
import type { ChatMessage, ContentBlock } from '@rcc/shared';
export type Turn =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; id: string; blocks: ContentBlock[] };

function isRealUser(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image');
}
function isToolResultOnly(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.type === 'tool_result');
}

export function groupTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Extract<Turn, { kind:'assistant' }> | null = null;
  for (const m of messages) {
    if (isToolResultOnly(m)) continue;            // 结果靠 id 配对,不进回合结构
    if (isRealUser(m)) { cur = null; turns.push({ kind:'user', message:m }); continue; }
    if (m.role === 'assistant') {
      if (!cur) { cur = { kind:'assistant', id:m.uuid, blocks:[] }; turns.push(cur); }
      cur.blocks.push(...m.blocks.filter((b)=>b.type!=='tool_result'));
    }
  }
  return turns;
}
```

- [ ] **Step 4: 跑绿**
- [ ] **Step 5: 提交** `feat(web): groupTurns 回合分组纯函数`

### Task C2: `UserTurn` / `AssistantTurn` / `TurnList` 组件

**Files:** Create `components/chat/{UserTurn,AssistantTurn,TurnList}.tsx`;复用 `ToolCard`/`markdown`/`Thinking`

- [ ] **Step 1**(无强逻辑,组件渲染):`AssistantTurn` 按 blocks 顺序渲染 text(Markdown)/thinking(折叠)/tool_use(ToolCard;`name==='AskUserQuestion'`→`AskChoiceCard`),`toolResults` 注入。`UserTurn` 渲染右侧气泡(text/image)。`TurnList` map `Turn[]`。
- [ ] **Step 2: 接入 ChatView**:`const turns = useMemo(()=>groupTurns(visibleMessages),[messages])`;移除旧 `isToolFeedback` 过滤(改由 groupTurns 处理)与逐条 `MessageBubble`,改 `<TurnList turns={turns} toolResults={toolResults}/>`。保留:乐观回显、preview 临时助手块、running「思考中」、滚动到底。
- [ ] **Step 3: 前端类型检查 + 构建** `npm run -w apps/web build`(Expected: 通过)
- [ ] **Step 4: 提交** `feat(web): 回合渲染(单一助手回合 + 工具卡配对),替换逐气泡`

### Task C3: 原生观感样式 + 动画

**Files:** Modify chat 样式(`themes/tokens.css` + 组件 className)

- [ ] **先读** `/mnt/skills/public/frontend-design/SKILL.md` 与现有 `themes/tokens.css`,沿用设计变量。
- [ ] 用户回合:右对齐、强调底色、圆角;助手回合:左对齐、扁平、`⏺` 风格行首点;清晰区分二者。
- [ ] 动画:回合淡入上移(`@keyframes`)、工具卡展开高度过渡、思考折叠淡入、流式光标(沿用)、思考中呼吸点。保留 Ctrl+O/点击展开交互不变。
- [ ] 手机视口实测(窄屏不溢出、可滚动、可选可复制)。
- [ ] 提交 `style(web): 聊天回合原生观感 + 动画(保留 Ctrl+O 展开)`

---

## Phase D — AskUserQuestion 选择框 + 闭环驱动

### Task D1: Spike — 采集真实 AskUserQuestion TUI 快照

- [ ] 用独立 socket `rccn` 起真实交互式 claude(参考 `smoke-chat.ts`),发一句**明确诱导 AskUserQuestion** 的提示(如「用 AskUserQuestion 问我两个问题,各两个选项」),`capture-pane -p` 落 `__fixtures__/ask_single.txt`(单问单选)与(若能)`ask_multi.txt`(多选)。
- [ ] **观察并记录**菜单键位:上下导航、确认键、多选切换键、是否支持数字直选、多问题如何切换、取消键。把结论写入 spike 注释/计划备注(askController 据此实现)。
- [ ] 提交 `test(server): AskUserQuestion 真实 TUI 快照夹具 + 键位实测记录`

### Task D2: `askScraper` 纯函数

**Files:** Create `askScraper.ts`(+`.test.ts`),用 D1 夹具

- [ ] **Step 1: 失败测试**(用 ask_single.txt 断言:open、当前题文本、选项 labels、cursor、multiSelect、stage)。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** `parseAskPicker(pane): AskPickerState`(仿 `rewindScraper` 结构:`{ open, stage, questionIndex, options:{label}[], cursor, selected:number[], multiSelect }`,以 D1 实测标志为准)。
- [ ] **Step 4: 跑绿**
- [ ] **Step 5: 提交** `feat(server): askScraper 解析 AskUserQuestion TUI 菜单态`

### Task D3: `askController` 闭环驱动 + 双校验

**Files:** Create `askController.ts`(+`.test.ts`),注入 fake tmux(序列化菜单态)

- [ ] **Step 1: 失败测试**:fake tmux 按发键推进菜单态;断言 `answer(picks)` 导航到目标选项→校验命中→确认;目标不可达/光标卡住/stage 丢失 → Esc 回退并 `{ok:false}`。
- [ ] **Step 2: 跑红**
- [ ] **Step 3: 实现** `AskController.answer(picks): Promise<{ok:boolean;error?:string}>`,完全照 `RewindController` 范式(snap→导航→双校验→确认;不确定 `abort`+Esc)。多问题循环;多选用切换键逐个选中后确认。
- [ ] **Step 4: 跑绿**
- [ ] **Step 5: 提交** `feat(server): askController 闭环驱动 AskUserQuestion(双校验+回退)`

### Task D4: 接线(session/registry/route)

**Files:** Modify `chatSession.ts`、`chatRegistry.ts`、`routes/chat.ts`

- [ ] `chatSession` 增 `answerAsk(toolUseId, picks)`:`tick` 期间静默(同 rewindActive),调 `AskController.answer`,广播 `ask_state driving/done/failed`。
- [ ] `chatRegistry.ChatHandle` + `ChatSubscriber` 增 `answerAsk` / `onAskState`。
- [ ] `routes/chat.ts`:`case 'ask_answer'` → `handle.answerAsk(...)`;`onAskState` → `send({type:'ask_state',...})`。
- [ ] 注入 fake 单测覆盖 registry 转发;`chatSession` ask 静默 tick 不串味。
- [ ] 提交 `feat(server): ask_answer 路由转发 + ask 驱动接线`

### Task D5: `AskChoiceCard` 前端 + 接入

**Files:** Create `AskChoiceCard.tsx`;Modify `AssistantTurn.tsx`、`ChatView.tsx`、`lib/chatWs.ts`

- [ ] 渲染:从 `tool_use.input.questions[]` 出题与按钮(`header`/`question`/`options`);`multiSelect` 多选 + 确认按钮;pending(无 tool_result)可点,resolved 显已选答案、禁用。
- [ ] 点击 → `socket.send({type:'ask_answer',toolUseId,picks})`;`onAskState` 显示 driving/失败提示(失败提示「可用下方按键条手动作答」)。
- [ ] **pending ask 时抑制 preview 气泡**(ChatView:`hasPendingAsk` 为真则不渲染 preview)。
- [ ] 前端构建通过;组件测试:渲染选项、点选发消息、resolved 态。
- [ ] 提交 `feat(web): AskChoiceCard 选择框(点选驱动 + 回退提示 + 抑制预览)`

---

## Phase E — 真实集成验证 + 独立实例

### Task E1: 扩展冒烟 + 全量回归

- [ ] 扩展 `smoke-chat.ts`:跑「含一次工具调用的一轮」,断言 `groupTurns` 后**单一助手回合**、工具卡有结果、无 user 气泡错配。(AskUserQuestion 驱动可手动验,记录结论。)
- [ ] `npm test`(全量,server+shared+web 若有)、`npm run typecheck`、`npm run build` 全绿。
- [ ] 用 `npx tsx apps/server/scripts/smoke-chat.ts`(socket rccn)真跑,贴结果。
- [ ] 提交 `test: 冒烟覆盖回合分组 + 工具配对;全量回归绿`

### Task E2: 独立端口实例供验收

- [ ] worktree `.env` 已设 PORT=6400 / TMUX_SOCKET=rccn / RCC_SERVICE_TMUX=remote-cc-native-server。
- [ ] 准备 `config/projects.json`(指向一个可测项目,如 worktree 自身)。
- [ ] `./start.sh` 起实例(tmux 会话 remote-cc-native-server),确认 `:6400` 监听。
- [ ] 自测:口令登录→开聊天会话→发消息→看回合/工具卡/AskUserQuestion;贴关键截图/日志说明。
- [ ] 用 `finishing-a-development-branch` 收尾(汇总改动,等用户验收)。

---

## 自检(spec 覆盖 / 占位 / 类型一致)

- **覆盖**:角色归属=A1–A3;主线净化=A2;sidechain=A3;回合分组=C1–C2;原生观感=C3;AskUserQuestion 渲染=D5;驱动=D2–D4;预览抑制=D5;wire 追加=B1;真实验证=E1–E2。✓
- **占位**:D1 是有意的 spike(键位实测),非占位;其余步骤含具体代码/命令。
- **类型一致**:`AskPick{questionIndex,optionIndices}` 贯穿 B1/D3/D5;`Turn` 联合贯穿 C1/C2;`classifyEntry`/`EntryClass` 贯穿 A1/A2;`activeChain` 跳过 `isSidechain` 与 A3 一致。
