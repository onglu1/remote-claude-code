# 聊天增强（Effort 切换 + 全结构化 Rewind）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 或 subagent-driven-development 按任务逐条实现；步骤用 `- [ ]` 勾选跟踪。

**Goal:** 给原生聊天视图加两件事——可切换且持久化的 effort（默认 max），以及结构化、防误触的 rewind（刮屏+模拟按键闭环驱动原生 `/rewind`）。

**Architecture:** 纯增量。Effort 走「会话级持久化 + 启动 `--effort` + 运行中 `/effort` 即时」。Rewind 因 `/rewind` 仅交互式，用纯函数刮屏器 `rewindScraper` + 闭环控制器 `RewindController` 驱动原生 TUI；并把 transcript 渲染改为「按 parentUuid 回溯活动分支」以正确处理 rewind 产生的分叉树。

**Tech Stack:** TS / Fastify / ws / zod（server）；React+Vite（web）；vitest（测源共置）；tmux + 原生 claude。

**前置事实**：见 `docs/superpowers/specs/2026-06-20-chat-effort-and-rewind-design.md` §3.2、§5（已含真实 spike 抓屏布局与 transcript 树模型）。

---

## 文件结构地图

**Part A — Effort**
- Modify `packages/shared/src/schemas.ts`：`EffortLevelSchema` + `Conversation.effort`。
- Modify `packages/shared/src/chatWs.ts`：客户端 `set_effort`；服务端 `effort`。
- Modify `apps/server/src/lib/conversations.ts`：`update()` + `create()` 写 `effort`。
- Create `apps/server/src/lib/session/effort.ts`：`effortFlag()` 纯函数。
- Modify `apps/server/src/lib/session/chat/chatSession.ts`：`ChatSpec.effort`、`ensure()` 拼 flag、`setEffort()`。
- Modify `apps/server/src/routes/sessions.ts`：终端启动拼 `effortFlag`。
- Modify `apps/server/src/routes/chat.ts`：装配 `spec.effort`、首连下发 `effort`、处理 `set_effort`。
- Modify `apps/server/src/lib/session/chat/chatRegistry.ts`：`ChatSessionLike`/`ChatHandle` 加 `setEffort`。
- Modify `apps/web/src/lib/chatWs.ts` + `apps/web/src/components/chat/ChatView.tsx`：effort 药丸 UI。

**Part B — transcript 活动分支**
- Modify `apps/server/src/lib/session/chat/transcript.ts`：`parseEntry()`、`TranscriptTail` 改 `activeChain()`/`reset()`。
- Modify `apps/server/src/lib/session/chat/chatSession.ts`：`TranscriptLike` 接口 + `tick()` 改 activeChain 差分 + `ensure()`。
- Modify `apps/server/src/lib/session/chat/chatRegistry.ts`：`ChatSessionEvents.onHistory` 转发。
- Modify `apps/server/scripts/smoke-chat.ts`：events 补 `onHistory` 空实现。

**Part C — Rewind**
- Create `apps/server/src/lib/session/chat/rewindScraper.ts`：纯函数解析 picker。
- Create `apps/server/src/lib/session/chat/rewind.ts`：`RewindController` 闭环状态机。
- Modify `apps/server/src/lib/session/chat/chatSession.ts`：`rewindActive` + `rewindOpen/Execute/Cancel` + 即时截断 history + `tick` 跳过。
- Modify `packages/shared/src/chatWs.ts`：`RewindMode`/`RewindItem` + 三个客户端消息 + 两个服务端消息。
- Modify `apps/server/src/lib/session/chat/chatRegistry.ts` + `routes/chat.ts`：转发与接线。
- Create `apps/web/src/components/chat/RewindPanel.tsx` + Modify `ChatView.tsx`/`chatWs.ts`：UI。
- Modify `apps/web/src/styles`（沿用现有 css 文件）：弹层样式。

---

## Part A — Effort 切换

### Task A1：shared schema + WS 协议

**Files:** Modify `packages/shared/src/schemas.ts`、`packages/shared/src/chatWs.ts`；Test `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: 失败测试**（schemas.test.ts 追加）
```ts
import { EffortLevelSchema, ConversationSchema } from './schemas';
it('effort 默认 max、枚举校验', () => {
  expect(EffortLevelSchema.parse('max')).toBe('max');
  expect(() => EffortLevelSchema.parse('ultra')).toThrow();
  const c = ConversationSchema.parse({
    id: 'a', projectId: 'p', name: 'n', tmuxName: 't', sessionId: 's', alive: false, createdAt: '2026-01-01',
  });
  expect(c.effort).toBe('max');
});
```
- [ ] **Step 2: 跑测试确认失败** `npm test -w @rcc/shared`，预期 `EffortLevelSchema` 未导出。
- [ ] **Step 3: 实现** schemas.ts：
```ts
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
// ConversationSchema 内新增字段：
  effort: EffortLevelSchema.default('max'),
