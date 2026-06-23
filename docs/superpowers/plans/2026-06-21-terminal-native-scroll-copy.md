# 终端原生滚动 / 干净复制 / 懒加载 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 终端模式保留真实 xterm，补齐 WebGL 顺滑滚动、干净选中复制、不挡字滚动条，并新增基于 `tmux capture-pane -J` 的原生可选中、懒加载历史阅读层（向上滚到顶自动进入）。

**Architecture:** 纯增量。实时终端 = 现有 WS 字节流不动，仅前端加 WebGL 渲染器 + 复制处理 + 隐藏 xterm 丑滚动条。历史阅读层 = 独立只读 HTTP 端点 `GET …/scrollback`，后端用 `display-message` 取 `history_size/pane_height` + 纯函数算窗口 + `capture-pane -J` 抓真实屏字符，前端用原生 `<pre>` 渲染、反向无限滚动保持位置。

**Tech Stack:** TypeScript、Fastify、zod、vitest（server/shared 共置 TDD）、React、xterm.js + `@xterm/addon-webgl`、tmux。

**已实测的 tmux 语义（写代码依据）：** `T = history_size + pane_height`；显示下标 `d`（0=最旧）映射 tmux 行号 `L = d - history_size`；最旧行 `-history_size`，最底行 `pane_height-1`；`capture-pane -S -<H> -E <P-1>` = 全部 `T` 行；`-J` 合并折行但**用空格右填充** → 每行必须 `trimEnd()`。

---

### Task 1: shared — ScrollbackChunk 类型

**Files:**
- Modify: `packages/shared/src/schemas.ts`（文件末尾追加）
- Test: `packages/shared/src/schemas.test.ts`（追加一个用例）

- [ ] **Step 1: 写失败测试**

在 `packages/shared/src/schemas.test.ts` 末尾追加：

```ts
import { ScrollbackChunkSchema } from './schemas';

describe('ScrollbackChunkSchema', () => {
  it('解析合法 chunk', () => {
    const v = ScrollbackChunkSchema.parse({ lines: ['a', 'b'], nextBefore: 3, atTop: false });
    expect(v.lines).toEqual(['a', 'b']);
    expect(v.nextBefore).toBe(3);
    expect(v.atTop).toBe(false);
  });
  it('nextBefore 可为 null', () => {
    const v = ScrollbackChunkSchema.parse({ lines: [], nextBefore: null, atTop: true });
    expect(v.nextBefore).toBeNull();
  });
});
```

（若该测试文件顶部未 `import { describe, it, expect } from 'vitest'`，按文件现有风格补齐导入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/shared run test`
Expected: FAIL（`ScrollbackChunkSchema` 未导出）

- [ ] **Step 3: 实现**

在 `packages/shared/src/schemas.ts` 末尾追加：

```ts
/** 终端历史阅读层一窗数据：真实屏字符（已 trimEnd），nextBefore=下一更早窗游标。 */
export const ScrollbackChunkSchema = z.object({
  lines: z.array(z.string()),
  nextBefore: z.number().int().nullable(),
  atTop: z.boolean(),
});
export type ScrollbackChunk = z.infer<typeof ScrollbackChunkSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w @rcc/shared run test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): ScrollbackChunk zod 类型(终端历史阅读层一窗数据)"
```

---

### Task 2: server — 纯窗口换算 `computeWindow`

**Files:**
- Create: `apps/server/src/lib/session/scrollback.ts`
- Test: `apps/server/src/lib/session/scrollback.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/lib/session/scrollback.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { computeWindow } from './scrollback';

