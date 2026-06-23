# 聊天 AskUserQuestion 实时读屏检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让待答的 AskUserQuestion 选择题在菜单打开时即在聊天界面显示为可点卡片，点选经服务端闭环驱动原生 TUI 完成作答。

**Architecture:** 纯并行增量。新增「实时读屏（AskUserQuestion 专属签名）→ ask_pending 信号 → 前端 LiveAskCard」通道；transcript 仍负责作答后的最终卡片。不动任何非选择题逻辑。

**Tech Stack:** TypeScript、Fastify、ws、React、zod、vitest、tmux。

参考 spec：`docs/superpowers/specs/2026-06-21-chat-live-ask-detection-design.md`

---

## 文件结构

- 改 `packages/shared/src/chatWs.ts`：协议新增（类型 + 消息）。
- 改 `apps/server/src/lib/session/chat/askScraper.ts`：新增 `parseAskPickerLive`（不改 `parseAskPicker`）。
- 改 `apps/server/src/lib/session/chat/askController.ts`：新增 `answerCurrent` + `navigateSoft`（不改 `answer`）。
- 改 `apps/server/src/lib/session/chat/chatSession.ts`：tick 检测 + `answerPendingAsk` + `getLiveAsk` + 新事件。
- 改 `apps/server/src/lib/session/chat/chatRegistry.ts`：扇出新事件 + 订阅/resync 补发。
- 改 `apps/server/src/routes/chat.ts`：透传新事件 + 处理 `ask_pending_answer`。
- 改 `apps/web/src/lib/chatWs.ts`：新 handlers + cases。
- 新 `apps/web/src/components/chat/LiveAskCard.tsx`。
- 改 `apps/web/src/components/chat/ChatView.tsx`：livePending 状态/渲染/抑制/去重。
- 新 `apps/server/scripts/smoke-ask-live.ts`：真实冒烟。

---

## Task 1: 协议（shared）

**Files:** Modify `packages/shared/src/chatWs.ts`

- [ ] **Step 1: 写失败测试** — 在 `packages/shared/src/chatWs.test.ts` 追加：

```ts
import { decodeChatClient } from './chatWs';

it('解码 ask_pending_answer', () => {
  const m = decodeChatClient(JSON.stringify({ type: 'ask_pending_answer', optionIndices: [1] }));
  expect(m).toEqual({ type: 'ask_pending_answer', optionIndices: [1] });
});
```

- [ ] **Step 2: 运行验证失败** — `npm test -w @rcc/shared -- chatWs` → FAIL（联合不含该类型）。

- [ ] **Step 3: 实现** — `chatWs.ts`：在 `AskPickSchema` 附近加类型；在 `ChatClientSchema` 联合加一项；在 `ChatServerMessage` 联合加三项。

```ts
/** 待答选择题的单个可点选项（仅标签，序号 0 起）。 */
export interface AskPendingOption {
  index: number;
  label: string;
}
/** 当前屏待答选择题（实时读屏投影）。 */
export interface AskPending {
  options: AskPendingOption[];
  multiSelect: boolean;
}
```

`ChatClientSchema` 联合追加：

```ts
  z.object({ type: z.literal('ask_pending_answer'), optionIndices: z.array(z.number().int().nonnegative()) }),
```

`ChatServerMessage` 联合追加：

```ts
  | { type: 'ask_pending'; options: AskPendingOption[]; multiSelect: boolean }
  | { type: 'ask_pending_clear' }
  | { type: 'ask_pending_failed'; error?: string }
```

- [ ] **Step 4: 运行验证通过** — `npm test -w @rcc/shared -- chatWs` → PASS。

- [ ] **Step 5: 提交** — `git add -A && git commit -m "feat(shared): 待答选择题协议(ask_pending/clear/failed + ask_pending_answer)"`

---

## Task 2: 实时读屏专属签名 `parseAskPickerLive`

**Files:** Modify `apps/server/src/lib/session/chat/askScraper.ts`，Test `askScraper.test.ts`

- [ ] **Step 1: 写失败测试** — `askScraper.test.ts` 追加：