```
chatWs.ts：`import { EffortLevelSchema } from './schemas'`；`ChatClientSchema` 并集追加
`z.object({ type: z.literal('set_effort'), level: EffortLevelSchema })`；
`ChatServerMessage` 追加 `| { type: 'effort'; level: EffortLevel }`（并 `import type { EffortLevel }`）。
- [ ] **Step 4: 跑测试确认通过** `npm test -w @rcc/shared`。
- [ ] **Step 5: 提交** `git commit -m "feat(shared): effort 级别 schema + 会话 effort 字段 + set_effort/effort 协议"`

### Task A2：ConversationStore.update + create 写 effort

**Files:** Modify `apps/server/src/lib/conversations.ts`；Test `apps/server/src/lib/conversations.test.ts`（若无则建）

- [ ] **Step 1: 失败测试**
```ts
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
it('update 改 effort 并持久化', () => {
  const f = join(mkdtempSync(join(tmpdir(),'cv-')), 'c.json');
  const s = new ConversationStore(f);
  const c = s.create('p', '会话');
  expect(c.effort).toBe('max');
  const u = s.update(c.id, { effort: 'high' });
  expect(u?.effort).toBe('high');
  expect(s.get(c.id)?.effort).toBe('high');
});
```
- [ ] **Step 2: 跑测试确认失败**（`update` 不存在 / `create` 无 effort）。
- [ ] **Step 3: 实现** conversations.ts：`create()` 的 `conv` 字面量加 `effort: 'max'`；新增：
```ts
update(convId: string, patch: Partial<StoredConversation>): StoredConversation | undefined {
  const all = this.loadAll();
  const i = all.findIndex((c) => c.id === convId);
  if (i === -1) return undefined;
  all[i] = { ...all[i], ...patch, id: all[i].id };
  this.write(all);
  return all[i];
}
```
（`loadAll` 防御补全处可顺手 `effort: c.effort ?? 'max'`，确保旧记录读出即有值。）
- [ ] **Step 4: 跑测试确认通过** `npm test -w @rcc/server`。
- [ ] **Step 5: 提交** `git commit -m "feat(server): 会话存储 update() + 新会话默认 effort=max"`

### Task A3：effortFlag 纯函数

**Files:** Create `apps/server/src/lib/session/effort.ts`；Test `apps/server/src/lib/session/effort.test.ts`

- [ ] **Step 1: 失败测试**
```ts
import { describe, it, expect } from 'vitest';
import { effortFlag } from './effort';
describe('effortFlag', () => {
  it('给级别拼 --effort', () => expect(effortFlag('xhigh')).toBe('--effort xhigh'));
  it('空值默认 max', () => expect(effortFlag(undefined)).toBe('--effort max'));
});
```
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
```ts
import type { EffortLevel } from '@rcc/shared';
/** 启动/重启 claude 用的 effort 标志；空值回落 max（聊天默认）。 */
export function effortFlag(level?: EffortLevel | null): string {
  return `--effort ${level ?? 'max'}`;
}
```
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** `git commit -m "feat(server): effortFlag 纯函数（默认 max）"`

### Task A4：ChatSpec.effort + ensure 拼 flag + setEffort

**Files:** Modify `apps/server/src/lib/session/chat/chatSession.ts`；Test `apps/server/src/lib/session/chat/chatSession.test.ts`

- [ ] **Step 1: 失败测试**（追加；沿用该文件既有 fake tmux 风格）
```ts
it('ensure：命令含 --effort（在 idFlag 之前）', async () => {
  const { tmux, session } = makeSession({ effort: 'high', hasTranscript: false });
  await session.ensure();
  expect(tmux.calls.newDetached[0][2]).toBe('Fable-yolo --effort high --session-id u-123');
});
it('setEffort：发 /effort，不翻转 running', async () => {
  const { tmux, session } = makeSession({});
  await session.setEffort('max');
  expect(tmux.calls.pasteText.at(-1)?.[1]).toBe('/effort max');
  expect(session.isRunning()).toBe(false);
});
```
（`makeSession` 为本任务在测试内补的小工厂：按现有 `chatSession.test.ts` 既有 fake 拼装，传入 `effort`/`hasTranscript`。）
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** chatSession.ts：
  - `ChatSpec` 加 `effort?: EffortLevel;`（`import type { EffortLevel } from '@rcc/shared'`）。
  - `ensure()` 内命令拼装改为：
```ts
import { effortFlag } from '../effort';
// ...
`${this.spec.launchCommand} ${effortFlag(this.spec.effort)} ${idFlag}`,
```
  - 新增方法：
```ts
/** 运行中即时切 effort：原生 /effort 非交互命令，不触发"思考中"。 */
async setEffort(level: EffortLevel): Promise<void> {
  await this.deps.tmux.pasteText(this.spec.tmuxName, `/effort ${level}`);
  await this.deps.tmux.sendKeys(this.spec.tmuxName, ['Enter']);
}
```
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** `git commit -m "feat(server): 聊天会话启动带 --effort + 运行中 setEffort(/effort)"`

### Task A5：终端启动也吃 effort

**Files:** Modify `apps/server/src/routes/sessions.ts`

- [ ] **Step 1: 实现**（无独立单测，靠 typecheck + Part 末冒烟）：`command` 拼装改为
```ts
import { effortFlag } from '../lib/session/effort';
const command = `${project.launchCommand} ${effortFlag(conv.effort)} ${launchFlag(conv.sessionId)}`;
```
- [ ] **Step 2: typecheck** `npm run typecheck`，预期通过。
- [ ] **Step 3: 提交** `git commit -m "feat(server): 终端视图启动同样应用会话 effort"`

### Task A6：chat 路由接线 + 注册表转发

**Files:** Modify `apps/server/src/lib/session/chat/chatRegistry.ts`、`apps/server/src/routes/chat.ts`；Test `chatRegistry.test.ts`

- [ ] **Step 1: 失败测试**（chatRegistry.test.ts 追加）：fake 会话加 `setEffort` spy，断言 `handle.setEffort('high')` 透传到会话。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
  - chatRegistry.ts：`ChatSessionLike` 加 `setEffort(level: EffortLevel): Promise<void>;`；`ChatHandle` 加同款；`subscribe` 返回的 handle 加 `setEffort: (l) => e.session.setEffort(l)`。
  - chat.ts：
    - `spec` 字面量加 `effort: conv.effort`。
    - `.then((h) => { handle = h; send({type:'session',...}); send({ type: 'effort', level: conv.effort ?? 'max' }); })`。
    - message switch 加：
```ts
case 'set_effort':
  ctx.conversations.update(cid, { effort: msg.level });
  void handle.setEffort(msg.level);
  send({ type: 'effort', level: msg.level });
  break;