// 实测基线：H=61, P=10, T=71
describe('computeWindow', () => {
  it('首窗(before=null)取最新一窗，映射到 tmux 行号', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: null, limit: 50 });
    expect(w.startLine).toBe(-40); // lo=21 → 21-61
    expect(w.endLine).toBe(9); // hi=71 → 70-61
    expect(w.nextBefore).toBe(21);
    expect(w.atTop).toBe(false);
    expect(w.empty).toBe(false);
  });
  it('上一窗收敛到顶', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: 21, limit: 50 });
    expect(w.startLine).toBe(-61); // lo=0 → 0-61
    expect(w.endLine).toBe(-41); // hi=21 → 20-61
    expect(w.nextBefore).toBe(0);
    expect(w.atTop).toBe(true);
  });
  it('limit 超过总行数 → 一窗到顶', () => {
    const w = computeWindow({ historySize: 0, paneHeight: 5, before: null, limit: 999 });
    expect(w.startLine).toBe(0); // lo=0 → 0-0
    expect(w.endLine).toBe(4); // hi=5 → 4-0
    expect(w.atTop).toBe(true);
    expect(w.empty).toBe(false);
  });
  it('before<=0 → 空窗', () => {
    const w = computeWindow({ historySize: 10, paneHeight: 5, before: 0, limit: 50 });
    expect(w.empty).toBe(true);
    expect(w.atTop).toBe(true);
  });
  it('before 超出上界被夹紧到 T', () => {
    const w = computeWindow({ historySize: 61, paneHeight: 10, before: 9999, limit: 50 });
    expect(w.endLine).toBe(9); // hi 夹到 71
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/server run test -- scrollback`
Expected: FAIL（`computeWindow` 不存在）

- [ ] **Step 3: 实现**

Create `apps/server/src/lib/session/scrollback.ts`：

```ts
/**
 * 终端历史阅读层的纯窗口换算。把「显示下标(0=最旧)」窗口映射到 tmux capture-pane 的 -S/-E 行号。
 * 实测语义：T = historySize + paneHeight；行号 L = d - historySize；最旧 -historySize，最底 paneHeight-1。
 */
export interface WindowInput {
  historySize: number; // tmux #{history_size}
  paneHeight: number; // tmux #{pane_height}
  before: number | null; // 本次取数的「排他上界」显示下标；null=最新一窗
  limit: number; // 一窗最多行数
}

export interface WindowResult {
  startLine: number; // tmux -S
  endLine: number; // tmux -E
  nextBefore: number; // 本窗下界 = 下一更早窗的游标
  atTop: boolean; // 已到最旧
  empty: boolean; // 无内容可取
}

export function computeWindow(input: WindowInput): WindowResult {
  const H = Math.max(0, Math.floor(input.historySize));
  const P = Math.max(1, Math.floor(input.paneHeight));
  const total = H + P;
  const limit = Math.max(1, Math.floor(input.limit));
  const hiRaw = input.before == null ? total : Math.floor(input.before);
  const hi = Math.min(Math.max(hiRaw, 0), total);
  const lo = Math.max(0, hi - limit);
  const empty = hi <= 0 || hi <= lo;
  return {
    startLine: lo - H,
    endLine: hi - 1 - H,
    nextBefore: lo,
    atTop: lo === 0,
    empty,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w @rcc/server run test -- scrollback`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/session/scrollback.ts apps/server/src/lib/session/scrollback.test.ts
git commit -m "feat(server): 终端历史窗口换算纯函数 computeWindow(TDD,基于实测 tmux 语义)"
```

---

### Task 3: server — tmux `historyInfo` + `captureRange`

**Files:**
- Modify: `apps/server/src/lib/session/tmux.ts`
- Test: `apps/server/src/lib/session/tmux.test.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/lib/session/tmux.test.ts` 追加（沿用文件里既有的 fake exec 风格；若文件用 `new Tmux('sock', fakeExec)` 注入，照此写）：

```ts
describe('historyInfo / captureRange', () => {
  it('historyInfoArgs 拼装 display-message', () => {
    const t = new Tmux('rcc');
    expect(t.historyInfoArgs('s1')).toEqual([
      '-L', 'rcc', 'display-message', '-p', '-t', 's1', '#{history_size} #{pane_height}',
    ]);
  });
  it('historyInfo 解析两个整数', async () => {
    const t = new Tmux('rcc', async () => ({ stdout: '61 10\n', stderr: '' }));
    expect(await t.historyInfo('s1')).toEqual({ historySize: 61, paneHeight: 10 });
  });
  it('historyInfo 出错返回 null', async () => {
    const t = new Tmux('rcc', async () => { throw new Error('no session'); });
    expect(await t.historyInfo('s1')).toBeNull();
  });
  it('captureRangeArgs 带 -J 与 -S/-E', () => {
    const t = new Tmux('rcc');
    expect(t.captureRangeArgs('s1', -40, 9)).toEqual([
      '-L', 'rcc', 'capture-pane', '-p', '-J', '-t', 's1', '-S', '-40', '-E', '9',
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/server run test -- tmux`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

在 `apps/server/src/lib/session/tmux.ts` 的 `Tmux` 类内追加（紧挨 `capturePane` 之后）：

```ts
  /** display-message 取历史行数与窗格高（阅读层窗口换算用）。argv 纯拼装便于单测。 */
  historyInfoArgs(name: string): string[] {
    return [...this.base(), 'display-message', '-p', '-t', name, '#{history_size} #{pane_height}'];
  }

  async historyInfo(name: string): Promise<{ historySize: number; paneHeight: number } | null> {
    try {
      const { stdout } = await this.exec('tmux', this.historyInfoArgs(name));
      const [h, p] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (!Number.isFinite(h) || !Number.isFinite(p)) return null;
      return { historySize: h, paneHeight: p };
    } catch {
      return null;
    }
  }

  /** 抓指定行号区间(含历史)，-J 合并折行。供阅读层按窗口取数。 */
  captureRangeArgs(name: string, start: number, end: number): string[] {
    return [...this.base(), 'capture-pane', '-p', '-J', '-t', name, '-S', String(start), '-E', String(end)];
  }

  async captureRange(name: string, start: number, end: number): Promise<string> {
    try {
      const { stdout } = await this.exec('tmux', this.captureRangeArgs(name, start, end));
      return stdout;
    } catch {
      return '';
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm -w @rcc/server run test -- tmux`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/session/tmux.ts apps/server/src/lib/session/tmux.test.ts
git commit -m "feat(server): Tmux 增 historyInfo/captureRange(-J 合并折行,容错返回 null/空)"
```

---

### Task 4: server — `GET …/scrollback` 路由

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Test: `apps/server/src/routes/sessions.scrollback.test.ts`

- [ ] **Step 1: 写失败测试**

参照 `apps/server/src/routes/sessions.rename.test.ts` 的脚手架（构建 app、注入 fake tmux/conversations、登录拿 cookie）。新建 `sessions.scrollback.test.ts`，核心断言：

```ts
// 伪代码骨架——按 sessions.rename.test.ts 的实际 helper 调整：
// 1) 未登录 → 401
// 2) 非 owner 不可见项目 → 404
// 3) 会话不存在 → 404
// 4) 正常：fake tmux.historyInfo 返回 {61,10}，captureRange 返回 'a\nb  \n'（含尾空格）
//    → 期望 body.lines === ['a','b']（尾空格被 trimEnd），nextBefore/atTop 来自 computeWindow
// 5) 容错：tmux.historyInfo 返回 null → body === { lines: [], nextBefore: 0, atTop: true }
```

至少实现用例 4、5 与鉴权 1：

```ts
it('正常返回并 trimEnd', async () => {
  // fakeTmux.historyInfo → { historySize: 61, paneHeight: 10 }
  // fakeTmux.captureRange → 'a\nb  \n'
  const res = await app.inject({
    method: 'GET',
    url: `/api/projects/${pid}/conversations/${cid}/scrollback?limit=50`,
    cookies: { [COOKIE_NAME]: token },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().lines).toEqual(['a', 'b']);
});

it('会话不在 tmux → 空 chunk 容错', async () => {
  // fakeTmux.historyInfo → null
  const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/conversations/${cid}/scrollback`, cookies: { [COOKIE_NAME]: token } });
  expect(res.json()).toEqual({ lines: [], nextBefore: 0, atTop: true });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm -w @rcc/server run test -- scrollback`
Expected: FAIL（路由 404/未实现）

- [ ] **Step 3: 实现**

在 `apps/server/src/routes/sessions.ts` 顶部加导入：

```ts
import { computeWindow } from '../lib/session/scrollback';
import type { ScrollbackChunk } from '@rcc/shared';
```

在 `registerSessionRoutes` 内、终端流 WS 之前，加只读端点：

```ts
  // ---- 终端历史阅读层（只读，独立于 WS） ----
  app.get(
    '/api/projects/:id/conversations/:cid/scrollback',
    { preHandler: requireAuth },
    async (req, reply): Promise<ScrollbackChunk> => {
      const { id, cid } = req.params as { id: string; cid: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' }) as unknown as ScrollbackChunk;
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id) {
        return reply.code(404).send({ error: 'conversation not found' }) as unknown as ScrollbackChunk;
      }
      const q = req.query as { before?: string; limit?: string };
      const before = q.before && /^\d+$/.test(q.before) ? parseInt(q.before, 10) : null;
      const limit = Math.min(Math.max(parseInt(q.limit ?? '800', 10) || 800, 1), 5000);

      const info = await ctx.tmux.historyInfo(conv.tmuxName);
      if (!info) return { lines: [], nextBefore: 0, atTop: true };

      const w = computeWindow({ historySize: info.historySize, paneHeight: info.paneHeight, before, limit });
      if (w.empty) return { lines: [], nextBefore: w.nextBefore, atTop: w.atTop };

      const raw = await ctx.tmux.captureRange(conv.tmuxName, w.startLine, w.endLine);
      const lines = raw.replace(/\n$/, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
      return { lines, nextBefore: w.nextBefore, atTop: w.atTop };
    },
  );
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npm -w @rcc/server run test`
Expected: PASS（含新用例，旧用例不回归）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/routes/sessions.scrollback.test.ts
git commit -m "feat(server): GET …/scrollback 只读端点(historyInfo+computeWindow+captureRange,trimEnd,容错)"
```

---

### Task 5: web — api 客户端 `getScrollback`

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 实现**

在 `api.ts` 顶部类型导入里加 `ScrollbackChunk`：

```ts
import type {
  Project, Conversation, FileEntry, TaskItem, EvidenceItem, TaskStatus, AuthUser, Role, MetricsSnapshot,
  ScrollbackChunk,
} from '@rcc/shared';
```

在 `api` 对象里（`deleteConversation` 之后）加：

```ts
  /** 终端历史阅读层：取一窗真实屏字符。before 省略=最新一窗，否则取更早一窗。 */
  getScrollback: (pid: string, cid: string, before?: number, limit = 800) => {
    const params = new URLSearchParams();
    if (before != null) params.set('before', String(before));
    params.set('limit', String(limit));
    return req<ScrollbackChunk>(
      'GET',
      `/api/projects/${pid}/conversations/${cid}/scrollback?${params.toString()}`,
    );
  },
```

- [ ] **Step 2: typecheck**

Run: `npm -w @rcc/web run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): api.getScrollback(终端历史阅读层取数)"
```

---

### Task 6: web — WebGL 渲染器 + 隐藏丑滚动条

**Files:**
- Modify: `apps/web/package.json`（加依赖）
- Modify: `apps/web/src/components/Terminal.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: 装依赖（与 xterm 5.5 匹配）**

Run: `npm install @xterm/addon-webgl@0.18.0 -w @rcc/web`
Expected: 安装成功（若 0.18.0 与 xterm 5.5 peer 不符，回退 `npm view @xterm/addon-webgl versions` 选与 5.5 匹配的版本）。

- [ ] **Step 2: Terminal.tsx 加载 WebGL（带回退）**

`Terminal.tsx` 顶部加导入：

```ts
import { WebglAddon } from '@xterm/addon-webgl';
```

在 `term.open(hostRef.current!);` 之后、`termRef.current = term;` 之前插入：

```ts
    // WebGL 渲染器(GPU)让实时滚动顺滑；构造或上下文丢失则静默回退默认渲染器。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* 回退 DOM 渲染器 */
    }
```

- [ ] **Step 3: index.css 隐藏 .term-host 的 xterm 滚动条**

在 `index.css` 的 `.term-host .xterm { height: 100%; }` 之后追加（实时终端走 tmux 全屏，xterm 自身 scrollback 无用，隐藏丑条；历史滚动交给阅读层）：

```css
/* 实时终端：隐藏 xterm 自带滚动条(无用且盖字)，历史滚动交给阅读层 */
.term-host .xterm-viewport {
  scrollbar-width: none;
}
.term-host .xterm-viewport::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
```

- [ ] **Step 4: 构建确认无报错**

Run: `npm -w @rcc/web run typecheck && npm -w @rcc/web run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/src/components/Terminal.tsx apps/web/src/index.css ../../package-lock.json 2>/dev/null; git add -A apps/web package-lock.json
git commit -m "feat(web): 终端 WebGL 渲染器(顺滑滚动,带回退)+ 隐藏 xterm 丑滚动条"
```

---

### Task 7: web — 选中复制（快捷键 + 复制键）

**Files:**
- Modify: `apps/web/src/components/Terminal.tsx`

- [ ] **Step 1: Cmd/Ctrl+C 有选区则复制（否则照常发 ^C）**

在 `Terminal.tsx` 创建 `term` 后、`sock` 连接前，加自定义键处理：

```ts
    // 有选区时 Cmd/Ctrl+C 复制到剪贴板并拦截(不发 ^C)；无选区照常透传。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      return true;
    });
```

- [ ] **Step 2: keybar 增「复制」键（移动端友好）**

把 `sendKey` 旁边加一个复制可见/选区的处理，并在 keybar 渲染里加一个按钮。在 `KEYS` 渲染的 `</div>` 前（keybar 内）追加：

```tsx
        <button
          className="keycap"
          onClick={() => {
            const term = termRef.current;
            if (!term) return;
            const sel = term.getSelection();
            const text = sel && sel.length > 0 ? sel : term.buffer.active
              ? Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '').join('\n').replace(/\n+$/, '')
              : '';
            if (text) void navigator.clipboard.writeText(text);
          }}
        >
          复制
        </button>
```

- [ ] **Step 3: 构建确认**

Run: `npm -w @rcc/web run typecheck && npm -w @rcc/web run build`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/Terminal.tsx
git commit -m "feat(web): 终端选中复制(Cmd/Ctrl+C 拦截 + 移动端复制键)"
```

---

### Task 8: web — ScrollbackReader 阅读层组件

**Files:**
- Create: `apps/web/src/components/ScrollbackReader.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: 创建组件**

Create `apps/web/src/components/ScrollbackReader.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

/**
 * 终端历史阅读层：原生 <pre> 文本流，浏览器原生选中/顺滑滚动；
 * 反向无限滚动——滚到顶取更早一窗 prepend 并保持滚动位置不跳。懒加载，传输小块。
 */
export function ScrollbackReader({
  projectId,
  convId,
  onClose,
}: {
  projectId: string;
  convId: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [atTop, setAtTop] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 初次：取最新一窗、贴底
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getScrollback(projectId, convId)
      .then((chunk) => {
        if (cancelled) return;
        setLines(chunk.lines);
        setBefore(chunk.atTop ? null : chunk.nextBefore);
        setAtTop(chunk.atTop);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, convId]);

  const loadOlder = useCallback(async () => {
    if (loading || atTop || before == null) return;
    const el = scrollRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    setLoading(true);
    try {
      const chunk = await api.getScrollback(projectId, convId, before);
      setLines((cur) => [...chunk.lines, ...cur]);
      setBefore(chunk.atTop ? null : chunk.nextBefore);
      setAtTop(chunk.atTop);
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2) el2.scrollTop = el2.scrollHeight - prevHeight; // 保持位置不跳
      });
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [loading, atTop, before, projectId, convId]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop <= 24) void loadOlder();
  }, [loadOlder]);

  const copy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="sb-reader">
      <div className="sb-toolbar">
        <button className="btn ghost sm" onClick={onClose}>
          ← 返回实时
        </button>
        <span className="sb-hint">
          {atTop ? '已到历史起点' : loading ? '加载中…' : '↑ 滚到顶加载更早'}
        </span>
        <button className="btn ghost sm" onClick={() => copy(window.getSelection()?.toString() ?? '')}>
          复制选中
        </button>
        <button className="btn ghost sm" onClick={() => copy(lines.join('\n'))}>
          {copied ? '已复制' : '复制全部'}
        </button>
      </div>
      <div className="sb-scroll" ref={scrollRef} onScroll={onScroll}>
        {atTop && <div className="sb-cap">— 历史起点 —</div>}
        <pre className="sb-text">{lines.join('\n')}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: index.css 阅读层样式（细滚动条、等宽、可选中）**

在 `index.css` 终端视图段落（`.keycap:active{}` 之后）追加：

```css
/* ---- 终端历史阅读层 ---- */
.term-view {
  position: relative; /* 供阅读层绝对覆盖 */
}
.sb-reader {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: var(--term-bg);
}
.sb-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-sunken);
}
.sb-hint {
  flex: 1;
  font-size: 12px;
  color: var(--ink-soft, #9a9286);
  text-align: center;
}
.sb-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding: 8px 10px calc(var(--safe-bottom) + 8px);
}
.sb-text {
  margin: 0;
  color: var(--term-fg, #e8e1d3);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.4;
  white-space: pre;
  user-select: text;
  -webkit-user-select: text;
}
.sb-cap {
  text-align: center;
  color: var(--ink-soft, #9a9286);
  font-size: 12px;
  padding: 4px 0 10px;
}
.sb-scroll::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.sb-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 6px;
}
.sb-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.sb-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
```

（`--term-bg`/`--term-fg`/`--font-mono`/`--safe-bottom` 等变量沿用 tokens.css；若 `--ink-soft` 不存在，CSS 回退色已给。）

- [ ] **Step 3: 构建确认**

Run: `npm -w @rcc/web run typecheck && npm -w @rcc/web run build`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/ScrollbackReader.tsx apps/web/src/index.css
git commit -m "feat(web): ScrollbackReader 原生历史阅读层(懒加载+反向无限滚动保持位置+干净复制)"
```

---

### Task 9: web — Terminal 接入「滚到顶自动进入阅读层」

**Files:**
- Modify: `apps/web/src/components/Terminal.tsx`

- [ ] **Step 1: 引入 reader 状态与组件**

`Terminal.tsx` 顶部加导入：

```ts
import { ScrollbackReader } from './ScrollbackReader';
```

在组件内 `const [connected, setConnected] = useState(false);` 旁加：

```ts
  const [readerOpen, setReaderOpen] = useState(false);
```

- [ ] **Step 2: 在 term-host 上监听向上滚动手势（wheel + 触摸）打开阅读层**

在 `term.open` 后的 effect 里、`ro.observe(...)` 之前插入：

```ts
    // 实时终端走 tmux 全屏、xterm 无本地 scrollback；向上滚动手势 → 打开原生阅读层。
    const host = hostRef.current!;
    let wheelAcc = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        wheelAcc += e.deltaY;
        if (wheelAcc < -80) {
          wheelAcc = 0;
          setReaderOpen(true);
        }
      } else {
        wheelAcc = 0;
      }
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchY > 56) setReaderOpen(true);
    };
    host.addEventListener('wheel', onWheel, { passive: true, capture: true });
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: true });
```

并在该 effect 的 cleanup（`return () => { ... }`）里追加移除：

```ts
      host.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
```

- [ ] **Step 3: 渲染阅读层覆盖（在 `.term-view` 内、`return` 的 JSX 末尾、最外层 `</div>` 之前）**

```tsx
      {readerOpen && (
        <ScrollbackReader
          projectId={project.id}
          convId={conversation.id}
          onClose={() => setReaderOpen(false)}
        />
      )}
```

- [ ] **Step 4: 构建确认**

Run: `npm -w @rcc/web run typecheck && npm -w @rcc/web run build`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/Terminal.tsx
git commit -m "feat(web): 终端向上滚动手势(wheel/触摸)自动进入历史阅读层"
```

---

### Task 10: 全量回归 + 真实冒烟

**Files:** 无（验证）

- [ ] **Step 1: 全量单测 + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: 全部 PASS（server/shared 测试含新用例；三个 workspace typecheck 通过；web 构建通过）

- [ ] **Step 2: 真实冒烟（tmux 端到端）**

起一个 `tmux -L rcc` 会话灌足量行，手动验证 `scrollback` 端点分页与 `-J` 合并、`trimEnd`：

```bash
SOCK=rcc; S=smoke_sb
tmux -L $SOCK new-session -d -s $S -x 80 -y 24
tmux -L $SOCK send-keys -t $S 'for i in $(seq 1 500); do echo "ROW_$i ..............."; done' Enter
sleep 1
tmux -L $SOCK display-message -p -t $S '#{history_size} #{pane_height}'
# 用与路由相同的行号区间手测最新窗与更早窗，确认行内容连续无重叠/无多余换行
tmux -L $SOCK capture-pane -p -J -t $S -S -776 -E 23 | tail -3   # 视实际 history_size 调整
tmux -L $SOCK kill-session -t $S
```

- [ ] **Step 3: 真实页面冒烟（按 CLAUDE.md 重启服务后手测）**

```bash
./start.sh   # 改了前端，需重新构建；不丢会话
```

手测清单：① 终端实时滚动顺滑、右侧无丑滚动条；② 向上滚动到顶自动进入阅读层、滚动如网页；③ 阅读层选一段复制**不带多余换行**、可一键复制全部；④ 滚到顶懒加载更早、位置不跳；⑤ 切回实时、切到聊天视图、`--resume` 均不回归。

- [ ] **Step 4: 收尾提交（如有冒烟修复）**

```bash
git add -A && git commit -m "test: 终端原生滚动/复制 真实冒烟验证与微调"
```

---

## 自检（spec 覆盖）

- 滚动卡 → Task 6 WebGL + Task 8 原生 `<pre>` 滚动。✓
- 复制带换行 → Task 4 `-J`+trimEnd、Task 8 原生选区、Task 7 快捷键复制。✓
- 丑滚动条 → Task 6 隐藏 xterm 滚动条 + Task 8 阅读层细滚动条。✓
- 懒加载 → Task 2 窗口换算 + Task 4 窗口端点 + Task 8 反向无限滚动。✓
- 滚到顶自动切 → Task 9。✓
- 不替换 tmux / 不动实时 WS / 不动聊天 → 全程增量，实时字节流未改。✓
- TDD（server/shared 纯逻辑）+ 真实冒烟 → Task 1-4、Task 10。✓