```ts
import { parseAskPickerLive } from './askScraper';

describe('parseAskPickerLive', () => {
  it('真实 ask 屏 → open + 真实选项(过滤追加项) + 单选', () => {
    const s = parseAskPickerLive(fx('ask_single_select.txt'));
    expect(s.open).toBe(true);
    expect(s.options).toEqual([
      { index: 0, label: 'Apple' },
      { index: 1, label: 'Banana' },
    ]);
    expect(s.multiSelect).toBe(false);
  });

  it('rewind 样屏 → 不误判(open=false)', () => {
    const pane = [
      'Restore the code and/or conversation to a previous checkpoint',
      '❯ 1. some checkpoint',
      'Enter to continue · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    expect(parseAskPickerLive(pane).open).toBe(false);
  });

  it('普通文本 → open=false', () => {
    expect(parseAskPickerLive('just text\nno menu').open).toBe(false);
  });

  it('缺少 Chat about this 词缀 → 不判为待答', () => {
    const pane = ['Pick', '❯ 1. Apple', '  2. Banana', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    expect(parseAskPickerLive(pane).open).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败** — `npm test -w @rcc/server -- askScraper` → FAIL（`parseAskPickerLive` 未定义）。

- [ ] **Step 3: 实现** — `askScraper.ts` 末尾追加（`parseAskPicker` 不动）：

```ts
import type { AskPending } from '@rcc/shared';

const NAV = /to navigate/;
const CANCEL = /Esc to cancel/;
const ASK_AFFORDANCE = /Chat about this/i;
const REWIND_MARK = /(Restore the code|Confirm you want to restore)/;
const APPENDED = /^(Type something\.?|Chat about this)$/i;

/**
 * AskUserQuestion 专属签名检测(供实时待答用,区别于宽泛的 parseAskPicker):
 * 必含导航 footer(to navigate + Esc to cancel) + claude 特有词缀(Chat about this) +
 * ≥1 编号选项,且不含 rewind 标志。追加项(Type something./Chat about this)不外露。
 */
export function parseAskPickerLive(pane: string): AskPending & { open: boolean } {
  const text = pane.replace(/\r/g, '');
  const lines = text.split('\n');
  const closed = { open: false as const, options: [], multiSelect: false };
  const hasNav = lines.some((l) => NAV.test(l)) && lines.some((l) => CANCEL.test(l));
  if (!hasNav || !ASK_AFFORDANCE.test(text) || REWIND_MARK.test(text)) return closed;
  const raw = parseAskPicker(pane);
  if (!raw.open || raw.options.length === 0) return closed;
  const cut = raw.options.findIndex((o) => APPENDED.test(o.label.trim()));
  const real = cut === -1 ? raw.options : raw.options.slice(0, cut);
  if (real.length === 0) return closed;
  const multiSelect = /Space/.test(text) || lines.some((l) => /[☐☑]/.test(l) && /\d+\.\s/.test(l));
  return { open: true, options: real.map((o, i) => ({ index: i, label: o.label })), multiSelect };
}
```

- [ ] **Step 4: 运行验证通过** — `npm test -w @rcc/server -- askScraper` → PASS（含原有 `parseAskPicker` 用例）。

- [ ] **Step 5: 提交** — `git commit -am "feat(server): parseAskPickerLive 待答专属签名(防误判 rewind/普通屏)"`

---

## Task 3: 控制器 `answerCurrent`（逐题、失败不取消）

**Files:** Modify `askController.ts`，Test `askController.test.ts`

- [ ] **Step 1: 写失败测试** — `askController.test.ts` 追加（沿用其既有 fakeTmux 范式；若无则用下方内联 fake）：

```ts
import { AskController } from './askController';

function paneFake(panes: string[]) {
  let i = 0;
  const keys: string[][] = [];
  const tmux = {
    sendKeys: async (_n: string, k: string[]) => { keys.push(k); },
    capturePaneVisible: async () => panes[Math.min(i++, panes.length - 1)],
  };
  return { tmux, keys };
}