```
- [ ] **Step 4: 跑测试确认通过** + `npm run typecheck`。
- [ ] **Step 5: 提交** `git commit -m "feat(server): chat 路由下发/切换 effort，注册表转发 setEffort"`

### Task A7：web effort 药丸

**Files:** Modify `apps/web/src/lib/chatWs.ts`、`apps/web/src/components/chat/ChatView.tsx`；可选 Create `apps/web/src/components/chat/EffortPill.tsx`

- [ ] **Step 1: 实现 chatWs.ts**：`ChatHandlers` 加 `onEffort?: (level: EffortLevel) => void`（import 类型）；switch 加 `case 'effort': handlers.onEffort?.(msg.level); break;`
- [ ] **Step 2: 实现 EffortPill.tsx**（小受控菜单；复用 `.slash-palette`/`.keycap` 现有类即可，不新造大样式）：
```tsx
import type { EffortLevel } from '@rcc/shared';
const LEVELS: EffortLevel[] = ['low','medium','high','xhigh','max','auto'];
export function EffortPill({ level, onPick }: { level: EffortLevel; onPick: (l: EffortLevel)=>void }) {
  const [open,setOpen]=useState(false);
  return (
    <div className="effort-pill">
      <button className="btn ghost sm" onClick={()=>setOpen(o=>!o)} title="思考强度">⚙ {level} ▾</button>
      {open && (
        <div className="effort-menu">
          {LEVELS.map(l=>(
            <button key={l} className={`effort-item${l===level?' on':''}`}
              onClick={()=>{ onPick(l); setOpen(false); }}>{l}</button>
          ))}
        </div>
      )}
    </div>
  );
}
```
- [ ] **Step 3: 接进 ChatView**：新增 `const [effort,setEffort]=useState<EffortLevel>('max')`；连接 handlers 加 `onEffort:(l)=>setEffort(l)`；topbar 在「停止/终端」附近放 `<EffortPill level={effort} onPick={(l)=>{ setEffort(l); sockRef.current?.send({type:'set_effort',level:l}); }} />`。
- [ ] **Step 4: 构建校验** `npm run build`，预期通过。
- [ ] **Step 5: 提交** `git commit -m "feat(web): 聊天顶栏 effort 药丸（切换+回显）"`

### Task A8：Effort 真实冒烟

- [ ] **Step 1**：`./start.sh --no-build` 起服务；手机/浏览器进一个聊天会话，切 effort 到 `high`，发一句话；`tmux -L rcc capture-pane` 确认状态栏 effort 指示从 max 变 high（`◉ high · /effort`）。
- [ ] **Step 2**：杀掉该 tmux 会话后重连（触发 `--resume` 启动），确认重启后仍以持久化的 `high` 启动（看状态栏）。
- [ ] **Step 3**：通过则继续；不通过按 systematic-debugging 排查。

---

## Part B — transcript 活动分支重渲

### Task B1：parseEntry + TranscriptTail.activeChain

**Files:** Modify `apps/server/src/lib/session/chat/transcript.ts`；Test `apps/server/src/lib/session/chat/transcript.test.ts`

- [ ] **Step 1: 失败测试**（覆盖线性 / 分叉树 / 重连）
```ts
// 线性：两轮，activeChain 给 4 条（u,a,u,a 中可渲染的）
// 分叉：构造 spike 实测的 19 行树（line 5-13 老分支 + line 15-18 新分支），
//      断言 activeChain 只含「branch-test」一对，不含「Create a file」。
it('activeChain 只取活动分支（rewind 分叉后）', () => {
  const lines = [
    json('attachment','ca94ae6e', null),
    json('attachment','83967d6a','ca94ae6e'),
    userMsg('7a67884f','83967d6a','Create a file'),
    asstMsg('69d95fb0','7a67884f','I will create'),
    sysMsg('efcc9940','69d95fb0'),
    userMsg('d162a032','83967d6a','branch-test'),   // 分叉：parent 指回 83967d6a
    asstMsg('4467046e','d162a032','branch-test'),
    sysMsg('22a74313','4467046e'),
  ].join('\n') + '\n';
  const tail = makeTailFromString(lines);
  const chain = tail.activeChain();
  expect(chain.map(m=>m.role)).toEqual(['user','assistant']);
  expect(JSON.stringify(chain)).toContain('branch-test');
  expect(JSON.stringify(chain)).not.toContain('Create a file');
});
```
（`json/userMsg/asstMsg/sysMsg/makeTailFromString` 为测试内小助手；`makeTailFromString` 用一个返回固定路径的 fake 或临时文件喂 `TranscriptTail`。沿用 transcript.test.ts 既有读法。）
- [ ] **Step 2: 跑测试确认失败**（`activeChain` 不存在）。
- [ ] **Step 3: 实现** transcript.ts：
  - 抽出渲染逻辑 `renderMessage(o)`（即现 `parseTranscriptLine` 主体，去掉 uuid 兜底）。
  - 新增：
```ts
export interface TranscriptEntry { uuid: string; parentUuid: string | null; msg: ChatMessage | null; }
export function parseEntry(line: string): TranscriptEntry | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o.uuid !== 'string') return null;
  return {
    uuid: o.uuid,
    parentUuid: typeof o.parentUuid === 'string' ? o.parentUuid : null,
    msg: renderMessage(o),
  };
}
// 兼容旧导出（现有测试用）
export function parseTranscriptLine(line: string): ChatMessage | null {
  return parseEntry(line)?.msg ?? null;
}
```
  - `TranscriptTail` 重写为 map+order（保留 `readFrom` 不变）：
```ts
export class TranscriptTail {
  private offset = 0; private pending = '';
  private order: string[] = [];
  private byUuid = new Map<string, TranscriptEntry>();
  constructor(private readonly getPath: () => string | null) {}

