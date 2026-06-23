# 原生聊天模式 实现计划

> **For agentic workers:** 用 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]`。

**Goal:** 在 remote-cc 新增「聊天模式」会话——服务器侧跑 100% 原生交互式 Claude Code（tmux + `--session-id`），手机端是原生聊天 UI（气泡/Markdown/可选可复制/逐字流式），终端模式原样保留。

**Architecture:** 复用现有 `Tmux`。聊天会话用 `tmux new-session -d` 起原生 claude；输入走 `send-keys`/`paste-buffer`；逐字流式来自轮询 `capture-pane` 去 chrome；干净结构化渲染来自监听 transcript jsonl（`find ~/.claude/projects -name <uuid>.jsonl`）。会话用 `Conversation.mode` 分发。

**Tech Stack:** Node 22 + Fastify + @fastify/websocket；React + Vite；zod；vitest（后端/shared）；react-markdown + remark-gfm（前端渲染）。

**测试范围取舍：** 后端/shared 走 TDD（vitest）；前端无测试运行器，靠 `tsc --noEmit` + 集成冒烟。

---

## 文件结构

新增（后端）：
- `apps/server/src/lib/session/chat/paneScraper.ts`(+test) — 纯函数：从 capture-pane 文本剥 chrome、抽在生成中的助手预览、判 running。
- `apps/server/src/lib/session/chat/transcript.ts`(+test) — 纯函数：jsonl 行 → `ChatMessage`；定位/读取。
- `apps/server/src/lib/session/chat/chatSession.ts`(+test) — 单会话运行时：ensure/sendText/sendKey/poll/dispose。
- `apps/server/src/lib/session/chat/chatRegistry.ts`(+test) — convId→session，订阅共享。
- `apps/server/src/routes/chat.ts` — WS 端点。
- `apps/server/src/lib/session/__fixtures__/` — 真实 pane 快照 + transcript 片段。

新增（shared）：`packages/shared/src/chatWs.ts`(+test) — 协议 + zod。

新增（前端）：`apps/web/src/lib/chatWs.ts`；`apps/web/src/components/chat/{ChatView,MessageBubble,ToolCard,Composer,KeyBar,SlashPalette,TerminalPeek,markdown}.tsx`。

小改：`packages/shared/src/schemas.ts`(Conversation+mode/sessionId)、`apps/server/src/lib/session/tmux.ts`(薄封装)、`apps/server/src/lib/conversations.ts`(mode/sessionId)、`apps/server/src/routes/sessions.ts`(create 带 mode)、`apps/server/src/context.ts`+`app.ts`(挂 chat)、`apps/web/src/lib/api.ts`(createConversation 带 mode)、`apps/web/src/components/{ProjectDetail,ConversationList}.tsx`、`apps/web/package.json`(deps)。

不动：`ptyBridge.ts`/`registry.ts`/`Terminal.tsx`/`lib/ws.ts`/`shared/src/ws.ts`/files/taskEvidence/auth/plugins。

---

## Task 1: 共享类型 — Conversation.mode/sessionId

**Files:** Modify `packages/shared/src/schemas.ts`

- [ ] **Step 1:** 在 `ConversationSchema` 增加字段（mode 默认 terminal 向后兼容；sessionId 可选）：

```ts
export const SessionModeSchema = z.enum(['terminal', 'chat']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  tmuxName: z.string().min(1),
  mode: SessionModeSchema.default('terminal'),
  sessionId: z.string().optional(), // claude 会话 UUID（chat 模式）
  alive: z.boolean(),
  createdAt: z.string(),
});
```

- [ ] **Step 2:** typecheck：`npm -w @rcc/shared run typecheck` → PASS
- [ ] **Step 3:** commit `feat(shared): Conversation 增加 mode/sessionId`

---

## Task 2: 共享类型 — chatWs 协议

**Files:** Create `packages/shared/src/chatWs.ts`, `packages/shared/src/chatWs.test.ts`; Modify `packages/shared/src/index.ts`

- [ ] **Step 1: 写失败测试** `chatWs.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { decodeChatClient, encodeChatServer } from './chatWs';

