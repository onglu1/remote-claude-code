# 聊天历史「骨架 + 按需取正文」实现计划

> **For agentic workers:** 用 superpowers:test-driven-development 逐任务实现;步骤用 `- [ ]` 勾选跟踪。

**Goal:** 连上聊天会话时只下发"骨架(用户消息全文 + 每个 AI 回合一个折叠占位 + 最后一轮底部一屏文本)",点折叠回合才按需取正文,省流量、加快打开与重连。

**Architecture:** 服务端用纯函数把活动链投影成 `ChatHistorySnapshot{ items, live }`;`history` 协议改发骨架,新增 `load_turn`/`turn_body` 取正文。前端把单一 `messages` 拆成 `history`(骨架)+`expanded`(已取正文)+`live`(本次新消息,沿用原流式逻辑),新增 `ChatHistory`/`CollapsedTurn` 渲染折叠。

**Tech Stack:** TypeScript、zod、Fastify + ws、React + Vite、vitest。

---

## 文件结构

- `packages/shared/src/chatWs.ts`(改):新增骨架数据类型;改 `history` 消息;加 `turn_body`/`load_turn`。
- `packages/shared/src/skeleton.ts`(新):`turnSlices` / `buildHistorySnapshot` / `getTurnSlice` 纯函数。
- `packages/shared/src/skeleton.test.ts`(新):纯函数单测。
- `packages/shared/src/turns.ts`(改):加 `collectToolResults` 复用 helper。
- `packages/shared/src/index.ts`(改):导出 `skeleton`。
- `apps/server/src/lib/session/chat/chatSession.ts`(改):`onHistory` 类型;`getSkeleton`/`getTurnBody`;两处发骨架;删 `getMessages`。
- `apps/server/src/lib/session/chat/chatRegistry.ts`(改):接口与订阅/resync 发骨架;`loadTurn`。
- `apps/server/src/routes/chat.ts`(改):`history` 发 items+live;`load_turn`→`turn_body`。
- `apps/server/src/lib/session/chat/chatSession.test.ts` / `chatRegistry.test.ts`(改):断言改骨架。
- `apps/web/src/lib/chatWs.ts`(改):`onHistory` 快照;`onTurnBody`。
- `apps/web/src/components/chat/ChatView.tsx`(改):三态拆分 + 渲染拼接。
- `apps/web/src/components/chat/ChatHistory.tsx`(新)、`CollapsedTurn.tsx`(新)。
- `apps/web/src/index.css`(改):折叠行样式。
- `apps/server/scripts/smoke-chat.ts`(改):适配快照 + 断言取正文。

---

## Task 1: shared 协议与骨架数据类型

**Files:** Modify `packages/shared/src/chatWs.ts`

- [ ] **Step 1: 在 `ChatMessageSchema` 之后加入骨架类型**

```ts
/** 折叠回合附带的"底部约一屏"文本(仅最后一个助手回合)。 */
export interface SkeletonTail {
  text: string;
  truncated: boolean; // true → 前端给"展开全部"(被截断或含工具/图片块)
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

- [ ] **Step 2: 客户端 schema 加 `load_turn`**(在 `ChatClientSchema` 联合里追加)

```ts
  z.object({ type: z.literal('load_turn'), turnId: z.string() }),
```

- [ ] **Step 3: 改 `history` 消息、加 `turn_body`**(在 `ChatServerMessage` 联合)

```ts
  | { type: 'history'; items: ChatSkeletonItem[]; live: ChatMessage[] }
  | { type: 'turn_body'; turnId: string; messages: ChatMessage[] }
```
(删除旧的 `{ type: 'history'; messages: ChatMessage[] }`)

- [ ] **Step 4: typecheck shared**

Run: `npm run typecheck -w @rcc/shared`
Expected: 报错集中在仍引用旧 `history.messages` 的 server/web(下游任务修);shared 本身通过。

---

## Task 2: skeleton 纯函数(TDD)

**Files:** Create `packages/shared/src/skeleton.ts`, `packages/shared/src/skeleton.test.ts`

- [ ] **Step 1: 写失败测试** `skeleton.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { turnSlices, buildHistorySnapshot, getTurnSlice } from './skeleton';
import type { ChatMessage } from './chatWs';