  private ingest(): void {
    const { text, end } = this.readFrom(this.offset);
    this.offset = end;
    if (!text) return;
    this.pending += text;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const line of parts) {
      const e = parseEntry(line);
      if (!e) continue;
      if (!this.byUuid.has(e.uuid)) this.order.push(e.uuid);
      this.byUuid.set(e.uuid, e);
    }
  }
  /** 活动分支：从最后一个节点沿 parentUuid 回溯，正序可渲染消息。 */
  activeChain(): ChatMessage[] {
    this.ingest();
    const out: ChatMessage[] = [];
    const seen = new Set<string>();
    let cur: string | null = this.order.at(-1) ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.byUuid.get(cur);
      if (!e) break;
      if (e.msg) out.push(e.msg);
      cur = e.parentUuid;
    }
    return out.reverse();
  }
  /** 重连/全量重读。 */
  reset(): void { this.offset = 0; this.pending = ''; this.order = []; this.byUuid.clear(); }
  // readFrom：保持不变
}
```
  - 删除旧 `readAll()`/`poll()`/`consume()`。
- [ ] **Step 4: 跑测试确认通过**（含原有 parseTranscriptLine 测试仍绿）。
- [ ] **Step 5: 提交** `git commit -m "feat(server): transcript 改 parentUuid 活动分支重建（修复 rewind 分叉显示）"`

### Task B2：ChatSession 用 activeChain 差分

**Files:** Modify `apps/server/src/lib/session/chat/chatSession.ts`、`chatRegistry.ts`、`scripts/smoke-chat.ts`；Test `chatSession.test.ts`

- [ ] **Step 1: 失败测试**：fake `TranscriptLike` 改为可返回 `activeChain()`；断言：
  - 追加扩展 → 对新增尾部逐条 `onMessage`；
  - 分叉（链头变、非前缀）→ 触发 `onHistory(chain)`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
  - chatSession.ts：`TranscriptLike` 接口改为 `{ activeChain(): ChatMessage[]; reset(): void }`。
  - `ChatSessionEvents` 加 `onHistory: (messages: ChatMessage[]) => void;`。
  - `ensure()`：`this.messages = this.deps.tail.activeChain();`
  - `tick()` 顶部 transcript 段替换为：
```ts
const chain = this.deps.tail.activeChain();
const prev = this.messages.map((m) => m.uuid);
const cur = chain.map((m) => m.uuid);
const isPrefix = prev.length <= cur.length && prev.every((u, i) => u === cur[i]);
if (prev.length === cur.length && isPrefix) {
  // 无变化
} else if (isPrefix) {
  const added = chain.slice(prev.length);
  this.messages = chain;
  for (const m of added) this.events.onMessage(m);
} else {
  this.messages = chain;
  this.events.onHistory(chain);
}
```
  - chatRegistry.ts：`factory` 的 events 加 `onHistory: (msgs) => subscribers.forEach((s) => s.onHistory(msgs))`。
  - smoke-chat.ts：events 字面量加 `onHistory: () => {},`。
- [ ] **Step 4: 跑测试确认通过** + `npm run typecheck`。
- [ ] **Step 5: 提交** `git commit -m "feat(server): 会话改用 activeChain 差分（追加增量/分叉整屏）"`

### Task B3：transcript 真实冒烟

- [ ] **Step 1**：跑 `npx tsx apps/server/scripts/smoke-chat.ts`，预期仍 ✅（线性对话不回归）。
- [ ] **Step 2**：通过则继续。

---

## Part C — 全结构化 Rewind

### Task C1：rewindScraper（纯函数，内联 spike fixture）

**Files:** Create `apps/server/src/lib/session/chat/rewindScraper.ts`；Test `rewindScraper.test.ts`

> Fixture 文本取自真实 spike（见 spec §3.2）。测试内以多行字符串内联。

- [ ] **Step 1: 失败测试**（关键用例）
```ts
import { describe, it, expect } from 'vitest';
import { parseRewindPicker } from './rewindScraper';