describe('AskController.answerCurrent', () => {
  it('单选:导航到目标编号后 Enter', async () => {
    const menu1 = ['❯ 1. Apple', '  2. Banana', 'Enter to select · ↑/↓ to navigate · Esc to cancel', 'Chat about this'].join('\n');
    const menu2 = ['  1. Apple', '❯ 2. Banana', 'Enter to select · ↑/↓ to navigate · Esc to cancel', 'Chat about this'].join('\n');
    const { tmux, keys } = paneFake([menu1, menu1, menu2, menu2]);
    const ctl = new AskController('n', tmux as any, { settleMs: 0 });
    const r = await ctl.answerCurrent([1]); // 选 Banana(编号2)
    expect(r.ok).toBe(true);
    expect(keys).toContainEqual(['Down']);
    expect(keys.at(-1)).toEqual(['Enter']);
  });

  it('菜单已关 → 失败且不发 Esc(不取消)', async () => {
    const { tmux, keys } = paneFake(['just text no menu']);
    const ctl = new AskController('n', tmux as any, { settleMs: 0 });
    const r = await ctl.answerCurrent([0]);
    expect(r.ok).toBe(false);
    expect(keys.flat()).not.toContain('Escape');
  });
});
```

- [ ] **Step 2: 运行验证失败** — `npm test -w @rcc/server -- askController` → FAIL（`answerCurrent` 未定义）。

- [ ] **Step 3: 实现** — `askController.ts` 类内追加（`answer`/`navigateTo` 不动）：

```ts
  /** 只作答当前屏这一题(逐题模型)。失败不取消(留菜单给手动兜底)。 */
  async answerCurrent(optionIndices: number[]): Promise<AskResult> {
    const s = await this.snap();
    if (!s.open) return { ok: false, error: 'not-in-ask' };
    const targets = optionIndices.map((i) => i + 1);
    if (targets.length === 0) return { ok: false, error: 'empty-pick' };
    if (targets.length === 1) {
      const nav = await this.navigateSoft(targets[0]);
      if (!nav.ok) return nav;
      await this.tmux.sendKeys(this.name, ['Enter']);
    } else {
      for (const t of targets) {
        const nav = await this.navigateSoft(t);
        if (!nav.ok) return nav;
        await this.tmux.sendKeys(this.name, ['Space']);
        await this.settle();
      }
      await this.tmux.sendKeys(this.name, ['Enter']);
    }
    await this.settle();
    return { ok: true };
  }

  /** 同 navigateTo 但失败只返回结果、不 Esc 取消。 */
  private async navigateSoft(target: number): Promise<AskResult> {
    let s = await this.snap();
    if (!s.open) return { ok: false, error: 'menu-lost' };
    let guard = this.opts.maxSteps ?? 40;
    while (s.cursor !== target && guard-- > 0) {
      await this.tmux.sendKeys(this.name, [s.cursor > target ? 'Up' : 'Down']);
      await this.settle();
      const before = s.cursor;
      s = await this.snap();
      if (!s.open) return { ok: false, error: 'menu-lost' };
      if (s.cursor === before) return { ok: false, error: 'cursor-stuck' };
    }
    if (s.cursor !== target) return { ok: false, error: 'unreachable' };
    return { ok: true };
  }
```

- [ ] **Step 4: 运行验证通过** — `npm test -w @rcc/server -- askController` → PASS。

- [ ] **Step 5: 提交** — `git commit -am "feat(server): AskController.answerCurrent 逐题作答(失败不取消)"`

---

## Task 4: 会话 tick 检测 + answerPendingAsk + getLiveAsk

**Files:** Modify `chatSession.ts`，Test `chatSession.test.ts`

- [ ] **Step 1: 写失败测试** — `chatSession.test.ts`：先把 `events()` 与 `fakeAsk()` 升级（加新事件/新方法），再加用例。

更新 helpers：

```ts
const events = () => ({ onMessage: vi.fn(), onPreview: vi.fn(), onTurnState: vi.fn(), onHistory: vi.fn(), onAskState: vi.fn(), onAskPending: vi.fn(), onAskPendingClear: vi.fn(), onAskPendingFailed: vi.fn() });