describe('chatWs', () => {
  it('解析 user_text', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'user_text', text: 'hi' })))
      .toEqual({ type: 'user_text', text: 'hi' });
  });
  it('解析 key', () => {
    expect(decodeChatClient(JSON.stringify({ type: 'key', key: 'esc' })))
      .toEqual({ type: 'key', key: 'esc' });
  });
  it('拒绝非法', () => {
    expect(decodeChatClient('{"type":"nope"}')).toBeNull();
    expect(decodeChatClient('not json')).toBeNull();
  });
  it('编码 server 消息', () => {
    const s = encodeChatServer({ type: 'preview', text: 'x' });
    expect(JSON.parse(s)).toEqual({ type: 'preview', text: 'x' });
  });
});
```

- [ ] **Step 2:** 运行 → FAIL（模块不存在）
- [ ] **Step 3: 实现** `chatWs.ts`：

```ts
import { z } from 'zod';
import { type SessionMode } from './schemas';

export const ChatKeySchema = z.enum(['up', 'down', 'left', 'right', 'enter', 'esc', 'ctrl-c']);
export type ChatKey = z.infer<typeof ChatKeySchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.string(), isError: z.boolean().optional() }),
  z.object({ type: z.literal('image'), alt: z.string().optional() }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ChatMessageSchema = z.object({
  uuid: z.string(),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(ContentBlockSchema),
  ts: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const ClientSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_text'), text: z.string() }),
  z.object({ type: z.literal('key'), key: ChatKeySchema }),
  z.object({ type: z.literal('image'), dataB64: z.string(), mime: z.string(), name: z.string() }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('resync') }),
]);
export type ChatClientMessage = z.infer<typeof ClientSchema>;

export type ChatServerMessage =
  | { type: 'history'; messages: ChatMessage[] }
  | { type: 'message'; message: ChatMessage }
  | { type: 'preview'; text: string }
  | { type: 'turn_state'; running: boolean }
  | { type: 'session'; sessionId: string | null; name: string; mode: SessionMode }
  | { type: 'error'; message: string };