const LIST_CUR = [   // 光标在 (current)
'  Rewind','',
'  Restore the code and/or conversation to the point before…','',
'    Create a file named note.txt containing the single word hello, then reply exactly: done',
'    note.txt +2','',
'  ❯ (current)','','','',
'  Enter to continue · Esc to cancel',
].join('\n');

const LIST_SEL = [   // 光标在 checkpoint 行
'  Rewind','',
'  Restore the code and/or conversation to the point before…','',
'  ❯ Create a file named note.txt containing the single word hello, then reply exactly: done',
'    note.txt +2','',
'    (current)','','','',
'  Enter to continue · Esc to cancel',
].join('\n');

const MODE = [
'  Rewind','',
'  Confirm you want to restore to the point before you sent this message:','',
'  │ Create a file named note.txt …','  │ (47s ago)','',
'  The conversation will be forked.','  The code will be restored -1 in note.txt.','',
'  ❯ 1. Restore code and conversation','    2. Restore conversation','    3. Restore code',
'    4. Summarize from here','  ↓ 5. Summarize up to here','',
'  ⚠ Rewinding does not affect files edited manually or via bash.',
].join('\n');

it('列表：解析出 1 个 checkpoint，光标在 current', () => {
  const s = parseRewindPicker(LIST_CUR);
  expect(s.open).toBe(true); expect(s.stage).toBe('list');
  expect(s.items.length).toBe(1);
  expect(s.items[0].label).toContain('Create a file');
  expect(s.items[0].changes).toBe('note.txt +2');
  expect(s.cursor).toBe(1); // == items.length → (current)
});
it('列表：光标在 checkpoint 行', () => {
  expect(parseRewindPicker(LIST_SEL).cursor).toBe(0);
});
it('模式：解析编号选项，光标在 1，含代码影响文案', () => {
  const s = parseRewindPicker(MODE);
  expect(s.stage).toBe('mode');
  expect(s.modeCursor).toBe(1);
  expect(s.codeEffect).toContain('restored -1');
});
it('非 picker 屏：open=false', () => {
  expect(parseRewindPicker('❯ \n  ⏵⏵ bypass permissions on').open).toBe(false);
});
```
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 rewindScraper.ts**（要点：以「改动行」为锚定，光标 `❯`）
```ts
export type RewindMode = 'both' | 'conversation' | 'code';
export interface RewindItem { index: number; label: string; changes: string; }
export interface RewindPickerState {
  open: boolean;
  stage: 'list' | 'mode' | 'none';
  items: RewindItem[];
  cursor: number;        // list：0..items.length（==items.length 表示 (current)）
  modeCursor: number;    // mode：原生编号 1..5（0 表示未知）
  codeEffect?: string;   // mode：代码影响文案
}
const CHANGES = /(^|\s)No code changes\s*$|[+\-]\d+/;
const CURSOR = /❯/;
const MODE_LINE = /^\s*[❯↓ ]?\s*(\d+)\.\s+(.+?)\s*$/;