function fakeAsk(over: Record<string, any> = {}) {
  return { answer: vi.fn(async () => ({ ok: true })), answerCurrent: vi.fn(async () => ({ ok: true })), ...over };
}
```

新用例：

```ts
const ASK_PANE = [
  ' ☐ Fruit', '', 'Pick a fruit', '',
  '❯ 1. Apple', '  2. Banana', '  3. Type something.', '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

describe('ChatSession 待答选择题(实时读屏)', () => {
  it('检测到待答 → onAskPending(真实选项) 且不发预览、running=false', async () => {
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => ASK_PANE) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false }, ev);
    await s.tick();
    expect(ev.onAskPending).toHaveBeenCalledWith({ options: [{ index: 0, label: 'Apple' }, { index: 1, label: 'Banana' }], multiSelect: false });
    expect(ev.onPreview).not.toHaveBeenCalled();
    expect(s.isRunning()).toBe(false);
    expect(s.getLiveAsk()).not.toBeNull();
  });

  it('菜单消失 → onAskPendingClear', async () => {
    let pane = ASK_PANE;
    const tmux = fakeTmux({ capturePaneVisible: vi.fn(async () => pane) });
    const ev = events();
    const s = new ChatSession(spec, { tmux, scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false }, ev);
    await s.tick();
    pane = 'just text';
    await s.tick();
    expect(ev.onAskPendingClear).toHaveBeenCalled();
    expect(s.getLiveAsk()).toBeNull();
  });

  it('answerPendingAsk 调 answerCurrent;失败发 onAskPendingFailed', async () => {
    const ask = fakeAsk({ answerCurrent: vi.fn(async () => ({ ok: false, error: 'unreachable' })) });
    const ev = events();
    const s = new ChatSession(spec, { tmux: fakeTmux(), scrape: scrapePane, tail: fakeTail(), hasTranscript: () => false, makeAsk: () => ask }, ev);
    await s.answerPendingAsk([1]);
    expect(ask.answerCurrent).toHaveBeenCalledWith([1]);
    expect(ev.onAskPendingFailed).toHaveBeenCalledWith('unreachable');
  });
});
```

- [ ] **Step 2: 运行验证失败** — `npm test -w @rcc/server -- chatSession` → FAIL。

- [ ] **Step 3: 实现** — `chatSession.ts`：

import 顶部加：`import { parseAskPickerLive } from './askScraper';` 并从 `@rcc/shared` 引入 `AskPending`。

`ChatSessionEvents` 接口追加：

```ts
  onAskPending: (a: AskPending) => void;
  onAskPendingClear: () => void;
  onAskPendingFailed: (error?: string) => void;
```

`AskLike` 接口追加：

```ts
  answerCurrent(optionIndices: number[]): Promise<AskResult>;
```

类字段追加：

```ts
  private lastAskSig = '';
  private lastAsk: AskPending | null = null;
```

`tick()`：在 `const pane = await this.deps.tmux.capturePaneVisible(...)` 之后、`const s = this.deps.scrape(pane)` 之前插入：

```ts
      // 选择题待答:实时读屏(专属签名)。命中即发待答态、抑制预览/运行,跳过其余读屏逻辑。
      const ask = parseAskPickerLive(pane);
      if (ask.open) {
        const sig = JSON.stringify(ask.options.map((o) => o.label)) + (ask.multiSelect ? '#m' : '');
        if (sig !== this.lastAskSig) {
          this.lastAskSig = sig;
          this.lastAsk = { options: ask.options, multiSelect: ask.multiSelect };
          this.events.onAskPending(this.lastAsk);
        }
        if (this.running) this.setRunning(false);
        this.holdPreview = false;
        return;
      }
      if (this.lastAskSig) {
        this.lastAskSig = '';
        this.lastAsk = null;
        this.events.onAskPendingClear();
      }