export function decodeChatClient(raw: string): ChatClientMessage | null {
  try { const r = ClientSchema.safeParse(JSON.parse(raw)); return r.success ? r.data : null; }
  catch { return null; }
}
export function encodeChatServer(msg: ChatServerMessage): string { return JSON.stringify(msg); }
```

- [ ] **Step 4:** Modify `index.ts` 加 `export * from './chatWs';`
- [ ] **Step 5:** 运行 `npm -w @rcc/shared run test` → PASS；typecheck PASS
- [ ] **Step 6:** commit `feat(shared): chat WS 协议 + zod`

---

## Task 3: Tmux 薄封装（聊天模式所需子命令）

**Files:** Modify `apps/server/src/lib/session/tmux.ts`, `apps/server/src/lib/session/tmux.test.ts`

聊天模式需要：`new-session -d`（detached 起会话）、`send-keys`（按键/Enter）、`set-buffer`+`paste-buffer`（多行文本）、`capture-pane`（已有）、`hasSession`（已有）。

- [ ] **Step 1: 失败测试**（注入 mock exec，断言 argv 拼装）：

```ts
it('newDetachedArgs 构造 detached 会话', () => {
  const t = new Tmux('rcc');
  expect(t.newDetachedArgs('rcc-p-c', '/proj', "Fable-yolo --session-id u1", 120, 40))
    .toEqual(['-L','rcc','new-session','-d','-s','rcc-p-c','-c','/proj','-x','120','-y','40','--','bash','-ic','Fable-yolo --session-id u1']);
});
it('sendKeys 发送命名键', async () => {
  const calls: string[][] = [];
  const t = new Tmux('rcc', async (_f, a) => { calls.push(a); return { stdout:'', stderr:'' }; });
  await t.sendKeys('rcc-p-c', ['Escape']);
  expect(calls[0]).toEqual(['-L','rcc','send-keys','-t','rcc-p-c','Escape']);
});
it('pasteText 用 buffer 粘贴多行', async () => {
  const calls: string[][] = [];
  const t = new Tmux('rcc', async (_f,a)=>{calls.push(a);return {stdout:'',stderr:''};});
  await t.pasteText('rcc-p-c', 'line1\nline2');
  expect(calls[0].slice(0,3)).toEqual(['-L','rcc','set-buffer']);
  expect(calls[1].slice(0,3)).toEqual(['-L','rcc','paste-buffer']);
});
```

- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现** 增加方法：

```ts
newDetachedArgs(name: string, cwd: string, command: string, cols: number, rows: number): string[] {
  return [...this.base(),'new-session','-d','-s',name,'-c',cwd,'-x',String(cols),'-y',String(rows),'--','bash','-ic',command];
}
async newDetached(name: string, cwd: string, command: string, cols: number, rows: number): Promise<void> {
  await this.exec('tmux', this.newDetachedArgs(name, cwd, command, cols, rows));
}
async sendKeys(name: string, keys: string[]): Promise<void> {
  await this.exec('tmux', [...this.base(),'send-keys','-t',name,...keys]);
}
async pasteText(name: string, text: string): Promise<void> {
  await this.exec('tmux', [...this.base(),'set-buffer','-b','rcc-paste','--',text]);
  await this.exec('tmux', [...this.base(),'paste-buffer','-d','-b','rcc-paste','-t',name]);
}
```

（注：`sendKeys` 命名键用 `-t name Key`；字面文本另走 pasteText。`set-buffer -b rcc-paste -- text` 命名缓冲避免污染；`paste-buffer -d` 用完即删。）

- [ ] **Step 4:** 运行 tmux.test → PASS
- [ ] **Step 5:** commit `feat(server): Tmux 增加 detached/sendKeys/pasteText`

---

## Task 4: paneScraper（读屏去 chrome → 流式预览）

**Files:** Create `apps/server/src/lib/session/chat/paneScraper.ts`, `paneScraper.test.ts`; 夹具 `apps/server/src/lib/session/__fixtures__/pane_{boot,spinner,streaming,complete}.txt`（从 /tmp/rcc_fixtures 复制）

接口：`scrapePane(pane: string): { preview: string; running: boolean }`
- running：含 spinner（`✽`/`✻`/`✶`/`✷` 等 + `…` 或 `esc to interrupt`）或 `Cooked`/`Slithering` 等动词行视为活动；完成态 `✻ ... for Ns` 视为刚结束（running=false）。简化判定：出现 `esc to interrupt` 或 spinner glyph 行且无 `for ` 结尾 → running=true。
- preview：去顶部欢迎框（`╭─── Claude Code` 到 `╰───`）；去底部输入区（最后一段 `─{20,}`/`❯ `/状态行 `[.*] ... %`/`⏵⏵`）；取最后一个以 `❯ ` 开头(用户回显)之后的行；剥行首 `● `、续行前导 2 空格、丢 spinner 行；trim。

- [ ] **Step 1: 失败测试**（用真实夹具）：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scrapePane } from './paneScraper';
const fx = (n: string) => readFileSync(join(__dirname, '../__fixtures__', n), 'utf8');

describe('scrapePane', () => {
  it('boot：无预览、未运行', () => {
    const r = scrapePane(fx('pane_boot.txt'));
    expect(r.running).toBe(false);
    expect(r.preview).toBe('');
  });
  it('streaming：运行中且预览含已生成正文', () => {
    const r = scrapePane(fx('pane_streaming.txt'));
    expect(r.running).toBe(true);
    expect(r.preview).toContain('二叉搜索树');
    expect(r.preview).not.toContain('●');
    expect(r.preview).not.toContain('❯');
    expect(r.preview).not.toMatch(/bypass permissions/);
  });
  it('complete：预览含完整 5 句、不含 chrome', () => {
    const r = scrapePane(fx('pane_complete.txt'));
    expect(r.preview).toContain('红黑树');
    expect(r.preview).not.toContain('Cooked');
    expect(r.preview).not.toContain('───');
  });
});
```