const u = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'text', text }] });
const a = (uuid: string, text: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'text', text }] });
const aTool = (uuid: string, id: string): ChatMessage => ({ uuid, role: 'assistant', blocks: [{ type: 'tool_use', id, name: 'Bash', input: {} }] });
const tr = (uuid: string, id: string): ChatMessage => ({ uuid, role: 'user', blocks: [{ type: 'tool_result', toolUseId: id, content: 'ok' }] });

describe('turnSlices', () => {
  it('空链 → []', () => expect(turnSlices([])).toEqual([]));
  it('工具回合保留 tool_result,turnId 取首条助手 uuid', () => {
    const chain = [u('u1', 'hi'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'done')];
    const s = turnSlices(chain);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ kind: 'user', message: chain[0] });
    expect(s[1].kind).toBe('assistant');
    if (s[1].kind === 'assistant') {
      expect(s[1].turnId).toBe('a1');
      expect(s[1].messages.map((m) => m.uuid)).toEqual(['a1', 'r1', 'a2']);
    }
  });
});

describe('buildHistorySnapshot', () => {
  it('多回合:用户全文 + 助手折叠,最后助手回合给 tail', () => {
    const chain = [u('u1', 'q1'), a('a1', 'r1'), u('u2', 'q2'), a('a2', 'r2-final')];
    const { items, live } = buildHistorySnapshot(chain, { running: false });
    expect(live).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(items[1]).toEqual({ kind: 'assistant', turnId: 'a1' }); // 旧回合无 tail
    expect(items[3]).toMatchObject({ kind: 'assistant', turnId: 'a2' });
    if (items[3].kind === 'assistant') {
      expect(items[3].tail?.text).toBe('r2-final');
      expect(items[3].tail?.truncated).toBe(false);
    }
  });
  it('tail 超长则截断末尾', () => {
    const long = 'x'.repeat(5000);
    const { items } = buildHistorySnapshot([u('u1', 'q'), a('a1', long)], { running: false, tailChars: 100 });
    const it3 = items[1];
    expect(it3.kind).toBe('assistant');
    if (it3.kind === 'assistant') {
      expect(it3.tail?.truncated).toBe(true);
      expect(it3.tail?.text.length).toBe(100);
      expect(long.endsWith(it3.tail!.text)).toBe(true);
    }
  });
  it('running:进行中助手回合剥离到 live、不进骨架', () => {
    const chain = [u('u1', 'q1'), a('a1', 'r1'), u('u2', 'q2'), a('a2', 'streaming…')];
    const { items, live } = buildHistorySnapshot(chain, { running: true });
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user']);
    expect(live.map((m) => m.uuid)).toEqual(['a2']);
  });
  it('含工具的最后回合:tail.truncated=true(有非文本块可展开)', () => {
    const chain = [u('u1', 'q'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'short')];
    const { items } = buildHistorySnapshot(chain, { running: false });
    const last = items[1];
    if (last.kind === 'assistant') expect(last.tail?.truncated).toBe(true);
  });
});