```

类方法追加（靠近 `answerAsk`）：

```ts
  /** 作答当前待答选择题(实时读屏卡片驱动)。驱动期 tick 静默;失败广播以便前端兜底。 */
  async answerPendingAsk(optionIndices: number[]): Promise<void> {
    this.askActive = true;
    try {
      const r = await this.ensureAsk().answerCurrent(optionIndices);
      if (!r.ok) this.events.onAskPendingFailed(r.error);
    } catch (e) {
      this.events.onAskPendingFailed(e instanceof Error ? e.message : String(e));
    } finally {
      this.askActive = false;
    }
  }

  /** 当前待答态(重连/新订阅补发用);无则 null。 */
  getLiveAsk(): AskPending | null {
    return this.lastAsk;
  }
```

- [ ] **Step 4: 运行验证通过** — `npm test -w @rcc/server -- chatSession` → PASS（既有用例须全绿）。

- [ ] **Step 5: 提交** — `git commit -am "feat(server): ChatSession 待答读屏检测 + answerPendingAsk + getLiveAsk"`

---

## Task 5: 注册表扇出 + 订阅/resync 补发

**Files:** Modify `chatRegistry.ts`，Test `chatRegistry.test.ts`

- [ ] **Step 1: 写失败测试** — `chatRegistry.test.ts` 追加（沿用其既有 fake 会话范式；fake 会话需补 `answerPendingAsk`/`getLiveAsk`）：

```ts
it('新订阅者加入活动会话:若有待答态则补发 onAskPending', async () => {
  // 构造一个 getLiveAsk 返回待答态的 fake 会话工厂(参考本文件既有 fake 范式)
  // 断言:第二个订阅者的 onAskPending 被调用一次。
});
```

（实现时按本文件既有 fakeSession 写全；关键断言 `sub2.onAskPending` 被调用。）

- [ ] **Step 2: 运行验证失败** — `npm test -w @rcc/server -- chatRegistry` → FAIL。

- [ ] **Step 3: 实现** — `chatRegistry.ts`：

`import` 加 `AskPending`（从 `@rcc/shared`）。

`ChatSessionLike` 追加：

```ts
  answerPendingAsk(optionIndices: number[]): Promise<void>;
  getLiveAsk(): AskPending | null;
```

`ChatSubscriber` 追加：

```ts
  onAskPending: (a: AskPending) => void;
  onAskPendingClear: () => void;
  onAskPendingFailed: (error?: string) => void;
```

`ChatHandle` 追加：

```ts
  answerPendingAsk(optionIndices: number[]): Promise<void>;
  getLiveAsk(): AskPending | null;
```

工厂 events 追加扇出：

```ts
        onAskPending: (a) => subscribers.forEach((s) => s.onAskPending(a)),
        onAskPendingClear: () => subscribers.forEach((s) => s.onAskPendingClear()),
        onAskPendingFailed: (e) => subscribers.forEach((s) => s.onAskPendingFailed(e)),
```

订阅补发（`sub.onHistory(e.session.getMessages());` 之后）：

```ts
    const live = e.session.getLiveAsk();
    if (live) sub.onAskPending(live);
```

返回的 handle 追加：

```ts
      answerPendingAsk: (idx) => e.session.answerPendingAsk(idx),
      getLiveAsk: () => e.session.getLiveAsk(),
```

`resync` 改为：

```ts
      resync: () => {
        sub.onHistory(e.session.getMessages());
        const la = e.session.getLiveAsk();
        if (la) sub.onAskPending(la);
        else sub.onAskPendingClear();
      },
```

- [ ] **Step 4: 运行验证通过** — `npm test -w @rcc/server -- chatRegistry` → PASS。

- [ ] **Step 5: 提交** — `git commit -am "feat(server): 注册表扇出待答事件 + 订阅/resync 补发"`

---

## Task 6: 路由透传 + 处理 ask_pending_answer

**Files:** Modify `routes/chat.ts`（无独立单测；由 app.test/冒烟覆盖）

- [ ] **Step 1: 实现** — `routes/chat.ts`：

`subscribe(...)` 的事件对象追加：

```ts
          onAskPending: (a) => send({ type: 'ask_pending', options: a.options, multiSelect: a.multiSelect }),
          onAskPendingClear: () => send({ type: 'ask_pending_clear' }),
          onAskPendingFailed: (error) => send({ type: 'ask_pending_failed', error }),