- [ ] **Step 2:** 复制夹具：`mkdir -p apps/server/src/lib/session/__fixtures__ && cp /tmp/rcc_fixtures/pane_*.txt apps/server/src/lib/session/__fixtures__/`
- [ ] **Step 3:** 运行 → FAIL
- [ ] **Step 4: 实现** paneScraper（按上面规则；正则：欢迎框、`^─{20,}$`、`^\s*\[[^\]]*\]\s+.*%`、`^\s*⏵⏵`、spinner glyph 集 + `…`）。逐行处理，注意中文宽字符不影响纯文本切割。
- [ ] **Step 5:** 运行 → PASS（如夹具暴露规则偏差，调正则到通过）
- [ ] **Step 6:** commit `feat(server): paneScraper 读屏出流式预览`

---

## Task 5: transcript 解析 + tail

**Files:** Create `apps/server/src/lib/session/chat/transcript.ts`, `transcript.test.ts`; 夹具 `__fixtures__/transcript_sample.jsonl`（构造若干行：user 文本、assistant text、assistant tool_use、user tool_result）

接口：
- `parseTranscriptLine(line: string): ChatMessage | null` — 把一行 jsonl 规整为 ChatMessage（只取 type in user/assistant 且 message.content 有内容；忽略 system/attachment/meta）。tool_use→block；tool_result→block（content 拍平成字符串）。
- `class TranscriptTail { constructor(filePath getter) }`：`readAll(): ChatMessage[]`；`poll(): ChatMessage[]`（返回自上次以来的新消息，按字节偏移读增量）；`locate(sessionId): string|null`（glob）。locate/IO 用注入的 fs 以便测试，或 readAll/poll 接受路径。

- [ ] **Step 1: 失败测试** `transcript.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from './transcript';

describe('parseTranscriptLine', () => {
  it('user 文本', () => {
    const o = { type:'user', uuid:'u1', message:{ role:'user', content:[{type:'text',text:'hi'}] } };
    expect(parseTranscriptLine(JSON.stringify(o)))
      .toMatchObject({ uuid:'u1', role:'user', blocks:[{type:'text',text:'hi'}] });
  });
  it('assistant text + tool_use', () => {
    const o = { type:'assistant', uuid:'a1', message:{ role:'assistant', content:[
      {type:'text',text:'doing'},{type:'tool_use',id:'t1',name:'Bash',input:{command:'ls'}} ]}};
    const m = parseTranscriptLine(JSON.stringify(o))!;
    expect(m.role).toBe('assistant');
    expect(m.blocks).toHaveLength(2);
    expect(m.blocks[1]).toMatchObject({ type:'tool_use', name:'Bash' });
  });
  it('tool_result（content 数组拍平）', () => {
    const o = { type:'user', uuid:'u2', message:{ role:'user', content:[
      {type:'tool_result',tool_use_id:'t1',content:[{type:'text',text:'out'}]} ]}};
    expect(parseTranscriptLine(JSON.stringify(o))!.blocks[0])
      .toMatchObject({ type:'tool_result', toolUseId:'t1', content:'out' });
  });
  it('忽略 meta 行', () => {
    expect(parseTranscriptLine(JSON.stringify({ type:'attachment' }))).toBeNull();
    expect(parseTranscriptLine('bad')).toBeNull();
  });
});
```

- [ ] **Step 2:** → FAIL
- [ ] **Step 3: 实现** `parseTranscriptLine`（容错 JSON.parse；content 可能是字符串或数组；tool_result.content 数组→join text；string→直接用）。
- [ ] **Step 4:** → PASS
- [ ] **Step 5: 加 TranscriptTail 测试**（用临时文件：写两行→readAll=2；append 一行→poll=1；再 poll=0）。实现基于 `fs.statSync`/按 offset `read`。
- [ ] **Step 6:** → PASS
- [ ] **Step 7:** commit `feat(server): transcript 解析与增量 tail`

---

## Task 6: chatSession + chatRegistry

**Files:** Create `chatSession.ts`, `chatSession.test.ts`, `chatRegistry.ts`, `chatRegistry.test.ts`