export function parseRewindPicker(pane: string): RewindPickerState {
  const lines = pane.replace(/\r/g, '').split('\n');
  const isList = lines.some((l) => /Restore the code and\/or conversation/.test(l));
  const isMode = lines.some((l) => /Confirm you want to restore/.test(l));
  if (!isList && !isMode) return { open: false, stage: 'none', items: [], cursor: 0, modeCursor: 0 };
  if (isMode) return parseMode(lines);
  return parseList(lines);
}
```
  - `parseList`：取 subtitle 之后、footer(`Enter to continue`) 之前的区域；逐非空行，用「buffer 累积 label 行，遇 CHANGES 行收一条 item」；遇含 `(current)` 的行标记 current 行。cursor：记录 `❯` 落在第几个 item 的 label 行（buffer 中含 `❯` 即该 item）或 current 行（cursor=items.length）。label 去掉前导 `❯ `/空格后 join。
  - `parseMode`：扫 `MODE_LINE`，含 `❯` 的取其编号为 `modeCursor`；`codeEffect` = 含 `The code will be` 的行 trim。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** `git commit -m "feat(server): rewind picker 刮屏器（纯函数，spike fixture 单测）"`

### Task C2：RewindController（闭环状态机，fake 单测）

**Files:** Create `apps/server/src/lib/session/chat/rewind.ts`；Test `rewind.test.ts`

- [ ] **Step 1: 失败测试**（fake tmux：按 sendKeys 推进内部「光标」，`capturePaneVisible` 返回对应 picker 文本）
  - `execute(0,'conversation')`：断言发了「Up 到 item0 → Enter → Down 到编号2 → Enter」且返回 `{ok:true}`。
  - 「光标卡住」：fake 让 cursor 不动 → 返回 `{ok:false}` 且调用过 `Escape`（中止退出）。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 rewind.ts**（闭环：每步重抓校验；双校验后才发执行 Enter）
```ts
import { parseRewindPicker, type RewindItem, type RewindMode } from './rewindScraper';
export interface RewindTmux {
  sendKeys(name: string, keys: string[]): Promise<void>;
  pasteText(name: string, text: string): Promise<void>;
  capturePaneVisible(name: string): Promise<string>;
}
export interface RewindResult { ok: boolean; error?: string; }
const MODE_OPTION: Record<RewindMode, number> = { both: 1, conversation: 2, code: 3 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RewindController {
  constructor(
    private readonly name: string,
    private readonly tmux: RewindTmux,
    private readonly opts: { settleMs?: number; maxSteps?: number; openTries?: number } = {},
  ) {}
  private settle() { return sleep(this.opts.settleMs ?? 300); }
  private async snap() { return parseRewindPicker(await this.tmux.capturePaneVisible(this.name)); }

  async open(): Promise<{ items: RewindItem[] }> {
    await this.tmux.sendKeys(this.name, ['C-u']);
    await this.tmux.pasteText(this.name, '/rewind');
    await this.tmux.sendKeys(this.name, ['Enter']);
    for (let i = 0; i < (this.opts.openTries ?? 20); i++) {
      await this.settle();
      const s = await this.snap();
      if (s.open && s.stage === 'list') return { items: s.items };
    }
    throw new Error('rewind picker 未能打开');
  }

  async execute(index: number, mode: RewindMode): Promise<RewindResult> {
    let s = await this.snap();
    if (!(s.open && s.stage === 'list')) return this.abort('not-in-list');
    let guard = this.opts.maxSteps ?? 40;
    while (s.cursor !== index && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.cursor > index ? 'Up' : 'Down']);
      await this.settle();
      const before = s.cursor; s = await this.snap();
      if (s.stage !== 'list') return this.abort('list-stage-lost');
      if (s.cursor === before) return this.abort('list-cursor-stuck');
    }
    if (s.cursor !== index) return this.abort('list-unreachable');
    await this.tmux.sendKeys(this.name, ['Enter']); await this.settle();
    s = await this.snap();
    if (s.stage !== 'mode') return this.abort('mode-not-shown');
    const target = MODE_OPTION[mode];
    guard = this.opts.maxSteps ?? 40;
    while (s.modeCursor !== target && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.modeCursor > target ? 'Up' : 'Down']);
      await this.settle();
      const before = s.modeCursor; s = await this.snap();
      if (s.stage !== 'mode') return this.abort('mode-stage-lost');
      if (s.modeCursor === before) return this.abort('mode-cursor-stuck');
    }
    if (s.modeCursor !== target) return this.abort('mode-unreachable');
    await this.tmux.sendKeys(this.name, ['Enter']); // 双校验通过 → 执行
    await this.settle();
    return { ok: true };
  }

  async cancel(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await this.tmux.sendKeys(this.name, ['Escape']);
      await this.settle();
      if (!(await this.snap()).open) return;
    }
  }
  private async abort(error: string): Promise<RewindResult> {
    await this.cancel();
    return { ok: false, error };
  }
}
```
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 提交** `git commit -m "feat(server): RewindController 闭环驱动原生 picker（不确定即中止+Esc）"`

### Task C3：ChatSession 接入 rewind（隔离 + 即时截断）

**Files:** Modify `apps/server/src/lib/session/chat/chatSession.ts`；Test `chatSession.test.ts`

- [ ] **Step 1: 失败测试**
  - `rewindActive` 期间 `tick()` 不发 preview/onMessage（注入 fake 控制器，`rewindOpen` 后 tick 静默）。
  - `rewindExecute(0,'conversation')` 成功后：`messages` 截到第 0 条用户消息之前，并广播 `onHistory`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现** chatSession.ts：
  - `ChatSessionDeps` 加可选 `makeRewind?: (name: string, tmux: TmuxLike) => RewindLike;`，默认 `new RewindController(name, tmux)`。其中 `RewindLike = { open(): Promise<{items:RewindItem[]}>; execute(i,mode): Promise<RewindResult>; cancel(): Promise<void> }`。
  - 字段 `private rewindActive = false; private rewind?: RewindLike;` + `private ensureRewind()` 懒构造。
  - `tick()` 顶部：`if (this.rewindActive) return;`
  - 方法：
```ts
async rewindOpen(): Promise<RewindItem[]> {
  this.rewindActive = true;
  try { return (await this.ensureRewind().open()).items; }
  catch (e) { this.rewindActive = false; throw e; }
}
async rewindExecute(index: number, mode: RewindMode): Promise<RewindResult> {
  let r: RewindResult;
  try { r = await this.ensureRewind().execute(index, mode); }
  finally { this.rewindActive = false; }
  if (r.ok) {
    // 即时整屏：截到所选 checkpoint（第 index 条用户文本消息）之前
    const userTextIdx = this.messages
      .map((m, i) => ({ m, i }))
      .filter((x) => x.m.role === 'user' && x.m.blocks.some((b) => b.type === 'text'))
      .map((x) => x.i);
    const cut = userTextIdx[index];
    if (cut !== undefined) {
      this.messages = this.messages.slice(0, cut);
      this.events.onHistory(this.messages);
    }
  }
  return r;
}
async rewindCancel(): Promise<void> {
  try { await this.ensureRewind().cancel(); } finally { this.rewindActive = false; }
}
```
- [ ] **Step 4: 跑测试确认通过** + `npm run typecheck`。
- [ ] **Step 5: 提交** `git commit -m "feat(server): 会话接入 rewind（轮询隔离 + 执行后即时截断重渲）"`

### Task C4：shared 协议 + 注册表 + 路由接线

**Files:** Modify `packages/shared/src/chatWs.ts`、`apps/server/src/lib/session/chat/chatRegistry.ts`、`apps/server/src/routes/chat.ts`；Test `chatWs.test.ts`、`chatRegistry.test.ts`

- [ ] **Step 1: 失败测试**：chatWs.test.ts 断言 `decodeChatClient` 接受 `rewind_execute`（index/mode）；chatRegistry.test.ts 断言 handle 转发 `rewindOpen/Execute/Cancel`。
- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**
  - chatWs.ts：`export const RewindModeSchema = z.enum(['both','conversation','code']);`；`export interface RewindItem { index: number; label: string; changes: string; }`。`ChatClientSchema` 追加：
```ts
z.object({ type: z.literal('rewind_open') }),
z.object({ type: z.literal('rewind_execute'), index: z.number().int().nonnegative(), mode: RewindModeSchema }),
z.object({ type: z.literal('rewind_cancel') }),
```
  `ChatServerMessage` 追加 `| { type:'rewind_list'; items: RewindItem[] } | { type:'rewind_done'; mode: RewindMode; ok: boolean }`。
  - chatRegistry.ts：`ChatSessionLike`/`ChatHandle` 加 `rewindOpen(): Promise<RewindItem[]>; rewindExecute(i:number,mode:RewindMode): Promise<{ok:boolean;error?:string}>; rewindCancel(): Promise<void>;`，handle 透传。
  - chat.ts message switch 追加：
```ts
case 'rewind_open':
  void handle.rewindOpen()
    .then((items) => send({ type: 'rewind_list', items }))
    .catch((e) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
  break;
case 'rewind_execute':
  void handle.rewindExecute(msg.index, msg.mode)
    .then((r) => send({ type: 'rewind_done', mode: msg.mode, ok: r.ok }))
    .catch((e) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
  break;
case 'rewind_cancel':
  void handle.rewindCancel();
  break;
```
- [ ] **Step 4: 跑测试确认通过** + `npm run typecheck`。
- [ ] **Step 5: 提交** `git commit -m "feat(server): rewind WS 协议 + 注册表/路由接线"`

### Task C5：web RewindPanel + 二次确认

**Files:** Create `apps/web/src/components/chat/RewindPanel.tsx`；Modify `apps/web/src/lib/chatWs.ts`、`apps/web/src/components/chat/ChatView.tsx`、样式文件

- [ ] **Step 1: chatWs.ts**：`ChatHandlers` 加 `onRewindList?: (items: RewindItem[]) => void; onRewindDone?: (mode: RewindMode, ok: boolean) => void;`；switch 加对应 case。
- [ ] **Step 2: RewindPanel.tsx**（移动端底部弹层；三态：列表 → 选模式 → 二次确认）
```tsx
import { useState } from 'react';
import type { RewindItem, RewindMode } from '@rcc/shared';
const MODE_CN: Record<RewindMode,string> = { both:'恢复代码+对话', conversation:'仅对话', code:'仅代码' };
export function RewindPanel({ items, busy, onExecute, onClose }:{
  items: RewindItem[]; busy: boolean;
  onExecute: (index: number, mode: RewindMode) => void; onClose: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [mode, setMode] = useState<RewindMode | null>(null);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e)=>e.stopPropagation()}>
        <div className="sheet-title">回退到某个检查点</div>
        {items.length === 0 && <div className="empty">暂无可回退点</div>}
        {picked === null && items.map((it) => (
          <button key={it.index} className="rw-item" onClick={()=>setPicked(it.index)}>
            <div className="rw-label">{it.label}</div>
            <div className="rw-changes">{it.changes}</div>
          </button>
        ))}
        {picked !== null && mode === null && (
          <div className="rw-modes">
            <div className="rw-sub">{items.find(i=>i.index===picked)?.label}</div>
            {(['both','conversation','code'] as RewindMode[]).map((m)=>(
              <button key={m} className="btn" onClick={()=>setMode(m)}>{MODE_CN[m]}</button>
            ))}
            <button className="btn ghost" onClick={()=>setPicked(null)}>‹ 返回</button>
          </div>
        )}
        {picked !== null && mode !== null && (
          <div className="rw-confirm">
            <p>确认将「{MODE_CN[mode]}」回退到此处？此操作不可轻易撤销。</p>
            <div className="rw-actions">
              <button className="btn ghost" disabled={busy} onClick={()=>setMode(null)}>取消</button>
              <button className="btn primary" disabled={busy} onClick={()=>onExecute(picked, mode)}>
                {busy ? '回退中…' : '确认回退'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```
- [ ] **Step 3: 接进 ChatView**：状态 `rewindItems: RewindItem[]|null`、`rewindBusy`。topbar 加按钮 `<button className="btn ghost sm" disabled={running} onClick={()=>sockRef.current?.send({type:'rewind_open'})}>↶ 回退</button>`；handlers `onRewindList:(items)=>{setRewindItems(items);}`，`onRewindDone:(_,ok)=>{ setRewindBusy(false); setRewindItems(null); }`；`rewindItems!==null` 时渲染 `<RewindPanel items={rewindItems} busy={rewindBusy} onExecute={(i,m)=>{ setRewindBusy(true); sockRef.current?.send({type:'rewind_execute',index:i,mode:m}); }} onClose={()=>{ setRewindItems(null); sockRef.current?.send({type:'rewind_cancel'}); }} />`。
- [ ] **Step 4: 样式**：在现有 css 追加 `.sheet-backdrop/.sheet/.rw-item/.rw-label/.rw-changes/.rw-modes/.rw-confirm/.rw-actions/.effort-pill/.effort-menu/.effort-item`（移动端友好：底部滑出、≥44px 触控）。
- [ ] **Step 5: 构建校验** `npm run build`，预期通过。
- [ ] **Step 6: 提交** `git commit -m "feat(web): RewindPanel 结构化回退（列表/选模式/二次确认）"`

### Task C6：Rewind 真实端到端冒烟

**Files:** Create `apps/server/scripts/smoke-rewind.ts`（仿 smoke-chat 风格，隔离 socket）

- [ ] **Step 1**：脚本流程——起会话 → 发"创建 note.txt 并回 done"（产生带改动 checkpoint）→ `RewindController.open()` 断言 items≥1 → `execute(0,'conversation')` 断言 `ok` → 重抓屏断言已回到正常 prompt（非 picker）→ 读 transcript 断言文件未截断（行数不变，印证树模型）→ 清理隔离 socket 与 transcript。
- [ ] **Step 2**：`npx tsx apps/server/scripts/smoke-rewind.ts`，预期 ✅。失败按 systematic-debugging 排查（多半是 `settleMs` 太短或刮屏正则边界）。
- [ ] **Step 3: 提交** `git commit -m "test(server): rewind 真实端到端冒烟（tmux+claude 闭环）"`

---

## 收尾

- [ ] 全量 `npm run typecheck && npm test`，预期全绿。
- [ ] `./start.sh` 重启，手机实测：effort 切换+持久化、rewind 三模式+二次确认各走一遍。
- [ ] 用 superpowers:finishing-a-development-branch 决定合并/收尾。

## 自查（spec 覆盖）

- effort 默认 max / 切换 / 持久化（两视图） → A1–A7 ✓
- rewind 全结构化 / 三模式 / 二次确认 / 闭环安全 → C1–C5 ✓
- transcript 树/分叉正确渲染（spike 修正） → B1–B2 ✓
- 真实集成验证 → A8 / B3 / C6 ✓
- 类型一致：`EffortLevel`/`RewindMode`/`RewindItem`/`RewindResult` 全程同名 ✓