```

`socket.on('message')` 的 switch 追加：

```ts
          case 'ask_pending_answer':
            void handle.answerPendingAsk(msg.optionIndices);
            break;
```

- [ ] **Step 2: 验证类型/构建** — `npm run typecheck` → PASS。

- [ ] **Step 3: 提交** — `git commit -am "feat(server): chat 路由透传待答事件 + ask_pending_answer"`

---

## Task 7: 前端 WS 客户端

**Files:** Modify `apps/web/src/lib/chatWs.ts`

- [ ] **Step 1: 实现** — `ChatHandlers` 追加：

```ts
  onAskPending?: (a: { options: { index: number; label: string }[]; multiSelect: boolean }) => void;
  onAskPendingClear?: () => void;
  onAskPendingFailed?: (error?: string) => void;
```

`onmessage` switch 追加：

```ts
        case 'ask_pending':
          handlers.onAskPending?.({ options: msg.options, multiSelect: msg.multiSelect });
          break;
        case 'ask_pending_clear':
          handlers.onAskPendingClear?.();
          break;
        case 'ask_pending_failed':
          handlers.onAskPendingFailed?.(msg.error);
          break;
```

- [ ] **Step 2: 验证类型** — `npm run typecheck` → PASS。

- [ ] **Step 3: 提交** — `git commit -am "feat(web): chatWs 客户端接待答事件"`

---

## Task 8: LiveAskCard 组件（新）

**Files:** Create `apps/web/src/components/chat/LiveAskCard.tsx`

- [ ] **Step 1: 实现** — 复用既有 `askcard` 系列 CSS：

```tsx
import { useState } from 'react';

export type LiveAskState = 'open' | 'driving' | 'failed';