`chatSession` 依赖注入：`{ tmux: Tmux-like, transcript: TranscriptTail-like, now, scrape: scrapePane }`。职责：
- `ensure(spec)`：`tmux.hasSession`？无 → 判 transcript 是否存在 → `command = launchCommand + (resume? ' --resume '+uuid : ' --session-id '+uuid)` → `tmux.newDetached`。
- `sendText(text)`：`tmux.pasteText` + `tmux.sendKeys([Enter])`，并标记 running、启动/续期轮询。
- `sendKey(key)`：映射 up→Up…esc→Escape，ctrl-c→C-c → `tmux.sendKeys`。
- 轮询循环（有订阅者时 250ms）：`capture-pane` → `scrape` → 出 `preview`/`turn_state`；`transcript.poll()` → 出 `message`。
- 事件经回调给 registry 广播。

`chatRegistry`：与现有 `SessionRegistry` 同构（subscribe 首个建 session、共享、末个 unsubscribe 停轮询不杀 tmux）。

- [ ] **Step 1: chatSession 失败测试**（注入假 tmux 记录调用 + 假 transcript 受控 emit；用 fake timers）：断言 ensure 选路（有 transcript→--resume，无→--session-id）、sendText 触发 pasteText+Enter、sendKey 映射正确、轮询把 scrape/transcript 结果发出。
- [ ] **Step 2:** → FAIL
- [ ] **Step 3: 实现** chatSession。
- [ ] **Step 4:** → PASS
- [ ] **Step 5: chatRegistry 失败测试**（仿 registry.test.ts：首个建、共享广播、末个停）。
- [ ] **Step 6:** 实现 → PASS
- [ ] **Step 7:** commit `feat(server): chatSession + chatRegistry`

---

## Task 7: 会话存储 + sessions 路由带 mode

**Files:** Modify `apps/server/src/lib/conversations.ts`, `apps/server/src/routes/sessions.ts`, `apps/server/src/app.test.ts`(若覆盖)

- [ ] **Step 1:** `conversations.ts`：`create(projectId, name, mode='terminal')`：chat 模式生成 `sessionId = crypto.randomUUID()` 并存；StoredConversation 增加 `mode`/`sessionId`；旧记录读出补 `mode:'terminal'`。
- [ ] **Step 2:** `routes/sessions.ts`：`CreateConvSchema` 加 `mode: SessionModeSchema.optional()`；create 传入 mode；`withAlive` 返回带 `mode`/`sessionId`（chat 的 alive 仍按 tmuxName，因 chat 也用 tmux）。
- [ ] **Step 3:** 运行 server 测试 → PASS（修可能的类型/字段断言）
- [ ] **Step 4:** commit `feat(server): 会话支持 mode/sessionId`

---

## Task 8: chat 路由 + 装配

**Files:** Create `apps/server/src/routes/chat.ts`; Modify `context.ts`, `app.ts`

- [ ] **Step 1:** `context.ts`：构造 `chatRegistry`（注入 tmux）；加入 AppContext。
- [ ] **Step 2:** `routes/chat.ts`：WS `/api/projects/:id/conversations/:cid/chat`：鉴权（同 sessions）→ 取 project/conv → `chatRegistry.subscribe(...)`（spec: tmuxName, cwd, launchCommand, sessionId, transcript locate）→ 首发 `session` + `history`(transcript.readAll) → 订阅 message/preview/turn_state 转发 → 收 `decodeChatClient`：user_text→sendText、key→sendKey、image→存临时文件后 sendText(路径)、interrupt→sendKey('esc')、resync→重发 history。
- [ ] **Step 3:** `app.ts`：`registerChatRoutes(app, ctx)`。
- [ ] **Step 4:** 运行 server 测试 + typecheck → PASS
- [ ] **Step 5:** commit `feat(server): chat WS 路由与装配`

---

## Task 9: 前端 chatWs 客户端

**Files:** Create `apps/web/src/lib/chatWs.ts`

仿 `lib/ws.ts`：`connectChat(projectId, convId, handlers)` 自动重连；`send(ChatClientMessage)`；handlers：onHistory/onMessage/onPreview/onТurnState/onSession/onOpen/onClose。

- [ ] **Step 1:** 实现（结构同 ws.ts，URL 改 `/chat`，分发 ChatServerMessage）。
- [ ] **Step 2:** `npm -w @rcc/web run typecheck` → PASS
- [ ] **Step 3:** commit `feat(web): chat WS 客户端`