describe('getTurnSlice', () => {
  it('命中返回完整切片,未命中 null', () => {
    const chain = [u('u1', 'q'), aTool('a1', 't1'), tr('r1', 't1'), a('a2', 'done')];
    expect(getTurnSlice(chain, 'a1')?.map((m) => m.uuid)).toEqual(['a1', 'r1', 'a2']);
    expect(getTurnSlice(chain, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w @rcc/shared -- skeleton`
Expected: FAIL(模块未实现)。

- [ ] **Step 3: 实现 `skeleton.ts`**

```ts
import type { ChatMessage } from './chatWs';
import type { SkeletonTail, ChatSkeletonItem, ChatHistorySnapshot } from './chatWs';

export type TurnSlice =
  | { kind: 'user'; message: ChatMessage }
  | { kind: 'assistant'; turnId: string; messages: ChatMessage[] };

const DEFAULT_TAIL_CHARS = 1500;

function isRealUser(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.some((b) => b.type === 'text' || b.type === 'image');
}
function isToolResultOnly(m: ChatMessage): boolean {
  return m.role === 'user' && m.blocks.length > 0 && m.blocks.every((b) => b.type === 'tool_result');
}

/** 按回合切片,保留回合内全部原始消息(助手块 + 夹在其间的 tool_result-only 用户消息)。 */
export function turnSlices(chain: ChatMessage[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let cur: Extract<TurnSlice, { kind: 'assistant' }> | null = null;
  for (const m of chain) {
    if (isRealUser(m)) {
      cur = null;
      slices.push({ kind: 'user', message: m });
    } else if (isToolResultOnly(m)) {
      if (cur) cur.messages.push(m); // 孤儿 tool_result 忽略(不该出现)
    } else if (m.role === 'assistant') {
      if (!cur) {
        cur = { kind: 'assistant', turnId: m.uuid, messages: [] };
        slices.push(cur);
      }
      cur.messages.push(m);
    }
  }
  return slices;
}

function turnText(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) for (const b of m.blocks) if (b.type === 'text') parts.push(b.text);
  return parts.join('\n\n');
}

function makeTail(messages: ChatMessage[], tailChars: number): SkeletonTail {
  const text = turnText(messages);
  const overflow = text.length > tailChars;
  const hasNonText = messages.some((m) =>
    m.blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image'),
  );
  return { text: overflow ? text.slice(text.length - tailChars) : text, truncated: overflow || hasNonText };
}

export function buildHistorySnapshot(
  chain: ChatMessage[],
  opts?: { running?: boolean; tailChars?: number },
): ChatHistorySnapshot {
  const running = opts?.running ?? false;
  const tailChars = opts?.tailChars ?? DEFAULT_TAIL_CHARS;
  const slices = turnSlices(chain);

  let live: ChatMessage[] = [];
  const last = slices[slices.length - 1];
  if (running && last && last.kind === 'assistant') {
    live = last.messages;
    slices.pop();
  }

  const lastIdx = slices.length - 1;
  const items: ChatSkeletonItem[] = slices.map((s, i) => {
    if (s.kind === 'user') return { kind: 'user', message: s.message };
    if (i === lastIdx && !running) return { kind: 'assistant', turnId: s.turnId, tail: makeTail(s.messages, tailChars) };
    return { kind: 'assistant', turnId: s.turnId };
  });
  return { items, live };
}

export function getTurnSlice(chain: ChatMessage[], turnId: string): ChatMessage[] | null {
  const s = turnSlices(chain).find((x) => x.kind === 'assistant' && x.turnId === turnId);
  return s && s.kind === 'assistant' ? s.messages : null;
}
```

- [ ] **Step 4: 加 `collectToolResults` 到 `turns.ts`**

```ts
export function collectToolResults(messages: ChatMessage[]): Record<string, { content: string; isError?: boolean }> {
  const map: Record<string, { content: string; isError?: boolean }> = {};
  for (const m of messages)
    for (const b of m.blocks) if (b.type === 'tool_result') map[b.toolUseId] = { content: b.content, isError: b.isError };
  return map;
}
```

- [ ] **Step 5: `index.ts` 导出** — 追加 `export * from './skeleton';`

- [ ] **Step 6: 跑测试** Run: `npm test -w @rcc/shared` Expected: PASS。

- [ ] **Step 7: Commit** `feat(shared): 聊天历史骨架纯函数与协议类型(TDD)`

---

## Task 3: 服务端 ChatSession 发骨架 / 取正文

**Files:** Modify `chatSession.ts`、`chatSession.test.ts`

- [ ] **Step 1: 改 import 与事件类型**
  - 顶部 `import` 加:`buildHistorySnapshot, getTurnSlice`(值)与 `ChatHistorySnapshot`(类型),来自 `@rcc/shared`。
  - `ChatSessionEvents.onHistory` 改为 `(snapshot: ChatHistorySnapshot) => void`。

- [ ] **Step 2: 替换 `getMessages` 为 `getSkeleton`/`getTurnBody`**

```ts
  getSkeleton(): ChatHistorySnapshot {
    return buildHistorySnapshot(this.messages, { running: this.running });
  }
  getTurnBody(turnId: string): ChatMessage[] | null {
    return getTurnSlice(this.messages, turnId);
  }
```
(删除 `getMessages()`)

- [ ] **Step 3: 两处 `onHistory` 改发骨架**
  - `tick()` 链分叉分支:`this.events.onHistory(buildHistorySnapshot(chain, { running: this.running }));`
  - `rewindExecute()` 截断后:`this.events.onHistory(buildHistorySnapshot(this.messages, { running: this.running }));`

- [ ] **Step 4: 改 `chatSession.test.ts`** — 把断言 `onHistory` 收到数组的用例改为收到 `{ items, live }`;新增一例:发一轮后 `getSkeleton().items` 末项 assistant 带 tail、`getTurnBody(turnId)` 返回该回合消息。(按现有用例风格改写;fake tmux/transcript 已有。)

- [ ] **Step 5: 跑测试** Run: `npm test -w @rcc/server -- chatSession` Expected: PASS。

- [ ] **Step 6: Commit** `feat(server): ChatSession 下发历史骨架、按需取回合正文`

---

## Task 4: 服务端 Registry + 路由

**Files:** Modify `chatRegistry.ts`、`chatRegistry.test.ts`、`routes/chat.ts`

- [ ] **Step 1: `chatRegistry.ts` 接口与转发**
  - `import type { ChatHistorySnapshot } from '@rcc/shared'`。
  - `ChatSessionLike`:删 `getMessages`,加 `getSkeleton(): ChatHistorySnapshot` 与 `getTurnBody(turnId: string): ChatMessage[] | null`。
  - `ChatSubscriber.onHistory` 改 `(snapshot: ChatHistorySnapshot) => void`。
  - 工厂 `onHistory: (snap) => subscribers.forEach((s) => s.onHistory(snap))`。
  - `subscribe`:`sub.onHistory(e.session.getSkeleton())`。
  - `resync`:`sub.onHistory(e.session.getSkeleton())`。
  - `ChatHandle` 加 `loadTurn(turnId: string): ChatMessage[] | null`;返回处 `loadTurn: (turnId) => e.session.getTurnBody(turnId)`。

- [ ] **Step 2: `routes/chat.ts`**
  - `onHistory: (snap) => send({ type: 'history', items: snap.items, live: snap.live })`。
  - `socket.on('message')` switch 加:
```ts
          case 'load_turn': {
            const body = handle.loadTurn(msg.turnId);
            if (body) send({ type: 'turn_body', turnId: msg.turnId, messages: body });
            break;
          }
```

- [ ] **Step 3: 改 `chatRegistry.test.ts`** — fake session 的 `getMessages` 改 `getSkeleton`(返回 `{ items: [...], live: [] }`)、加 `getTurnBody`;断言订阅即收到骨架;加一例 `handle.loadTurn(id)` 透传。

- [ ] **Step 4: 跑测试** Run: `npm test -w @rcc/server` Expected: PASS。

- [ ] **Step 5: Commit** `feat(server): Registry 订阅发骨架、路由支持 load_turn/turn_body`

---

## Task 5: 前端客户端库

**Files:** Modify `apps/web/src/lib/chatWs.ts`

- [ ] **Step 1: 类型与回调**
  - `import type { ..., ChatHistorySnapshot } from '@rcc/shared'`。
  - `ChatHandlers.onHistory?: (snap: ChatHistorySnapshot) => void`;新增 `onTurnBody?: (turnId: string, messages: ChatMessage[]) => void`。

- [ ] **Step 2: 消息分发**
  - `case 'history': handlers.onHistory?.({ items: msg.items, live: msg.live }); break;`
  - 新增 `case 'turn_body': handlers.onTurnBody?.(msg.turnId, msg.messages); break;`

- [ ] **Step 3: typecheck web** Run: `npm run typecheck -w @rcc/web` Expected: 仅 `ChatView` 仍待改的报错。

- [ ] **Step 4: Commit** `feat(web): chatWs 客户端支持历史骨架与 turn_body`

---

## Task 6: 前端折叠渲染组件

**Files:** Create `CollapsedTurn.tsx`、`ChatHistory.tsx`

- [ ] **Step 1: `CollapsedTurn.tsx`**

```tsx
import type { SkeletonTail } from '@rcc/shared';
import { Markdown } from './markdown';

/** 折叠的旧 AI 回合:裸"展开"行;若为最后一轮则展示 tail 文本 + "展开全部"。 */
export function CollapsedTurn({
  turnId, tail, loading, onExpand,
}: { turnId: string; tail?: SkeletonTail; loading: boolean; onExpand: (id: string) => void }) {
  if (tail) {
    return (
      <div className="turn assistant-turn" id={`turn-${turnId}`}>
        <span className="assistant-marker" aria-hidden>⏺</span>
        <div className="assistant-body">
          <Markdown>{tail.text}</Markdown>
          {tail.truncated && (
            <button className="expand-turn" disabled={loading} onClick={() => onExpand(turnId)}>
              {loading ? '加载中…' : '展开全部'}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <button className="collapsed-turn" id={`turn-${turnId}`} disabled={loading} onClick={() => onExpand(turnId)}>
      <span className="assistant-marker" aria-hidden>⏺</span>
      <span>{loading ? '加载中…' : '展开 Claude 的回复'}</span>
    </button>
  );
}
```

- [ ] **Step 2: `ChatHistory.tsx`**

```tsx
import { groupTurns, collectToolResults, type ChatSkeletonItem, type AskPick } from '@rcc/shared';
import { UserTurn } from './UserTurn';
import { TurnList } from './TurnList';
import { CollapsedTurn } from './CollapsedTurn';
import type { AskStateMap } from './AssistantTurn';

/** 渲染历史骨架:用户气泡 / 折叠回合 / 已展开回合(完整 TurnList)。 */
export function ChatHistory({
  items, expanded, loading, onExpand, askStates, onAnswerAsk,
}: {
  items: ChatSkeletonItem[];
  expanded: Record<string, import('@rcc/shared').ChatMessage[]>;
  loading: Record<string, boolean>;
  onExpand: (id: string) => void;
  askStates?: AskStateMap;
  onAnswerAsk?: (toolUseId: string, picks: AskPick[]) => void;
}) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === 'user') return <UserTurn key={it.message.uuid} message={it.message} />;
        const body = expanded[it.turnId];
        if (body) {
          return (
            <div key={it.turnId} id={`turn-${it.turnId}`}>
              <TurnList turns={groupTurns(body)} toolResults={collectToolResults(body)} askStates={askStates} onAnswerAsk={onAnswerAsk} />
            </div>
          );
        }
        return <CollapsedTurn key={it.turnId} turnId={it.turnId} tail={it.tail} loading={!!loading[it.turnId]} onExpand={onExpand} />;
      })}
    </>
  );
}
```

- [ ] **Step 3: typecheck web** Run: `npm run typecheck -w @rcc/web` Expected: 仅 ChatView 报错。

- [ ] **Step 4: Commit** `feat(web): 折叠回合渲染组件 ChatHistory/CollapsedTurn`

---

## Task 7: ChatView 三态拆分与拼接

**Files:** Modify `ChatView.tsx`

- [ ] **Step 1: 状态**
  - 删 `const [messages, setMessages] = useState<ChatMessage[]>([])`,改 `const [live, setLive] = useState<ChatMessage[]>([])`。
  - 新增:`const [history, setHistory] = useState<ChatSkeletonItem[]>([])`;`const [expanded, setExpanded] = useState<Record<string, ChatMessage[]>>({})`;`const [loadingTurns, setLoadingTurns] = useState<Record<string, boolean>>({})`。
  - import 增补:`ChatSkeletonItem`、`ChatHistory`。

- [ ] **Step 2: 连接回调**
  - `onHistory: (snap) => { setHistory(snap.items); setLive(snap.live); setExpanded((prev) => { const ids = new Set(snap.items.filter((i) => i.kind === 'assistant').map((i) => (i as { turnId: string }).turnId)); const next: Record<string, ChatMessage[]> = {}; for (const k of Object.keys(prev)) if (ids.has(k)) next[k] = prev[k]; return next; }); }`
  - `onMessage`:把 `setMessages` 改 `setLive`(逻辑不变,含去重/乐观回显)。
  - 新增 `onTurnBody: (turnId, msgs) => { setExpanded((p) => ({ ...p, [turnId]: msgs })); setLoadingTurns((p) => ({ ...p, [turnId]: false })); }`。

- [ ] **Step 3: 派生与发送全部 `messages`→`live`**
  - `toolResults` useMemo、`turns`(groupTurns)、`hasPendingAsk`、清 livePending 的 effect、`sendText`/`sendImage` 的乐观插入,统统把 `messages`/`setMessages` 换成 `live`/`setLive`。
  - 新增展开处理:
```ts
  const handleExpand = (turnId: string) => {
    if (expanded[turnId] || loadingTurns[turnId]) return;
    setLoadingTurns((p) => ({ ...p, [turnId]: true }));
    sockRef.current?.send({ type: 'load_turn', turnId });
  };
```

- [ ] **Step 4: 滚动 effect** — 把依赖数组 `[messages, preview, running, livePending]` 改为 `[history, live, preview, running, livePending]`(`expanded` 不入依赖,故展开旧回合不触发置底;展开内容自然向下生长)。

- [ ] **Step 5: 渲染**
  - 空态条件:`turns.length === 0` → `history.length === 0 && live.length === 0`。
  - 在 `<TurnList .../>`(实时)之前插入历史:
```tsx
        <ChatHistory
          items={history}
          expanded={expanded}
          loading={loadingTurns}
          onExpand={handleExpand}
          askStates={askStates}
          onAnswerAsk={sendAskAnswer}
        />
```
  - 原 `<TurnList turns={turns} .../>` 保留(渲染 `live`)。

- [ ] **Step 6: typecheck + build web** Run: `npm run typecheck -w @rcc/web && npm run build -w @rcc/web` Expected: PASS。

- [ ] **Step 7: 折叠样式 `index.css`**

```css
.collapsed-turn { display:flex; align-items:center; gap:.5rem; width:100%; text-align:left;
  background:transparent; border:1px dashed var(--border,#3a3a3a); color:var(--muted,#9aa); 
  border-radius:.6rem; padding:.5rem .75rem; margin:.25rem 0; cursor:pointer; font:inherit; }
.collapsed-turn:hover:not(:disabled) { border-style:solid; color:var(--fg,#ddd); }
.collapsed-turn:disabled { opacity:.6; cursor:default; }
.expand-turn { margin-top:.4rem; background:transparent; border:1px solid var(--border,#3a3a3a);
  color:var(--muted,#9aa); border-radius:.5rem; padding:.2rem .6rem; cursor:pointer; font:inherit; }
.expand-turn:hover:not(:disabled){ color:var(--fg,#ddd); }
```
(变量名按 `index.css` 既有;不存在则用具体色值。)

- [ ] **Step 8: Commit** `feat(web): ChatView 历史骨架 + 折叠展开,流式与实时逻辑沿用`

---

## Task 8: 冒烟脚本适配 + 真实端到端

**Files:** Modify `apps/server/scripts/smoke-chat.ts`

- [ ] **Step 1: 适配 `onHistory`** — `onHistory` 回调签名改 `(snap)`;脚本里 `messages` 仍由 `onMessage` 累积即可,`onHistory` 用于重置时改为忽略或重渲(此脚本单会话单订阅,直接 `onHistory: () => {}` 即可,因消息全走 onMessage)。

- [ ] **Step 2: 补断言**(`session.dispose()` 之前)

```ts
  const snap = session.getSkeleton();
  const lastAssistant = [...snap.items].reverse().find((i) => i.kind === 'assistant');
  const turnId = lastAssistant && lastAssistant.kind === 'assistant' ? lastAssistant.turnId : null;
  const body = turnId ? session.getTurnBody(turnId) : null;
  console.log('骨架项数:', snap.items.length, '| 末助手 tail 截断:', lastAssistant?.kind === 'assistant' ? lastAssistant.tail?.truncated : 'n/a');
  console.log('取正文 turnId:', turnId, '| 正文消息数:', body?.length ?? 0);
  const skeletonOk = snap.items.length >= 1 && turnId !== null && (body?.length ?? 0) >= 1;
```
  并入最终 `ok`:`... && skeletonOk`。

- [ ] **Step 3: 真实冒烟** Run: `npx tsx apps/server/scripts/smoke-chat.ts` Expected: `✅ 通过`,且打印骨架项数、取正文消息数 ≥ 1。

- [ ] **Step 4: Commit** `test(server): 冒烟覆盖历史骨架与按需取正文`

---

## Task 9: 全量验证

- [ ] `npm run typecheck` 全绿。
- [ ] `npm test` 全绿。
- [ ] `npm run build` 全绿。
- [ ] `git log --oneline` 复核小步提交。

---

## Self-Review 记录

- **Spec 覆盖**:省流量(骨架)→T1–T4;按需取正文 → T3/T4/T6/T7;tail 最后一屏 → T2/T6;运行中剥离 → T2;重连保留展开 → T7 Step2;手动展开 → T6/T7;测试 → T2/T3/T4/T8。无遗漏。
- **类型一致**:`getSkeleton`/`getTurnBody`/`loadTurn`/`onTurnBody`/`ChatHistorySnapshot{items,live}`/`ChatSkeletonItem`/`SkeletonTail{text,truncated}` 跨任务一致。
- **占位扫描**:无 TODO/TBD;每个改动给出具体代码或精确字段。