/** 实时读屏待答选择题卡片:单选点击即提交,多选 toggle+发送。不依赖 transcript。 */
export function LiveAskCard({
  options,
  multiSelect,
  state,
  error,
  onAnswer,
}: {
  options: { index: number; label: string }[];
  multiSelect: boolean;
  state: LiveAskState;
  error?: string;
  onAnswer: (optionIndices: number[]) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const disabled = state === 'driving';
  if (options.length === 0) return null;

  const toggle = (i: number) => {
    setSel((prev) => {
      if (!multiSelect) return [i];
      const s = new Set(prev);
      s.has(i) ? s.delete(i) : s.add(i);
      return [...s];
    });
  };

  return (
    <div className={`askcard ${state === 'failed' ? 'failed' : ''}`}>
      <div className="ask-q">
        <div className="ask-header">Claude 正在等待你的选择</div>
        <div className="ask-options">
          {options.map((op) => {
            const picked = sel.includes(op.index);
            return (
              <button
                key={op.index}
                className={`ask-option ${picked ? 'picked' : ''}`}
                disabled={disabled}
                onClick={() => (multiSelect ? toggle(op.index) : onAnswer([op.index]))}
              >
                <span className="ask-mark" aria-hidden>
                  {multiSelect ? (picked ? '☑' : '☐') : picked ? '◉' : '○'}
                </span>
                <span className="ask-option-text">
                  <span className="ask-option-label">{op.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {multiSelect && (
        <button className="btn ask-submit" disabled={disabled || sel.length === 0} onClick={() => onAnswer(sel)}>
          发送选择
        </button>
      )}
      {state === 'driving' && <div className="ask-note">作答中…</div>}
      {state === 'failed' && <div className="ask-note err">自动作答失败({error || '未知'})。可用下方按键条或终端作答。</div>}
    </div>
  );
}
```

- [ ] **Step 2: 验证类型** — `npm run typecheck` → PASS。

- [ ] **Step 3: 提交** — `git commit -am "feat(web): LiveAskCard 实时待答卡片"`

---

## Task 9: ChatView 接线（状态/渲染/抑制/去重）

**Files:** Modify `apps/web/src/components/chat/ChatView.tsx`

- [ ] **Step 1: 实现** —

import：`import { LiveAskCard, type LiveAskState } from './LiveAskCard';`

新状态：

```ts
  const [livePending, setLivePending] = useState<{ options: { index: number; label: string }[]; multiSelect: boolean } | null>(null);
  const [liveState, setLiveState] = useState<LiveAskState>('open');
  const [liveError, setLiveError] = useState<string | undefined>(undefined);
```

`connectChat` handlers 追加：

```ts
      onAskPending: (a) => {
        setLivePending(a);
        setLiveState('open');
        setLiveError(undefined);
      },
      onAskPendingClear: () => setLivePending(null),
      onAskPendingFailed: (err) => {
        setLiveState('failed');
        setLiveError(err);
      },
```

去重 effect（transcript 卡片就位即清实时卡）：

```ts
  useEffect(() => {
    if (livePending && messages.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion'))) {
      setLivePending(null);
    }
  }, [messages, livePending]);
```

发送函数：

```ts
  const sendPendingAnswer = (optionIndices: number[]) => {
    setLiveState('driving');
    sockRef.current?.send({ type: 'ask_pending_answer', optionIndices });
  };
```

渲染：在 `<TurnList .../>` 之后、`{running && preview ...}` 之前插入：

```tsx
        {livePending && (
          <LiveAskCard
            options={livePending.options}
            multiSelect={livePending.multiSelect}
            state={liveState}
            error={liveError}
            onAnswer={sendPendingAnswer}
          />
        )}
```

抑制预览/思考：把两处 `!hasPendingAsk` 守卫改为 `!hasPendingAsk && !livePending`：

```tsx
        {running && preview && !hasPendingAsk && !livePending && ( ... )}
        {running && !preview && !hasPendingAsk && !livePending && ( ... )}
```

滚动依赖追加 `livePending`：`}, [messages, preview, running, livePending]);`

- [ ] **Step 2: 验证类型/构建** — `npm run typecheck && npm run build` → PASS。

- [ ] **Step 3: 提交** — `git commit -am "feat(web): ChatView 渲染实时待答卡 + 抑制预览 + 与 transcript 卡去重"`

---

## Task 10: 真实冒烟（端到端）

**Files:** Create `apps/server/scripts/smoke-ask-live.ts`

- [ ] **Step 1: 实现** — 隔离 socket 起会话触发 AskUserQuestion，断言待答期 `ChatSession.getLiveAsk()` 非空且 `onAskPending` 被触发；经 `answerPendingAsk` 作答后菜单关闭、`onAskPendingClear` 触发；结束清理 tmux。脚本结构参考 `scripts/spike-ask.ts`（同 socket 隔离/清理范式），用 `ChatSession` + 真实 `Tmux`，`pollMs` 设 400。失败 `process.exit(1)`。

- [ ] **Step 2: 运行** — `npx tsx apps/server/scripts/smoke-ask-live.ts` → 退出码 0，日志显示「待答→onAskPending→作答→onAskPendingClear」。

- [ ] **Step 3: 提交** — `git commit -am "test(server): 待答选择题实时检测端到端冒烟"`

---

## Task 11: 全量回归

- [ ] **Step 1:** `npm test` → 全绿（含既有用例，证明未破坏其他功能）。
- [ ] **Step 2:** `npm run typecheck` → PASS。
- [ ] **Step 3:** `npm run build` → PASS。
- [ ] **Step 4:** `./start.sh --no-build` 重启，手机/浏览器手测：问一句诱发 AskUserQuestion → 聊天界面待答时即出现可点卡片 → 点选完成；再测终端答 → 聊天卡片随之消失、显示最终卡片。
- [ ] **Step 5:** 确认 rewind/effort/普通流式/终端视图均无回归。

## Self-Review 记录

- Spec 覆盖：协议(Task1)、检测(Task2)、逐题作答(Task3)、会话(Task4)、扇出/补发(Task5)、路由(Task6)、客户端(Task7)、卡片(Task8)、接线(Task9)、冒烟(Task10)、回归(Task11) 一一对应。
- 类型一致：`AskPending`/`AskPendingOption` 定义于 shared，server/web 共用；`answerCurrent(optionIndices:number[])`、`answerPendingAsk(optionIndices:number[])`、`getLiveAsk():AskPending|null` 全文一致。
- 无占位符：各步给出实际代码/命令。