---

## Task 10: 前端依赖 + Markdown 渲染

**Files:** Modify `apps/web/package.json`; Create `apps/web/src/components/chat/markdown.tsx`

- [ ] **Step 1:** 加依赖 `react-markdown@^9`, `remark-gfm@^4`；`npm install`。
- [ ] **Step 2:** `markdown.tsx`：导出 `<Markdown>{text}</Markdown>` 封装 react-markdown + remark-gfm，代码块/表格用 `themes` 的 class。
- [ ] **Step 3:** typecheck → PASS
- [ ] **Step 4:** commit `feat(web): 引入 markdown 渲染`

---

## Task 11: 前端聊天组件

**Files:** Create `apps/web/src/components/chat/{ChatView,MessageBubble,ToolCard,Composer,KeyBar,SlashPalette,TerminalPeek}.tsx`; Modify `apps/web/src/index.css`(聊天样式)

- [ ] **Step 1:** `MessageBubble`（user 右/assistant 左；assistant 用 Markdown；thinking 折叠；tool_use/tool_result 交给 ToolCard）。
- [ ] **Step 2:** `ToolCard`（折叠头 `🔧 Name(参数摘要)`；展开显 input/output；Bash 显命令+输出，Edit/Write 显 diff/路径）。
- [ ] **Step 3:** `Composer`（textarea 自适应；发送按钮；`/` 唤 SlashPalette；图片按钮 file input → base64 → send image；`@` 唤 FileBrowser 选路径插入）。
- [ ] **Step 4:** `KeyBar`（↑↓←→/回车/Esc/Ctrl-C → send key；上键空输入回溯历史）。
- [ ] **Step 5:** `SlashPalette`（输入 `/` 后过滤常用命令列表，回车/点选插入）。
- [ ] **Step 6:** `TerminalPeek`（折叠，按需 resync 显示当前 pane 文本，兜底 TUI 菜单）。
- [ ] **Step 7:** `ChatView`（容器：connectChat；合并 history+message；running 时显 preview 临时气泡；顶栏返回/状态/会话名；底部 Composer+KeyBar）。
- [ ] **Step 8:** index.css 加聊天样式（气泡、卡片、按键条），沿用 tokens。
- [ ] **Step 9:** typecheck → PASS
- [ ] **Step 10:** commit `feat(web): 聊天 UI 组件`

---

## Task 12: 接线 — 创建时选模式 + 列表分发

**Files:** Modify `apps/web/src/lib/api.ts`, `ConversationList.tsx`, `ProjectDetail.tsx`

- [ ] **Step 1:** `api.createConversation(pid, name?, mode?)` 传 mode。
- [ ] **Step 2:** `ConversationList`：新建按钮改为两个/带选择（「＋ 聊天会话」默认、「＋ 终端会话」），create 传 mode；行内显示 mode 徽标（聊天/终端）。
- [ ] **Step 3:** `ProjectDetail`：`openConv.mode === 'chat'` → `<ChatView>` 否则 `<Terminal>`。
- [ ] **Step 4:** typecheck → PASS
- [ ] **Step 5:** commit `feat(web): 会话按模式创建与分发`

---

## Task 13: 集成冒烟 + 全量验证

- [ ] **Step 1:** `npm test`（shared+server 全绿）。
- [ ] **Step 2:** `npm run typecheck`（三包全绿）。
- [ ] **Step 3:** `npm run build`（web 构建通过）。
- [ ] **Step 4:** 集成冒烟脚本：起后端 → 用 ws 客户端连 chat 端点（用一个临时 chat 会话）→ 发 "reply hi in one word" → 断言收到 preview 或 message 且 transcript 落盘 → 清理 tmux。记录到 `docs/superpowers/`。
- [ ] **Step 5:** commit `test: 聊天模式集成冒烟`

---

## Task 14: README

- [ ] **Step 1:** README 增「两套启动方式（终端模式 / 聊天模式）」与聊天模式原理（原生交互式 + 读屏流式 + transcript 渲染）。
- [ ] **Step 2:** commit `docs: README 说明聊天模式`
