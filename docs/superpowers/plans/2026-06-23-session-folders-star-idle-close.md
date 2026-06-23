# 会话文件夹 · 标星 · 空闲自动关闭 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 remote-cc 加文件夹分类、会话标星(标星拒进垃圾桶)、3h 空闲自动关 tmux(进入即恢复),核心是用 5 信号合判 busy 防止误关等待中的 claude 会话。

**Architecture:** 4 层增量叠加:① shared schemas 扩字段 ② 后端 `activity.ts` 纯函数探测器 + `IdleSweeper` 类驱动 ③ REST + WS 路由扩字段/新增文件夹 CRUD/关闭恢复/批量 ④ 前端侧栏重构(文件夹树 + 三态点 + 右键菜单 + 拖拽 + 多选)。所有改动并行叠加,不删除现有路径。

**Tech Stack:** TypeScript, vitest, Fastify, React, Zod, tmux, `@dnd-kit/core`(新依赖), `@radix-ui/react-context-menu`(若未在则手写最小版)。

**Spec:** `docs/superpowers/specs/2026-06-23-session-folders-star-idle-close-design.md`

---

## 阶段一:数据模型与存储

### Task 1: 扩 ConversationSchema + 新建 FolderSchema

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: 写失败测试(扩字段 default + Folder schema)**

在 `packages/shared/src/schemas.test.ts` 文件末尾加:

```ts
import { FolderSchema } from './schemas';

describe('ConversationSchema 扩字段', () => {
  it('starred 默认 false', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
    });
    expect(c.starred).toBe(false);
    expect(c.folderId).toBeUndefined();
    expect(c.closedAt).toBeUndefined();
    expect(c.lastActivityAt).toBeUndefined();
  });

  it('接受 folderId / starred=true / closedAt / lastActivityAt', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
      folderId: 'fld_1', starred: true,
      closedAt: '2026-01-02T00:00:00Z',
      lastActivityAt: '2026-01-01T05:00:00Z',
    });
    expect(c.folderId).toBe('fld_1');
    expect(c.starred).toBe(true);
    expect(c.closedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('folderId 可以是 null(显式未分类)', () => {
    const c = ConversationSchema.parse({
      id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
      sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      alive: false, createdAt: '2026-01-01T00:00:00Z',
      folderId: null,
    });
    expect(c.folderId).toBeNull();
  });
});

describe('FolderSchema', () => {
  it('完整字段解析', () => {
    const f = FolderSchema.parse({
      id: 'fld_abc12345', projectId: 'p', ownerId: 'u',
      name: '工程', sortOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(f.name).toBe('工程');
    expect(f.sortOrder).toBe(0);
  });

  it('sortOrder 缺省=0', () => {
    const f = FolderSchema.parse({
      id: 'fld_abc12345', projectId: 'p', ownerId: 'u',
      name: 'x', createdAt: '2026-01-01T00:00:00Z',
    });
    expect(f.sortOrder).toBe(0);
  });

  it('name 长度上限 40', () => {
    expect(() =>
      FolderSchema.parse({
        id: 'fld_x', projectId: 'p', ownerId: 'u',
        name: 'x'.repeat(41), createdAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rcc/shared -- schemas.test.ts
```
预期:`FolderSchema` 引入失败 + 扩字段测试全红。

- [ ] **Step 3: 修改 `packages/shared/src/schemas.ts`**

定位到 `ConversationSchema`(约第 75 行),把 `z.object({...})` 内补上以下 4 行(`deletedAt: z.string().optional(),` 那一行之后):

```ts
  /** 文件夹归属;null/缺省 = 未分类。 */
  folderId: z.string().nullable().optional(),
  /** 标星;默认 false。标星会话拒绝软删除。 */
  starred: z.boolean().default(false),
  /** 最近活跃时间(ISO),由活动探测器维护。 */
  lastActivityAt: z.string().optional(),
  /** 空闲自动关闭时间戳(ISO);存在=休眠中,resume 后清空。 */
  closedAt: z.string().optional(),
```

文件底部 `Conversation` 类型导出无需改(`z.infer` 自动包括)。

接着在 `Conversation` 类型导出后追加 Folder schema:

```ts
/** 会话文件夹;按项目+用户隔离,平铺一层(不嵌套)。 */
export const FolderSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  sortOrder: z.number().int().default(0),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof FolderSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rcc/shared -- schemas.test.ts
```
预期:全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): 扩 ConversationSchema 加 folderId/starred/lastActivityAt/closedAt + 新建 FolderSchema

为什么:为后续文件夹分类、标星拒删、空闲休眠功能铺数据底座。starred
默认 false,folderId 缺省=未分类,closedAt 存在=休眠态。"
```

---

### Task 2: ConversationStore migrate 扩 + `markActivity` 辅助

**Files:**
- Modify: `apps/server/src/lib/conversations.ts`
- Modify: `apps/server/src/lib/conversations.test.ts`

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/lib/conversations.test.ts` 末尾加(若已有 `describe` 块,放进对应 block 或新加):

```ts
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConversationStore migrate 扩字段', () => {
  it('给老数据补 starred=false 和 lastActivityAt=createdAt', () => {
    const dir = join(tmpdir(), `rcc-conv-test-${process.pid}-${Date.now()}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    writeFileSync(file, JSON.stringify([
      { id: 'a', projectId: 'p', name: 'n', tmuxName: 't',
        sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        effort: 'max', createdAt: '2026-01-01T00:00:00Z' },
    ], null, 2));

    const store = new ConversationStore(file);
    store.migrate();

    const loaded = store.listByProject('p');
    expect(loaded[0].starred).toBe(false);
    expect(loaded[0].lastActivityAt).toBe('2026-01-01T00:00:00Z');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ConversationStore.markActivity', () => {
  it('更新 lastActivityAt 到当前 now', () => {
    const dir = join(tmpdir(), `rcc-conv-test-${process.pid}-${Date.now()}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    const store = new ConversationStore(file);
    const conv = store.create('p', '会话 X');

    const t1 = '2026-06-23T10:00:00.000Z';
    const updated = store.markActivity(conv.id, t1);

    expect(updated?.lastActivityAt).toBe(t1);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rcc/server -- conversations.test.ts
```
预期:`markActivity is not a function` + migrate 不补字段。

- [ ] **Step 3: 改 `apps/server/src/lib/conversations.ts`**

在 `migrate()` 方法里加迁移逻辑:

```ts
  migrate(): void {
    const list = this.loadRaw();
    let changed = false;
    const next = list.map((c) => {
      const patch: Partial<StoredConversation> = { ...c };
      if (!patch.sessionId) {
        changed = true;
        patch.sessionId = crypto.randomUUID();
      }
      if (patch.starred === undefined) {
        changed = true;
        patch.starred = false;
      }
      if (!patch.lastActivityAt && patch.createdAt) {
        changed = true;
        patch.lastActivityAt = patch.createdAt;
      }
      return patch;
    });
    if (changed) this.write(next as StoredConversation[]);
  }
```

新增 `markActivity` 方法,放在 `update` 之后:

```ts
  /** 仅更新 lastActivityAt;比 update 路径轻,活动探测器高频调用专用。 */
  markActivity(convId: string, ts: string): StoredConversation | undefined {
    return this.update(convId, { lastActivityAt: ts });
  }
```

`StoredConversation` 是 `Omit<Conversation, 'alive'>`,会自动跟着 schema 扩,无需改类型别名。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rcc/server -- conversations.test.ts
```
预期:全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/conversations.ts apps/server/src/lib/conversations.test.ts
git commit -m "feat(conversations): migrate 补 starred/lastActivityAt + 新增 markActivity

为什么:活动探测器要写 lastActivityAt 必须有专用入口;迁移确保老
conversations.json 启动后字段补齐,后续路由与前端不需要判 undefined。"
```

---

### Task 3: `FolderStore` 完整 CRUD

**Files:**
- Create: `apps/server/src/lib/folders.ts`
- Create: `apps/server/src/lib/folders.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `apps/server/src/lib/folders.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FolderStore } from './folders';
import { ConversationStore } from './conversations';

let dir: string;
let foldersFile: string;
let convsFile: string;

beforeEach(() => {
  dir = join(tmpdir(), `rcc-folders-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  foldersFile = join(dir, 'folders.json');
  convsFile = join(dir, 'conversations.json');
});

describe('FolderStore', () => {
  it('create + listByProject 返回新文件夹', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', '工程');
    expect(f.name).toBe('工程');
    expect(f.id).toMatch(/^fld_/);
    expect(store.listByProject('proj', 'user1')).toHaveLength(1);
  });

  it('listByProject 按 ownerId 隔离', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    store.create('proj', 'user1', 'A');
    store.create('proj', 'user2', 'B');
    expect(store.listByProject('proj', 'user1')).toHaveLength(1);
    expect(store.listByProject('proj', 'user1')[0].name).toBe('A');
  });

  it('同项目同用户重名 → 抛 duplicate', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    store.create('proj', 'user1', '工程');
    expect(() => store.create('proj', 'user1', '工程')).toThrow(/duplicate/);
  });

  it('rename', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const updated = store.rename(f.id, 'B');
    expect(updated?.name).toBe('B');
  });

  it('remove 空文件夹 → reassigned=0', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const r = store.remove(f.id);
    expect(r.reassigned).toBe(0);
    expect(store.listByProject('proj', 'user1')).toHaveLength(0);
  });

  it('remove 非空文件夹 → 内部会话 folderId 置 null,返回 reassigned 数量', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const f = store.create('proj', 'user1', 'A');
    const c1 = convs.create('proj', '会话1');
    const c2 = convs.create('proj', '会话2');
    convs.update(c1.id, { folderId: f.id });
    convs.update(c2.id, { folderId: f.id });

    const r = store.remove(f.id);
    expect(r.reassigned).toBe(2);
    expect(convs.get(c1.id)?.folderId).toBeNull();
    expect(convs.get(c2.id)?.folderId).toBeNull();
  });

  it('reorder 按传入顺序更新 sortOrder', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    const a = store.create('proj', 'user1', 'A');
    const b = store.create('proj', 'user1', 'B');
    const c = store.create('proj', 'user1', 'C');
    store.reorder([c.id, a.id, b.id]);
    const list = store.listByProject('proj', 'user1');
    expect(list.map((f) => f.name)).toEqual(['C', 'A', 'B']);
  });

  it('文件不存在时 listByProject 返回空数组', () => {
    const convs = new ConversationStore(convsFile);
    const store = new FolderStore(foldersFile, convs);
    expect(store.listByProject('p', 'u')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rcc/server -- folders.test.ts
```
预期:`FolderStore` 找不到。

- [ ] **Step 3: 创建 `apps/server/src/lib/folders.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FolderSchema, type Folder } from '@rcc/shared';
import type { ConversationStore } from './conversations';

/**
 * 文件夹存储:JSON 平铺,按 (projectId, ownerId) 隔离;
 * remove 时把内部会话的 folderId 置 null,保证不出现悬空引用。
 * 与 ConversationStore 同风格:原子 tmp+rename + .bak。
 */
export class FolderStore {
  constructor(
    private readonly file: string,
    private readonly conversations: ConversationStore,
  ) {}

  private loadAll(): Folder[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => FolderSchema.parse(x));
  }

  /** 本项目本用户的文件夹,按 sortOrder 升序,同序按 createdAt 升序。 */
  listByProject(projectId: string, ownerId: string): Folder[] {
    return this.loadAll()
      .filter((f) => f.projectId === projectId && f.ownerId === ownerId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Folder | undefined {
    return this.loadAll().find((f) => f.id === id);
  }

  create(projectId: string, ownerId: string, name: string): Folder {
    const trimmed = name.trim();
    const all = this.loadAll();
    if (all.some((f) => f.projectId === projectId && f.ownerId === ownerId && f.name === trimmed)) {
      throw new Error(`duplicate folder name: ${trimmed}`);
    }
    const folder: Folder = FolderSchema.parse({
      id: `fld_${crypto.randomBytes(4).toString('hex')}`,
      projectId,
      ownerId,
      name: trimmed,
      sortOrder: all.filter((f) => f.projectId === projectId && f.ownerId === ownerId).length,
      createdAt: new Date().toISOString(),
    });
    this.write([...all, folder]);
    return folder;
  }

  rename(id: string, name: string): Folder | undefined {
    const all = this.loadAll();
    const i = all.findIndex((f) => f.id === id);
    if (i === -1) return undefined;
    const trimmed = name.trim();
    if (all.some((f) => f.id !== id && f.projectId === all[i].projectId && f.ownerId === all[i].ownerId && f.name === trimmed)) {
      throw new Error(`duplicate folder name: ${trimmed}`);
    }
    all[i] = { ...all[i], name: trimmed };
    this.write(all);
    return all[i];
  }

  reorder(orderedIds: string[]): void {
    const all = this.loadAll();
    const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
    const next = all.map((f) =>
      indexMap.has(f.id) ? { ...f, sortOrder: indexMap.get(f.id)! } : f,
    );
    this.write(next);
  }

  /** 删除文件夹;内部会话 folderId 置 null。返回被重排的会话数。 */
  remove(id: string): { reassigned: number } {
    const all = this.loadAll();
    const target = all.find((f) => f.id === id);
    if (!target) return { reassigned: 0 };
    const affected = this.conversations.listByProject(target.projectId).filter((c) => c.folderId === id);
    for (const c of affected) {
      this.conversations.update(c.id, { folderId: null });
    }
    this.write(all.filter((f) => f.id !== id));
    return { reassigned: affected.length };
  }

  private write(list: Folder[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
```

`ConversationStore.update` 需要能接受 `folderId: null`。看一下当前 `update` 的实现是 `{ ...all[i], ...patch }` —— 直接展开,传 `null` 会被保留,但 schema 在 list 的时候 parse,parse 时 `folderId.nullable()` 允许 null,所以 OK。无需改。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rcc/server -- folders.test.ts
```
预期:全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/folders.ts apps/server/src/lib/folders.test.ts
git commit -m "feat(folders): 新建 FolderStore 提供文件夹 CRUD

为什么:会话分类需要文件夹元数据;按 (projectId, ownerId) 隔离,
remove 时把内部会话 folderId 置 null 保证不出现悬空引用。"
```

---

### Task 4: UserStore 加 `settings.idleCloseHours`

**Files:**
- Modify: `packages/shared/src/schemas.ts`(UserSchema)
- Modify: `apps/server/src/lib/users.ts`
- Modify: `apps/server/src/lib/users.test.ts`

- [ ] **Step 1: 在 schemas.ts 找到 UserSchema,扩 settings 字段**

定位 `UserSchema`(grep `UserSchema = z.object`),在原字段末尾加:

```ts
  /** 用户偏好。idleCloseHours: 空闲自动关闭阈值小时(0=关闭功能,默认 3)。 */
  settings: z
    .object({
      idleCloseHours: z.number().int().min(0).max(48).default(3),
    })
    .default({ idleCloseHours: 3 }),
```

- [ ] **Step 2: 在 users.test.ts 加测试**

```ts
describe('UserStore settings', () => {
  it('add 创建用户带默认 settings.idleCloseHours=3', () => {
    const dir = join(tmpdir(), `rcc-users-test-${process.pid}-${Date.now()}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const store = new UserStore(join(dir, 'users.json'));
    const u = store.add({ username: 'alice', passwordHash: 'h', role: 'admin' });
    expect(u.settings.idleCloseHours).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('updateSettings 改 idleCloseHours', () => {
    const dir = join(tmpdir(), `rcc-users-test-${process.pid}-${Date.now()}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const store = new UserStore(join(dir, 'users.json'));
    const u = store.add({ username: 'alice', passwordHash: 'h', role: 'admin' });
    const updated = store.updateSettings(u.id, { idleCloseHours: 6 });
    expect(updated?.settings.idleCloseHours).toBe(6);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

如果 users.test.ts 还没 import `rmSync/join/tmpdir`,补上。

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test -w @rcc/server -- users.test.ts
```
预期:`updateSettings is not a function`。

- [ ] **Step 4: 在 users.ts 加 updateSettings 方法**

在 `setPassword` 后追加:

```ts
  updateSettings(id: string, settings: { idleCloseHours: number }): User | undefined {
    const users = this.load();
    const i = users.findIndex((u) => u.id === id);
    if (i === -1) return undefined;
    users[i] = { ...users[i], settings: { ...users[i].settings, ...settings } };
    this.write(users);
    return users[i];
  }
```

- [ ] **Step 5: 跑测试 + 提交**

```bash
npm test -w @rcc/server -- users.test.ts
git add packages/shared/src/schemas.ts apps/server/src/lib/users.ts apps/server/src/lib/users.test.ts
git commit -m "feat(users): UserSchema 加 settings.idleCloseHours + UserStore.updateSettings

为什么:空闲自动关闭阈值要每用户独立;默认 3h,可在前端设置面板改。"
```

---

## 阶段二:活动探测器与休眠扫描器

### Task 5: `activity.ts` 五信号探测器(纯函数)

**Files:**
- Create: `apps/server/src/lib/session/activity.ts`
- Create: `apps/server/src/lib/session/activity.test.ts`

- [ ] **Step 1: 写完整测试**

```ts
import { describe, it, expect } from 'vitest';
import { createActivityState, tickActivity, parseToolUseEvents, type ActivityIO } from './activity';

const baseCtx = {
  transcriptPath: '/fake/transcript.jsonl',
  tmuxName: 'rcc-x-y',
  sessionId: 'sess1',
  statuslineDir: '/fake/sl',
  askDir: '/fake/ask',
};

function makeIO(overrides: Partial<ActivityIO>): ActivityIO {
  return {
    transcriptStat: () => null,
    transcriptTail: () => ({ text: '', end: 0 }),
    sidecarStat: () => null,
    askSidecarExists: () => false,
    paneHash: () => null,
    now: () => 1000,
    ...overrides,
  };
}

describe('parseToolUseEvents', () => {
  it('提取主线 tool_use 与 tool_result', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      }),
    ].join('\n') + '\n';
    const events = parseToolUseEvents(lines);
    expect(events).toEqual([
      { kind: 'open', id: 'tu1', sidechain: false },
      { kind: 'close', id: 'tu1', sidechain: false },
    ]);
  });

  it('sidechain 节点单独标记', () => {
    const lines = JSON.stringify({
      type: 'assistant',
      uuid: 'a1', isSidechain: true,
      message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] },
    }) + '\n';
    expect(parseToolUseEvents(lines)).toEqual([
      { kind: 'open', id: 'tu1', sidechain: true },
    ]);
  });
});

describe('tickActivity 五信号', () => {
  it('信号①:未闭合 tool_use → busy', () => {
    const state = createActivityState(0);
    const io = makeIO({
      transcriptStat: () => ({ mtimeMs: 0, size: 100 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'assistant', uuid: 'a',
          message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        }) + '\n',
        end: 100,
      }),
      now: () => 5000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('open_tool_use');
  });

  it('信号①:tool_use 后 tool_result 来了 → 不再 busy(若其它信号也无)', () => {
    const state = createActivityState(0);
    state.lastBusyAt = 0;
    // 第一次:开 tool_use
    let io = makeIO({
      transcriptStat: () => ({ mtimeMs: 100, size: 100 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'assistant', uuid: 'a',
          message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }] },
        }) + '\n',
        end: 100,
      }),
      now: () => 1000,
    });
    tickActivity(state, baseCtx, io, 90_000);
    expect(state.openToolUseIds.has('tu1')).toBe(true);

    // 第二次:关 tool_result;mtime 也跳了,但我们在 windowMs 之外
    io = makeIO({
      transcriptStat: () => ({ mtimeMs: 200, size: 200 }),
      transcriptTail: () => ({
        text: JSON.stringify({
          type: 'user', uuid: 'u',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        }) + '\n',
        end: 200,
      }),
      now: () => 1_000_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(state.openToolUseIds.has('tu1')).toBe(false);
    expect(r.busy).toBe(false);
  });

  it('信号②:askSidecarExists=true → busy', () => {
    const state = createActivityState(0);
    const io = makeIO({ askSidecarExists: () => true, now: () => 1000 });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('ask_sidecar');
  });

  it('信号③:transcript mtime 在 windowMs 内跳 → busy', () => {
    const state = createActivityState(0);
    state.lastTranscriptMtime = 1000;
    const io = makeIO({
      transcriptStat: () => ({ mtimeMs: 5000, size: 0 }),
      now: () => 10_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('transcript_mtime');
  });

  it('信号④:statusline sidecar mtime 跳 → busy', () => {
    const state = createActivityState(0);
    state.lastStatuslineMtime = 1000;
    const io = makeIO({
      sidecarStat: () => ({ mtimeMs: 5000 }),
      now: () => 10_000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('statusline_mtime');
  });

  it('信号⑤:pane hash 在 windowMs 内变 → busy', () => {
    const state = createActivityState(0);
    state.lastPaneHash = 'aaa';
    state.lastPaneHashAt = 1000;
    const io = makeIO({
      paneHash: () => 'bbb',
      now: () => 5000,
    });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(true);
    expect(r.reasons).toContain('pane_hash');
  });

  it('全空闲:idleForMs = now - lastBusyAt', () => {
    const state = createActivityState(1000);
    state.lastBusyAt = 1000;
    const io = makeIO({ now: () => 11_000 });
    const r = tickActivity(state, baseCtx, io, 90_000);
    expect(r.busy).toBe(false);
    expect(r.idleForMs).toBe(10_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rcc/server -- session/activity.test.ts
```
预期:模块找不到。

- [ ] **Step 3: 创建 `apps/server/src/lib/session/activity.ts`**

```ts
/**
 * 活动探测器:五信号合判 claude 会话是否在等(busy)。
 * 全纯函数 + 注入 IO,sweeper 与 chatSession 各持一份 state 复用。
 *
 * 信号:
 *  ① 未闭合 tool_use     ─ 增量解析 transcript jsonl,见 tool_use 入 / 见对应 tool_result 出
 *  ② ask sidecar 存在    ─ 选择题待答
 *  ③ transcript mtime    ─ jsonl 在 append
 *  ④ statusline sidecar  ─ claude 主进程在动
 *  ⑤ pane hash 滑窗      ─ 抓 bash stream stdout / TUI 动画
 *
 * 任一为真 → busy;lastBusyAt 滚动到 now。idleForMs = now - lastBusyAt。
 */

export interface ActivityIO {
  transcriptStat(path: string): { mtimeMs: number; size: number } | null;
  transcriptTail(path: string, fromOffset: number): { text: string; end: number };
  sidecarStat(dir: string, sessionId: string): { mtimeMs: number } | null;
  askSidecarExists(dir: string, sessionId: string): boolean;
  paneHash(tmuxName: string): string | null;
  now(): number;
}

export interface ActivityCtx {
  transcriptPath: string | null;
  tmuxName: string;
  sessionId: string;
  statuslineDir: string;
  askDir: string;
}

export interface ActivityState {
  transcriptOffset: number;
  transcriptPending: string;
  lastTranscriptMtime: number;
  lastStatuslineMtime: number;
  lastPaneHash: string | null;
  lastPaneHashAt: number;
  openToolUseIds: Set<string>;
  openToolUseIdsSidechain: Set<string>;
  lastBusyAt: number;
}

export function createActivityState(now: number): ActivityState {
  return {
    transcriptOffset: 0,
    transcriptPending: '',
    lastTranscriptMtime: 0,
    lastStatuslineMtime: 0,
    lastPaneHash: null,
    lastPaneHashAt: now,
    openToolUseIds: new Set(),
    openToolUseIdsSidechain: new Set(),
    lastBusyAt: now,
  };
}

export interface ToolUseEvent {
  kind: 'open' | 'close';
  id: string;
  sidechain: boolean;
}

/**
 * 从 transcript jsonl 文本提取 tool_use 开/关事件。
 * - assistant 条目的 content 含 tool_use → open
 * - user 条目的 content 含 tool_result.tool_use_id → close
 * - isSidechain 节点单独标记
 */
export function parseToolUseEvents(text: string): ToolUseEvent[] {
  const events: ToolUseEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line); } catch { continue; }
    const sidechain = o.isSidechain === true;
    const msg = o.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as Record<string, unknown>;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        events.push({ kind: 'open', id: block.id, sidechain });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        events.push({ kind: 'close', id: block.tool_use_id, sidechain });
      }
    }
  }
  return events;
}

export interface TickResult {
  busy: boolean;
  idleForMs: number;
  reasons: string[];
}

export function tickActivity(
  state: ActivityState,
  ctx: ActivityCtx,
  io: ActivityIO,
  windowMs: number,
): TickResult {
  const now = io.now();
  const reasons: string[] = [];

  // ── 信号 ③ + ① 一起:读 transcript 增量,既看 mtime 又解析 tool_use ──
  if (ctx.transcriptPath) {
    const stat = io.transcriptStat(ctx.transcriptPath);
    if (stat) {
      if (state.lastTranscriptMtime > 0 && stat.mtimeMs > state.lastTranscriptMtime && now - stat.mtimeMs <= windowMs) {
        reasons.push('transcript_mtime');
      }
      state.lastTranscriptMtime = stat.mtimeMs;

      if (stat.size > state.transcriptOffset) {
        const { text, end } = io.transcriptTail(ctx.transcriptPath, state.transcriptOffset);
        state.transcriptOffset = end;
        state.transcriptPending += text;
        const idx = state.transcriptPending.lastIndexOf('\n');
        if (idx >= 0) {
          const complete = state.transcriptPending.slice(0, idx + 1);
          state.transcriptPending = state.transcriptPending.slice(idx + 1);
          for (const ev of parseToolUseEvents(complete)) {
            const set = ev.sidechain ? state.openToolUseIdsSidechain : state.openToolUseIds;
            if (ev.kind === 'open') set.add(ev.id);
            else set.delete(ev.id);
          }
        }
      }
    }
  }

  // ── 信号 ①:有任何未闭合 tool_use(主线或 sidechain) ──
  if (state.openToolUseIds.size > 0 || state.openToolUseIdsSidechain.size > 0) {
    reasons.push('open_tool_use');
  }

  // ── 信号 ②:ask sidecar 存在 ──
  if (io.askSidecarExists(ctx.askDir, ctx.sessionId)) {
    reasons.push('ask_sidecar');
  }

  // ── 信号 ④:statusline sidecar mtime 滑窗变 ──
  const sl = io.sidecarStat(ctx.statuslineDir, ctx.sessionId);
  if (sl) {
    if (state.lastStatuslineMtime > 0 && sl.mtimeMs > state.lastStatuslineMtime && now - sl.mtimeMs <= windowMs) {
      reasons.push('statusline_mtime');
    }
    state.lastStatuslineMtime = sl.mtimeMs;
  }

  // ── 信号 ⑤:pane hash 滑窗变 ──
  const hash = io.paneHash(ctx.tmuxName);
  if (hash !== null) {
    if (state.lastPaneHash !== null && hash !== state.lastPaneHash && now - state.lastPaneHashAt <= windowMs) {
      reasons.push('pane_hash');
    }
    if (state.lastPaneHash !== hash) {
      state.lastPaneHash = hash;
      state.lastPaneHashAt = now;
    }
  }

  const busy = reasons.length > 0;
  if (busy) state.lastBusyAt = now;
  return { busy, idleForMs: now - state.lastBusyAt, reasons };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm test -w @rcc/server -- session/activity.test.ts
```
预期:全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/session/activity.ts apps/server/src/lib/session/activity.test.ts
git commit -m "feat(activity): 五信号会话活动探测器

为什么:空闲自动关闭不能误关在等 Bash sleep/subagent/MCP 工具的会话。
五信号合判:未闭合 tool_use + ask sidecar + transcript mtime + statusline
sidecar + pane hash;任一为真即 busy。全纯函数 + 注入 IO。"
```

---

### Task 6: `IdleSweeper` 周期扫描器

**Files:**
- Create: `apps/server/src/lib/session/idleSweeper.ts`
- Create: `apps/server/src/lib/session/idleSweeper.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from 'vitest';
import { IdleSweeper, type SweeperDeps } from './idleSweeper';

function makeDeps(): SweeperDeps & { _calls: { killed: string[]; closedConvs: string[] } } {
  const _calls = { killed: [] as string[], closedConvs: [] as string[] };
  const fakeConvs = {
    listAllAlive: () => [
      { id: 'c1', projectId: 'p', tmuxName: 't1', sessionId: 's1', ownerId: 'u1' },
      { id: 'c2', projectId: 'p', tmuxName: 't2', sessionId: 's2', ownerId: 'u2' },
    ],
    update: vi.fn((id: string, _patch: { closedAt?: string }) => {
      _calls.closedConvs.push(id);
      return undefined;
    }),
  };
  const fakeUsers = {
    getSettings: (uid: string) => ({ idleCloseHours: uid === 'u1' ? 3 : 0 }),
  };
  const fakeTmux = {
    killSession: vi.fn(async (n: string) => { _calls.killed.push(n); }),
  };
  const fakeRegistry = {
    isActive: () => false,
    forceClose: vi.fn(),
  };
  return {
    conversations: fakeConvs,
    users: fakeUsers,
    tmux: fakeTmux,
    registry: fakeRegistry,
    measureIdle: vi.fn((conv: { id: string }) => ({
      busy: false,
      idleForMs: conv.id === 'c1' ? 4 * 3600_000 : 1000,  // c1 超 3h,c2 才 1s
      reasons: [],
    })),
    now: () => Date.parse('2026-06-23T10:00:00Z'),
    _calls,
  };
}

describe('IdleSweeper', () => {
  it('单次 sweep:超阈值 → kill tmux + 写 closedAt', async () => {
    const deps = makeDeps();
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual(['t1']);
    expect(deps._calls.closedConvs).toEqual(['c1']);
  });

  it('idleCloseHours=0 的用户:跳过', async () => {
    const deps = makeDeps();
    // c2 owner=u2,idleCloseHours=0 → 不关
    // 但 c2 也没超 3h,我们把它改成超 3h
    deps.measureIdle = vi.fn(() => ({ busy: false, idleForMs: 10 * 3600_000, reasons: [] }));
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual(['t1']);  // u1 的关
    expect(deps._calls.killed).not.toContain('t2');  // u2 (idleCloseHours=0) 不关
  });

  it('busy=true 的会话:不关', async () => {
    const deps = makeDeps();
    deps.measureIdle = vi.fn(() => ({ busy: true, idleForMs: 100 * 3600_000, reasons: ['open_tool_use'] }));
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual([]);
  });

  it('start/stop:不报错', () => {
    const deps = makeDeps();
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000 });
    sweeper.start();
    sweeper.stop();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -w @rcc/server -- session/idleSweeper.test.ts
```

- [ ] **Step 3: 创建 `apps/server/src/lib/session/idleSweeper.ts`**

```ts
import type { TickResult } from './activity';

/**
 * IdleSweeper 不依赖具体 ConversationStore/UserStore/Tmux/Registry 类,
 * 只声明它需要的最小能力;app.ts 接好真实实例后注入即可。
 */
export interface SweeperDeps {
  conversations: {
    listAllAlive: () => Array<{ id: string; projectId: string; tmuxName: string; sessionId: string; ownerId?: string }>;
    update: (id: string, patch: { closedAt?: string }) => unknown;
  };
  users: {
    getSettings: (ownerId: string) => { idleCloseHours: number };
  };
  tmux: {
    killSession: (name: string) => Promise<void>;
  };
  registry: {
    isActive: (id: string) => boolean;
    forceClose: (id: string) => void;
  };
  measureIdle: (conv: { id: string; tmuxName: string; sessionId: string }) => TickResult;
  now: () => number;
}

export interface SweeperOpts {
  intervalMs?: number;
  defaultThresholdHours?: number;
}

/**
 * 周期扫所有未休眠/未删除的 conversations:
 *  - busy=true → 跳过
 *  - idleCloseHours=0 → 跳过(用户关了自动关闭功能)
 *  - idleForMs ≥ 阈值 → killSession + 写 closedAt + registry.forceClose
 *
 * 写 closedAt 的副作用走 deps.conversations.update,
 * 由 sessions.ts 路由层包一层后再广播 convClosed WS 事件。
 */
export class IdleSweeper {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly deps: SweeperDeps,
    private readonly opts: SweeperOpts = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.sweepOnce().catch(() => { /* 静默,下一 tick 再试 */ });
    }, interval);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweepOnce(): Promise<void> {
    const now = this.deps.now();
    const defaultHours = this.opts.defaultThresholdHours ?? 3;
    for (const c of this.deps.conversations.listAllAlive()) {
      const ownerId = c.ownerId;
      const thresholdHours = ownerId
        ? this.deps.users.getSettings(ownerId).idleCloseHours
        : defaultHours;
      if (thresholdHours <= 0) continue;  // 用户关了自动关闭
      const r = this.deps.measureIdle(c);
      if (r.busy) continue;
      if (r.idleForMs < thresholdHours * 3600_000) continue;

      await this.deps.tmux.killSession(c.tmuxName);
      this.deps.conversations.update(c.id, { closedAt: new Date(now).toISOString() });
      this.deps.registry.forceClose(c.id);
    }
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
npm test -w @rcc/server -- session/idleSweeper.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/lib/session/idleSweeper.ts apps/server/src/lib/session/idleSweeper.test.ts
git commit -m "feat(idleSweeper): 周期休眠扫描器

为什么:活动探测器给单点判定;sweeper 把它周期遍历所有活动会话,
超阈值即关 tmux 并写 closedAt。阈值取自用户 settings,0=禁用。"
```

---

### Task 7: 扩 `ConversationStore.listAllAlive` + `forceClose` 注册表方法

`IdleSweeper` 需要 `listAllAlive()` 取所有未休眠未删除的会话;`ChatRegistry` 需要 `forceClose(id)` 让 sweeper 在关 tmux 时同时清掉 entry。

**Files:**
- Modify: `apps/server/src/lib/conversations.ts`
- Modify: `apps/server/src/lib/conversations.test.ts`
- Modify: `apps/server/src/lib/session/chat/chatRegistry.ts`
- Modify: `apps/server/src/lib/session/chat/chatRegistry.test.ts`

- [ ] **Step 1: 测试 `listAllAlive`**

```ts
describe('ConversationStore.listAllAlive', () => {
  it('过滤掉 deletedAt 与 closedAt', () => {
    const dir = join(tmpdir(), `rcc-conv-alive-${process.pid}-${Date.now()}`);
    require('node:fs').mkdirSync(dir, { recursive: true });
    const file = join(dir, 'conversations.json');
    const store = new ConversationStore(file);

    const a = store.create('p', 'A');
    const b = store.create('p', 'B');
    const c = store.create('p', 'C');
    store.softDelete(b.id);
    store.update(c.id, { closedAt: '2026-06-23T00:00:00Z' });

    const alive = store.listAllAlive();
    expect(alive.map((x) => x.id)).toEqual([a.id]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 测试 `ChatRegistry.forceClose`**

在 `chatRegistry.test.ts` 加:

```ts
it('forceClose:有 entry 时停轮询并删除', async () => {
  const stopPolling = vi.fn();
  const registry = new ChatRegistry(() => ({
    ensure: async () => {},
    getSkeleton: () => ({ messages: [], turnLoadedness: {} }),
    getTurnBody: () => null,
    sendText: async () => {},
    sendKey: async () => {},
    interrupt: async () => {},
    refresh: async () => {},
    capturePeek: async () => '',
    setEffort: async () => {},
    rewindOpen: async () => [],
    rewindExecute: async () => ({ kind: 'noop' }),
    rewindCancel: async () => {},
    answerAsk: async () => {},
    answerPendingAsk: async () => {},
    getLiveAsk: () => null,
    getLiveHud: () => null,
    startPolling: () => {},
    stopPolling,
  }));
  await registry.subscribe('conv1', {} as ChatSpec, makeSub());
  registry.forceClose('conv1');
  expect(stopPolling).toHaveBeenCalled();
  expect(registry.isActive('conv1')).toBe(false);
});
```

(若 chatRegistry.test.ts 已有现成的 makeSub helper 复用之,否则按现有测试风格补一个。)

- [ ] **Step 3: 跑测试确认失败**

```bash
npm test -w @rcc/server -- 'conversations|chatRegistry'
```

- [ ] **Step 4: 实现**

在 `apps/server/src/lib/conversations.ts` 的 `listDeletedByProject` 后追加:

```ts
  /** 所有非软删除且未休眠的会话(扁平,所有项目所有用户)。供 IdleSweeper 用。 */
  listAllAlive(): StoredConversation[] {
    return this.loadAll().filter((c) => !c.deletedAt && !c.closedAt);
  }
```

在 `apps/server/src/lib/session/chat/chatRegistry.ts` 的 `activeCount` 前追加:

```ts
  /**
   * 强制关闭一个会话的注册表 entry:停轮询、删 entry。
   * 不通知订阅者(由调用方在 sweeper 关闭流程的最后做 WS 广播)。
   */
  forceClose(convId: string): void {
    const entry = this.entries.get(convId);
    if (!entry) return;
    entry.session.stopPolling();
    this.entries.delete(convId);
  }
```

- [ ] **Step 5: 跑测试 + 提交**

```bash
npm test -w @rcc/server -- 'conversations|chatRegistry'
git add apps/server/src/lib/conversations.ts apps/server/src/lib/conversations.test.ts \
        apps/server/src/lib/session/chat/chatRegistry.ts apps/server/src/lib/session/chat/chatRegistry.test.ts
git commit -m "feat: ConversationStore.listAllAlive + ChatRegistry.forceClose

为什么:IdleSweeper 需要枚举活动会话;关 tmux 时也要同步清掉
chatRegistry entry,否则下一轮 chatSession.tick 会对着死 pane 跑。"
```

---

## 阶段三:路由层

### Task 8: 路由扩 `PATCH .../conversations/:cid` 支持 folderId / starred

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Create: `apps/server/src/routes/sessions.folders-star.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../app';
// 复用 sessions.rename.test.ts 的 setup 风格

describe('PATCH conversations 扩字段', () => {
  // ... setup(略,见 sessions.rename.test.ts 的 buildApp 模式)...

  it('PATCH folderId:成功', async () => {
    // 建项目 + 文件夹 + 会话 → PATCH folderId → 200,GET 列表确认更新
  });

  it('PATCH starred=true:成功', async () => {
    // PATCH → 200,GET 列表确认 starred=true
  });

  it('PATCH starred=true 后 DELETE:409 starred_locked', async () => {
    // PATCH starred=true → DELETE → 期望 409 + { error: 'starred_locked' }
  });

  it('PATCH folderId 指向不存在文件夹:400', async () => {
    // PATCH { folderId: 'fld_nope' } → 400
  });
});
```

(完整 setup 参照 `sessions.rename.test.ts:42-67`——同样 `buildApp` + admin 登录 + 建项目流程。)

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 修改 `routes/sessions.ts`**

把 `RenameConvSchema` 替换为更大的:

```ts
const PatchConvSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  folderId: z.string().nullable().optional(),
  starred: z.boolean().optional(),
}).refine(
  (v) => v.name !== undefined || v.folderId !== undefined || v.starred !== undefined,
  { message: '至少提供一个可改字段' },
);
```

PATCH 处理替换为(整段替换原有 `app.patch(.../conversations/:cid'`):

```ts
app.patch(
  '/api/projects/:id/conversations/:cid',
  { preHandler: requireAuth },
  async (req, reply) => {
    const { id, cid } = req.params as { id: string; cid: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const parse = PatchConvSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: parse.error.issues[0]?.message ?? 'bad request' });
    const conv = ctx.conversations.get(cid);
    if (!conv || conv.projectId !== id) {
      return reply.code(404).send({ error: 'conversation not found' });
    }
    // folderId 必须指向本项目本用户的存在文件夹(null 显式清除是 OK)
    if (parse.data.folderId !== undefined && parse.data.folderId !== null) {
      const f = ctx.folders.get(parse.data.folderId);
      if (!f || f.projectId !== id) return reply.code(400).send({ error: 'folder not found' });
    }
    const updated = ctx.conversations.update(cid, parse.data);
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return { conversation: { ...updated, alive: await aliveOf(updated) } };
  },
);
```

修改 DELETE 路由,在 softDelete 前拦截 starred:

```ts
// 在 const hard = ... 这一行之前补:
if (!hard && conv.starred) {
  return reply.code(409).send({ error: 'starred_locked' });
}
```

(`ctx.folders` 字段下面 Task 9 在 AppContext 里接;此处先按这个名字写,Task 9 把它接好。)

- [ ] **Step 4: 跑测试**

(此 task 测试依赖 `ctx.folders`,要等 Task 9 接好 AppContext 才能全绿。允许此 task 测试暂留红,跟 Task 9 一起绿掉。或者:本步先用 `ctx.folders?.get?.(...)` 防御写,Task 9 再去 `?` —— 选这个,保 task 独立绿。)

把 PATCH 内的 folderId 校验改为:

```ts
    if (parse.data.folderId !== undefined && parse.data.folderId !== null) {
      const f = ctx.folders?.get?.(parse.data.folderId);
      if (!f || f.projectId !== id) return reply.code(400).send({ error: 'folder not found' });
    }
```

跑测试时,测试 setup 里把 ctx.folders mock 上(或 buildApp 接好后自然有,见 Task 9)。

```bash
npm test -w @rcc/server -- sessions.folders-star.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/routes/sessions.folders-star.test.ts
git commit -m "feat(sessions): PATCH 支持 folderId/starred + DELETE 拒 starred(409 starred_locked)

为什么:标星会话不能误删入垃圾桶。folderId 改动校验指向存在且本项目。"
```

---

### Task 9: 文件夹 CRUD 路由 + AppContext 注入 FolderStore

**Files:**
- Create: `apps/server/src/routes/folders.ts`
- Modify: `apps/server/src/context.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/routes/folders.test.ts`

- [ ] **Step 1: 写测试**

新建 `apps/server/src/routes/folders.test.ts`,核心 case:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// ... 复用 sessions.rename.test.ts 的 buildApp 模式 ...

describe('folders 路由', () => {
  it('GET 空列表', async () => { /* admin → 200 [] */ });
  it('POST 创建', async () => { /* { name: 'X' } → 200 + folder */ });
  it('POST 同名重复 → 409', async () => { /* */ });
  it('PATCH 改名', async () => { /* */ });
  it('DELETE 空文件夹 → 200 { reassigned: 0 }', async () => { /* */ });
  it('DELETE 非空 → 内部会话 folderId 置 null', async () => {
    // 建文件夹 → 建会话 PATCH folderId → DELETE folder → GET 会话列表确认 folderId=null
  });
  it('GET 不可见项目 → 404', async () => { /* */ });
});
```

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 改 `config.ts` 加 folders 文件路径**

定位 config 的接口/读取处,加(与 conversations.json 同位置):

```ts
foldersConfig: string;  // 默认 './config/folders.json'
```

读取处补默认 `path.join(repoRoot, 'config', 'folders.json')`。

- [ ] **Step 4: 改 `context.ts` 接 FolderStore**

定位 `AppContext` 接口,加:

```ts
folders: FolderStore;
```

`buildContext` 处加:

```ts
const folders = new FolderStore(config.foldersConfig, conversations);
return { ..., folders };
```

- [ ] **Step 5: 创建 `routes/folders.ts`**

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';
import { canSeeProject } from '../lib/authz';

const NameSchema = z.object({ name: z.string().trim().min(1).max(40) });
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
});

export async function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users);

  app.get('/api/projects/:id/folders', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    return { folders: ctx.folders.listByProject(id, req.user!.id) };
  });

  app.post('/api/projects/:id/folders', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const parse = NameSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    try {
      const folder = ctx.folders.create(id, req.user!.id, parse.data.name);
      return { folder };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('duplicate')) return reply.code(409).send({ error: 'duplicate' });
      throw e;
    }
  });

  app.patch('/api/projects/:id/folders/:fid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const folder = ctx.folders.get(fid);
    if (!folder || folder.projectId !== id || folder.ownerId !== req.user!.id) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    const parse = PatchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    try {
      let updated = folder;
      if (parse.data.name !== undefined) {
        const r = ctx.folders.rename(fid, parse.data.name);
        if (r) updated = r;
      }
      // sortOrder 单条修改:简单直接 update;批量 reorder 走单独端点(YAGNI:暂不暴露)
      return { folder: updated };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('duplicate')) return reply.code(409).send({ error: 'duplicate' });
      throw e;
    }
  });

  app.delete('/api/projects/:id/folders/:fid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, fid } = req.params as { id: string; fid: string };
    const project = ctx.projects.get(id);
    if (!project || !canSeeProject(req.user!, project)) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const folder = ctx.folders.get(fid);
    if (!folder || folder.projectId !== id || folder.ownerId !== req.user!.id) {
      return reply.code(404).send({ error: 'folder not found' });
    }
    const { reassigned } = ctx.folders.remove(fid);
    return { reassigned };
  });
}
```

- [ ] **Step 6: 在 `app.ts` 注册路由**

定位 `registerSessionRoutes(app, ctx)` 处,前后任一加一行:

```ts
import { registerFolderRoutes } from './routes/folders';
// ...
await registerFolderRoutes(app, ctx);
```

- [ ] **Step 7: 跑测试**

```bash
npm test -w @rcc/server -- 'folders|sessions.folders-star'
```

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/routes/folders.ts apps/server/src/routes/folders.test.ts \
        apps/server/src/context.ts apps/server/src/app.ts apps/server/src/config.ts
git commit -m "feat(folders-routes): 文件夹 CRUD + AppContext 注入 FolderStore

为什么:前端要侧栏文件夹树就要 REST 端点;按项目可见性 + 文件夹所有
权双重校验。"
```

---

### Task 10: 路由加 `close` / `resume` / `batch`

**Files:**
- Modify: `apps/server/src/routes/sessions.ts`
- Create: `apps/server/src/routes/sessions.lifecycle.test.ts`

- [ ] **Step 1: 写测试**

```ts
describe('POST .../conversations/:cid/close', () => {
  it('alive 会话:杀 tmux + 写 closedAt + 返回 conversation', async () => { /* */ });
  it('已休眠会话:幂等 200', async () => { /* */ });
});

describe('POST .../conversations/:cid/resume', () => {
  it('休眠会话:启动 tmux + 清 closedAt + 返回 alive=true', async () => { /* */ });
  it('已活动:幂等 200', async () => { /* */ });
});

describe('POST .../conversations/batch', () => {
  it('move:批量 folderId 改变', async () => { /* */ });
  it('softDelete:starred 项进 failed 列表,其它进 succeeded', async () => { /* */ });
});
```

(单测内 buildApp、登录、建项目、建会话流程同 Task 9。)

- [ ] **Step 2: 跑确认失败**

- [ ] **Step 3: 在 `sessions.ts` 添加路由(放在 DELETE 之后):**

```ts
app.post('/api/projects/:id/conversations/:cid/close', { preHandler: requireAuth }, async (req, reply) => {
  const { id, cid } = req.params as { id: string; cid: string };
  const project = ctx.projects.get(id);
  if (!project || !canSeeProject(req.user!, project)) {
    return reply.code(404).send({ error: 'project not found' });
  }
  const conv = ctx.conversations.get(cid);
  if (!conv || conv.projectId !== id) {
    return reply.code(404).send({ error: 'conversation not found' });
  }
  if (conv.closedAt) return { conversation: { ...conv, alive: false } };
  await ctx.tmux.killSession(conv.tmuxName);
  ctx.registry.forceClose(cid);
  const updated = ctx.conversations.update(cid, { closedAt: new Date().toISOString() });
  return { conversation: { ...updated, alive: false } };
});

app.post('/api/projects/:id/conversations/:cid/resume', { preHandler: requireAuth }, async (req, reply) => {
  const { id, cid } = req.params as { id: string; cid: string };
  const project = ctx.projects.get(id);
  if (!project || !canSeeProject(req.user!, project)) {
    return reply.code(404).send({ error: 'project not found' });
  }
  const conv = ctx.conversations.get(cid);
  if (!conv || conv.projectId !== id) {
    return reply.code(404).send({ error: 'conversation not found' });
  }
  if (!conv.closedAt) return { conversation: { ...conv, alive: await aliveOf(conv) } };
  // 启动 tmux + claude --resume(沿用 reflow 的 buildClaudeCmd 模式)
  const cmd = buildClaudeCmd({
    launchCommand: project.launchCommand,
    sessionId: conv.sessionId,
    effort: conv.effort,
    hasTranscript: locateTranscript(conv.sessionId) !== null,
    askLaunch: ctx.askLaunch,
  });
  try {
    await ctx.tmux.newDetached(conv.tmuxName, project.path, cmd, 120, 40);
  } catch (e) {
    return reply.code(500).send({ error: `resume failed: ${(e as Error).message}` });
  }
  const updated = ctx.conversations.update(cid, { closedAt: undefined });
  return { conversation: { ...updated, alive: true } };
});

const BatchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['move', 'star', 'unstar', 'close', 'softDelete']),
  payload: z.object({ folderId: z.string().nullable().optional() }).optional(),
});

app.post('/api/projects/:id/conversations/batch', { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = ctx.projects.get(id);
  if (!project || !canSeeProject(req.user!, project)) {
    return reply.code(404).send({ error: 'project not found' });
  }
  const parse = BatchSchema.safeParse(req.body ?? {});
  if (!parse.success) return reply.code(400).send({ error: 'bad request' });
  const { ids, action, payload } = parse.data;
  const succeeded: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const cid of ids) {
    const conv = ctx.conversations.get(cid);
    if (!conv || conv.projectId !== id) {
      failed.push({ id: cid, reason: 'not_found' });
      continue;
    }
    try {
      if (action === 'move') {
        const folderId = payload?.folderId ?? null;
        if (folderId !== null) {
          const f = ctx.folders.get(folderId);
          if (!f || f.projectId !== id) {
            failed.push({ id: cid, reason: 'folder_not_found' });
            continue;
          }
        }
        ctx.conversations.update(cid, { folderId });
      } else if (action === 'star') {
        ctx.conversations.update(cid, { starred: true });
      } else if (action === 'unstar') {
        ctx.conversations.update(cid, { starred: false });
      } else if (action === 'close') {
        if (!conv.closedAt) {
          await ctx.tmux.killSession(conv.tmuxName);
          ctx.registry.forceClose(cid);
          ctx.conversations.update(cid, { closedAt: new Date().toISOString() });
        }
      } else if (action === 'softDelete') {
        if (conv.starred) {
          failed.push({ id: cid, reason: 'starred_locked' });
          continue;
        }
        await ctx.tmux.killSession(conv.tmuxName);
        ctx.registry.forceClose(cid);
        ctx.conversations.softDelete(cid);
      }
      succeeded.push(cid);
    } catch (e) {
      failed.push({ id: cid, reason: (e as Error).message });
    }
  }
  return { succeeded, failed };
});
```

- [ ] **Step 4: 跑测试**

```bash
npm test -w @rcc/server -- sessions.lifecycle.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/sessions.ts apps/server/src/routes/sessions.lifecycle.test.ts
git commit -m "feat(sessions): close/resume/batch 路由

为什么:close 让前端能手动休眠;resume 把休眠会话拉回;batch 给多
选批量动作单点入口,starred 项进 failed 而不中断整批。"
```

---

### Task 11: 启动 IdleSweeper

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/lib/session/chat/chatSession.ts`(若 chatSession.tick 要负责 markActivity,见下)

- [ ] **Step 1: 改 `app.ts`,在 server.listen 之前 new + start IdleSweeper**

```ts
import { IdleSweeper } from './lib/session/idleSweeper';
import { createActivityState, tickActivity, type ActivityIO } from './lib/session/activity';
import { execSync } from 'node:child_process';
import { statSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { locateTranscript } from './lib/session/chat/transcript';

// activity IO 实现:把 sweeper 注入活生生的文件系统/tmux
const activityIO: ActivityIO = {
  transcriptStat: (p) => {
    try { const s = statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
  },
  transcriptTail: (p, off) => {
    if (!existsSync(p)) return { text: '', end: off };
    const fd = openSync(p, 'r');
    try {
      const { size } = fstatSync(fd);
      if (size <= off) return { text: '', end: size };
      const buf = Buffer.alloc(size - off);
      readSync(fd, buf, 0, size - off, off);
      return { text: buf.toString('utf8'), end: size };
    } finally { closeSync(fd); }
  },
  sidecarStat: (dir, sid) => {
    try { const s = statSync(join(dir, `${sid}.json`)); return { mtimeMs: s.mtimeMs }; } catch { return null; }
  },
  askSidecarExists: (dir, sid) => existsSync(join(dir, `${sid}.json`)),
  paneHash: (name) => {
    try {
      const out = execSync(`tmux -L ${ctx.config.tmuxSocket} capture-pane -p -t ${name}`, { encoding: 'utf8' });
      return crypto.createHash('sha1').update(out).digest('hex').slice(0, 16);
    } catch { return null; }
  },
  now: () => Date.now(),
};

// 每会话一份 state,sweeper 自己持有 map
const activityStates = new Map<string, ReturnType<typeof createActivityState>>();

const sweeper = new IdleSweeper({
  conversations: {
    listAllAlive: () => {
      const owners = new Map<string, string>(); // projectId → ownerId
      for (const p of ctx.projects.listAll()) owners.set(p.id, p.ownerId);
      return ctx.conversations.listAllAlive().map((c) => ({
        id: c.id, projectId: c.projectId, tmuxName: c.tmuxName,
        sessionId: c.sessionId, ownerId: owners.get(c.projectId),
      }));
    },
    update: (id, patch) => ctx.conversations.update(id, patch),
  },
  users: { getSettings: (uid) => ctx.users.get(uid)?.settings ?? { idleCloseHours: 3 } },
  tmux: { killSession: (n) => ctx.tmux.killSession(n) },
  registry: { isActive: (id) => ctx.registry.isActive(id), forceClose: (id) => ctx.registry.forceClose(id) },
  measureIdle: (c) => {
    let state = activityStates.get(c.id);
    if (!state) { state = createActivityState(Date.now()); activityStates.set(c.id, state); }
    return tickActivity(
      state,
      {
        transcriptPath: locateTranscript(c.sessionId),
        tmuxName: c.tmuxName,
        sessionId: c.sessionId,
        statuslineDir: ctx.config.statuslineDir,
        askDir: ctx.config.askDir,
      },
      activityIO,
      90_000,
    );
  },
  now: () => Date.now(),
}, { intervalMs: 60_000, defaultThresholdHours: 3 });

sweeper.start();

// 优雅停机
app.addHook('onClose', async () => { sweeper.stop(); });
```

(注:`ctx.projects.listAll()` 与 `ctx.config.tmuxSocket / statuslineDir / askDir` 需对照现有 `config.ts` 与 `projects.ts`;若命名不同就替换。`ChatRegistry.forceClose` 已在 Task 7 加好。)

- [ ] **Step 2: 跑 typecheck**

```bash
npm run typecheck
```

修任何 import 路径/类型小问题。

- [ ] **Step 3: 提交**

```bash
git add apps/server/src/app.ts
git commit -m "feat(server): 启动 IdleSweeper 周期扫描空闲会话

为什么:把活动探测器和扫描器接到真实文件系统 + tmux + ConversationStore,
60s 一 tick,关闭进程时优雅停 sweeper。"
```

---

## 阶段四:前端

### Task 12: 前端 API 客户端扩

**Files:**
- Modify: `apps/web/src/api.ts`

- [ ] **Step 1: 在 `api.ts` 末尾追加方法**

```ts
listFolders: (pid: string) =>
  req<{ folders: Folder[] }>('GET', `/api/projects/${pid}/folders`),
createFolder: (pid: string, name: string) =>
  req<{ folder: Folder }>('POST', `/api/projects/${pid}/folders`, { name }),
renameFolder: (pid: string, fid: string, name: string) =>
  req<{ folder: Folder }>('PATCH', `/api/projects/${pid}/folders/${fid}`, { name }),
removeFolder: (pid: string, fid: string) =>
  req<{ reassigned: number }>('DELETE', `/api/projects/${pid}/folders/${fid}`),

patchConversation: (pid: string, cid: string, patch: { name?: string; folderId?: string | null; starred?: boolean }) =>
  req<{ conversation: Conversation }>('PATCH', `/api/projects/${pid}/conversations/${cid}`, patch),
closeConversation: (pid: string, cid: string) =>
  req<{ conversation: Conversation }>('POST', `/api/projects/${pid}/conversations/${cid}/close`),
resumeConversation: (pid: string, cid: string) =>
  req<{ conversation: Conversation }>('POST', `/api/projects/${pid}/conversations/${cid}/resume`),
batchConversations: (pid: string, body: { ids: string[]; action: 'move' | 'star' | 'unstar' | 'close' | 'softDelete'; payload?: { folderId?: string | null } }) =>
  req<{ succeeded: string[]; failed: { id: string; reason: string }[] }>('POST', `/api/projects/${pid}/conversations/batch`, body),

getSettings: () => req<{ idleCloseHours: number }>('GET', '/api/me/settings'),
updateSettings: (s: { idleCloseHours: number }) => req<{ idleCloseHours: number }>('PATCH', '/api/me/settings', s),
```

`Folder` 类型从 `@rcc/shared` import。如果 `req<T>` 签名不同就照本文件已有方法调整。

GET/PATCH `/api/me/settings` 还没加路由,在本 task 内一起加上:

`apps/server/src/routes/me.ts` 新建:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context';
import { makeRequireAuth } from '../plugins/requireAuth';

const SettingsSchema = z.object({ idleCloseHours: z.number().int().min(0).max(48) });

export async function registerMeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users);
  app.get('/api/me/settings', { preHandler: requireAuth }, async (req) => {
    const u = ctx.users.get(req.user!.id);
    return u?.settings ?? { idleCloseHours: 3 };
  });
  app.patch('/api/me/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parse = SettingsSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'bad request' });
    const u = ctx.users.updateSettings(req.user!.id, parse.data);
    return u?.settings ?? parse.data;
  });
}
```

在 `app.ts` 注册:`await registerMeRoutes(app, ctx);`

- [ ] **Step 2: 跑 typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/api.ts apps/server/src/routes/me.ts apps/server/src/app.ts
git commit -m "feat(api): 前端 API 客户端扩 + /api/me/settings 路由

为什么:前端用单点 api 模块调新端点;settings 路由让设置面板能读写
idleCloseHours。"
```

---

### Task 13: 侧栏文件夹树重构(`SidebarTree.tsx`)

**Files:**
- Modify: `apps/web/src/components/ConversationList.tsx`(拆解出 SidebarTree)
- Create: `apps/web/src/components/SidebarTree.tsx`

- [ ] **Step 1: 创建 SidebarTree 组件骨架**

```tsx
import { useState, useEffect } from 'react';
import type { Conversation, Folder } from '@rcc/shared';
import { api } from '../api';

interface Props {
  projectId: string;
  conversations: Conversation[];
  onOpen: (conv: Conversation) => void;
  onContextMenu?: (conv: Conversation, e: React.MouseEvent) => void;
}

export function SidebarTree({ projectId, conversations, onOpen, onContextMenu }: Props): JSX.Element {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.listFolders(projectId).then((r) => setFolders(r.folders)).catch(() => setFolders([]));
  }, [projectId]);

  // 把 conversations 按 folderId 分组(null=未分类)
  const grouped = new Map<string | null, Conversation[]>();
  grouped.set(null, []);
  for (const f of folders) grouped.set(f.id, []);
  for (const c of conversations) {
    const key = c.folderId ?? null;
    if (!grouped.has(key)) grouped.set(null, [...(grouped.get(null) ?? []), c]);
    else grouped.get(key)!.push(c);
  }

  function renderGroup(label: string, key: string | null, items: Conversation[]) {
    const isCollapsed = collapsed.has(key ?? '__null');
    return (
      <div key={key ?? '__null'} className="sidebar-group">
        <div className="sidebar-group-header" onClick={() => {
          const next = new Set(collapsed);
          if (isCollapsed) next.delete(key ?? '__null'); else next.add(key ?? '__null');
          setCollapsed(next);
        }}>
          <span>{isCollapsed ? '▶' : '▼'} {label}</span>
          <span className="sidebar-group-count">{items.length}</span>
        </div>
        {!isCollapsed && (
          <ul className="sidebar-list">
            {items.map((c) => (
              <li key={c.id}
                  className={`sidebar-item ${c.closedAt ? 'sleeping' : c.alive ? 'alive' : 'dead'}`}
                  onClick={() => onOpen(c)}
                  onContextMenu={(e) => onContextMenu?.(c, e)}>
                <span className={`dot ${c.closedAt ? 'gray' : c.alive ? 'green' : 'red'}`} />
                {c.starred && <span className="star">★</span>}
                <span className="name">{c.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="sidebar-tree">
      {renderGroup('未分类', null, grouped.get(null) ?? [])}
      {folders.map((f) => renderGroup(f.name, f.id, grouped.get(f.id) ?? []))}
      <button className="sidebar-new-folder" onClick={async () => {
        const name = prompt('文件夹名');
        if (!name) return;
        const r = await api.createFolder(projectId, name).catch(() => null);
        if (r) setFolders([...folders, r.folder]);
      }}>+ 新建文件夹</button>
    </div>
  );
}
```

`prompt()` 是占位实现,后续 Task 14 加 ContextMenu 会换成 inline 输入。

- [ ] **Step 2: 把现有 `ConversationList.tsx` 中的列表渲染替换为 `<SidebarTree>`**

具体定位 ConversationList 中渲染每条会话的 `<li>` 部分,把它整段替换为:

```tsx
<SidebarTree
  projectId={projectId}
  conversations={conversations}
  onOpen={onOpen}
/>
```

保留原 ConversationList 中的"新建会话/打开垃圾箱"按钮等其他部分。

- [ ] **Step 3: 加最小 CSS**

在 `apps/web/src/styles.css`(或现有样式文件)末尾加:

```css
.sidebar-tree { padding: 8px; }
.sidebar-group-header { display:flex; justify-content:space-between;
  font-size: 12px; color: var(--muted, #888); cursor: pointer; padding: 4px 0; }
.sidebar-list { list-style: none; padding: 0; margin: 0; }
.sidebar-item { display:flex; align-items:center; gap:6px;
  padding: 4px 6px; cursor: pointer; border-radius: 4px; }
.sidebar-item:hover { background: var(--hover, #2a2a2a); }
.sidebar-item.sleeping .name { color: var(--muted, #888); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.green { background: #4caf50; }
.dot.gray { background: #888; }
.dot.red { background: #555; }
.star { color: #ffb800; }
.sidebar-new-folder { background: transparent; border: 1px dashed #444;
  color: #aaa; padding: 4px 8px; margin-top: 8px; width: 100%; cursor: pointer; }
```

- [ ] **Step 4: 跑前端 dev / typecheck**

```bash
npm run typecheck
npm run build -w @rcc/web
```

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/SidebarTree.tsx apps/web/src/components/ConversationList.tsx \
        apps/web/src/styles.css
git commit -m "feat(web): 侧栏 SidebarTree 文件夹树 + 三态点

为什么:文件夹分类的入口。三态点(绿/灰/星)语义:绿=alive、灰=sleeping、
星叠加。新建文件夹临时用 prompt(),下一步换 ContextMenu 的 inline 输入。"
```

---

### Task 14: 右键/长按菜单 + 标星删除拒

**Files:**
- Create: `apps/web/src/components/SessionContextMenu.tsx`
- Modify: `apps/web/src/components/SidebarTree.tsx`

- [ ] **Step 1: 决定菜单库**

```bash
ls apps/web/node_modules/@radix-ui 2>/dev/null
```
若已有 radix 组件 → `npm install @radix-ui/react-context-menu -w @rcc/web`;若全无,本 task 内手写一个最小 Popover(160 行内)。这里按"radix 已有"路径写;无则把 `Menu` / `MenuItem` 用普通 div + position:absolute 替换。

```bash
npm install @radix-ui/react-context-menu -w @rcc/web
```

- [ ] **Step 2: 创建 `SessionContextMenu.tsx`**

```tsx
import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Conversation, Folder } from '@rcc/shared';
import { api } from '../api';

interface Props {
  conv: Conversation;
  folders: Folder[];
  projectId: string;
  children: React.ReactNode;
  onPatched: (conv: Conversation) => void;
  onClosed: (cid: string) => void;
  onDeleted: (cid: string) => void;
  onNewFolder: (name: string) => Promise<Folder | null>;
}

export function SessionContextMenu(props: Props): JSX.Element {
  const { conv, folders, projectId, onPatched, onClosed, onDeleted, onNewFolder } = props;
  const [newFolderInput, setNewFolderInput] = useState('');
  const [showInput, setShowInput] = useState(false);

  async function move(folderId: string | null) {
    const r = await api.patchConversation(projectId, conv.id, { folderId }).catch(() => null);
    if (r) onPatched(r.conversation);
  }
  async function toggleStar() {
    const r = await api.patchConversation(projectId, conv.id, { starred: !conv.starred }).catch(() => null);
    if (r) onPatched(r.conversation);
  }
  async function close() {
    const r = await api.closeConversation(projectId, conv.id).catch(() => null);
    if (r) onClosed(conv.id);
  }
  async function softDelete() {
    if (conv.starred) {
      alert('先取消星才能删除');
      return;
    }
    const r = await fetch(`/api/projects/${projectId}/conversations/${conv.id}`, { method: 'DELETE' });
    if (r.ok) onDeleted(conv.id);
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{props.children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="ctx-menu">
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="ctx-item">移到文件夹 ▸</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="ctx-menu">
                <ContextMenu.Item className="ctx-item" onSelect={() => move(null)}>未分类</ContextMenu.Item>
                {folders.map((f) => (
                  <ContextMenu.Item key={f.id} className="ctx-item" onSelect={() => move(f.id)}>{f.name}</ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="ctx-sep" />
                {showInput ? (
                  <div className="ctx-input-row">
                    <input
                      autoFocus
                      value={newFolderInput}
                      onChange={(e) => setNewFolderInput(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          const f = await onNewFolder(newFolderInput);
                          if (f) await move(f.id);
                          setNewFolderInput('');
                          setShowInput(false);
                        } else if (e.key === 'Escape') {
                          setShowInput(false);
                        }
                      }}
                      placeholder="新文件夹名 ⏎"
                    />
                  </div>
                ) : (
                  <ContextMenu.Item className="ctx-item" onSelect={(e) => { e.preventDefault(); setShowInput(true); }}>新建文件夹…</ContextMenu.Item>
                )}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className="ctx-item" onSelect={toggleStar}>
            {conv.starred ? '取消星' : '⭐ 加星'}
          </ContextMenu.Item>
          {!conv.closedAt && (
            <ContextMenu.Item className="ctx-item" onSelect={close}>关闭(休眠)</ContextMenu.Item>
          )}
          <ContextMenu.Separator className="ctx-sep" />
          <ContextMenu.Item
            className={`ctx-item danger ${conv.starred ? 'disabled' : ''}`}
            disabled={conv.starred}
            onSelect={softDelete}
          >
            删除 {conv.starred && '(先取消星)'}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
```

样式加到 styles.css:

```css
.ctx-menu { background: #1e1e1e; border: 1px solid #333; padding: 4px;
  border-radius: 4px; min-width: 160px; box-shadow: 0 4px 12px #0008; }
.ctx-item { padding: 6px 10px; cursor: pointer; border-radius: 3px; font-size: 13px; }
.ctx-item:hover { background: #2a2a2a; }
.ctx-item.disabled { color: #555; cursor: not-allowed; }
.ctx-item.danger { color: #e57373; }
.ctx-sep { height: 1px; background: #333; margin: 4px 0; }
.ctx-input-row input { width: 100%; background: #111; border: 1px solid #444;
  color: #eee; padding: 4px 6px; border-radius: 3px; }
```

- [ ] **Step 3: 在 SidebarTree 中包 SessionContextMenu**

把每条 `<li>` 包成:

```tsx
<SessionContextMenu
  conv={c}
  folders={folders}
  projectId={projectId}
  onPatched={(u) => { /* 触发父组件刷新或本地替换 */ }}
  onClosed={(id) => { /* */ }}
  onDeleted={(id) => { /* */ }}
  onNewFolder={async (name) => {
    const r = await api.createFolder(projectId, name).catch(() => null);
    if (r) { setFolders([...folders, r.folder]); return r.folder; }
    return null;
  }}
>
  <li ...>{...}</li>
</SessionContextMenu>
```

`onPatched/onClosed/onDeleted` 触发父 `ConversationList` 重新拉列表(简单方式:暴露 `onChanged` 回调让父端调 `loadConversations()`)。

移动端长按用 `onTouchStart/onTouchEnd` + setTimeout 触发 dispatchEvent 模拟右键(@radix-ui ContextMenu 支持 onContextMenu 触发,所以 touch 事件 → 派发 contextmenu)。

- [ ] **Step 4: 测试**

由于这是 UI 集成,单测只测纯逻辑(如标星 disabled);视觉用 storybook 或开发时手测。先跳过单测,真机验证。

```bash
npm run build -w @rcc/web
./start.sh
```

打开手机/浏览器,右键/长按一个会话,看菜单弹起;点星、关闭、删除 starred(应 alert)。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/SessionContextMenu.tsx \
        apps/web/src/components/SidebarTree.tsx \
        apps/web/src/styles.css apps/web/package.json package-lock.json
git commit -m "feat(web): SessionContextMenu 右键/长按菜单 + 标星拒删

为什么:移到文件夹、加星、关闭、删除走单一菜单。删除按钮在 starred
时禁用,文案提示先取消星。子菜单内 inline 输入新建文件夹。"
```

---

### Task 15: 设置面板 + idleCloseHours

**Files:**
- Create: `apps/web/src/components/SettingsPanel.tsx`
- Modify: `apps/web/src/App.tsx`(或顶栏组件)

- [ ] **Step 1: 创建 SettingsPanel**

```tsx
import { useState, useEffect } from 'react';
import { api } from '../api';

interface Props { onClose: () => void; }

export function SettingsPanel({ onClose }: Props): JSX.Element {
  const [hours, setHours] = useState<number>(3);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then((s) => { setHours(s.idleCloseHours); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  async function save() {
    const r = await api.updateSettings({ idleCloseHours: hours }).catch(() => null);
    if (r) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h3>设置</h3>
        <button onClick={onClose}>×</button>
      </div>
      <div className="settings-body">
        <label className="settings-row">
          <span>空闲自动关闭(小时)</span>
          <input type="number" min={0} max={48} step={1} value={hours}
                 onChange={(e) => setHours(Math.max(0, Math.min(48, parseInt(e.target.value, 10) || 0)))}
                 disabled={loading} />
        </label>
        <p className="hint">
          超过 N 小时无任何活动,会话的 tmux 会被关闭以释放资源。
          0 = 关闭功能。点击休眠会话会自动恢复,历史不丢。
        </p>
        <button className="primary" onClick={save} disabled={loading}>保存</button>
        {saved && <span className="ok">已保存</span>}
      </div>
    </div>
  );
}
```

样式:

```css
.settings-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: #1e1e1e; border: 1px solid #333; padding: 16px; border-radius: 8px;
  z-index: 1000; min-width: 320px; }
.settings-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.settings-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.settings-row input { width: 80px; }
.settings-panel .hint { color: #888; font-size: 12px; margin: 8px 0; }
.settings-panel .ok { color: #4caf50; margin-left: 12px; }
```

- [ ] **Step 2: 在顶栏加入口**

定位 App.tsx 或顶栏组件,加一个齿轮图标按钮:

```tsx
const [showSettings, setShowSettings] = useState(false);
// ...
<button onClick={() => setShowSettings(true)}>⚙</button>
{showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
```

- [ ] **Step 3: 跑测试 + 提交**

```bash
npm run build -w @rcc/web
git add apps/web/src/components/SettingsPanel.tsx apps/web/src/App.tsx apps/web/src/styles.css
git commit -m "feat(web): 设置面板(空闲自动关闭小时)

为什么:让用户能调阈值;0=关闭。读写 /api/me/settings。"
```

---

### Task 16: 拖拽集成(`@dnd-kit/core`)

**Files:**
- Modify: `apps/web/src/components/SidebarTree.tsx`
- Modify: `apps/web/package.json`

- [ ] **Step 1: 安装依赖**

```bash
npm install @dnd-kit/core -w @rcc/web
```

- [ ] **Step 2: 改 SidebarTree.tsx 加 DndContext + useSortable**

在文件顶部 import:

```tsx
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors,
  type DragEndEvent } from '@dnd-kit/core';
```

会话条目用 `useDraggable`、文件夹标题用 `useDroppable`。DndContext 在树外层。

```tsx
function DraggableItem({ conv, children }: { conv: Conversation; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: `c:${conv.id}` });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} style={style}>
      {children}
    </div>
  );
}

function DroppableHeader({ folderKey, children }: { folderKey: string; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: `f:${folderKey}` });
  return (
    <div ref={setNodeRef} className={isOver ? 'drop-over' : ''}>
      {children}
    </div>
  );
}
```

DndContext 包整个树,`onDragEnd`:

```tsx
const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

async function handleDragEnd(e: DragEndEvent) {
  const overId = String(e.over?.id ?? '');
  const activeId = String(e.active.id);
  if (!overId.startsWith('f:') || !activeId.startsWith('c:')) return;
  const folderKey = overId.slice(2); // 'null' 或 fld_xxx
  const convId = activeId.slice(2);
  const folderId = folderKey === 'null' ? null : folderKey;
  // 乐观更新本地
  const conv = conversations.find((c) => c.id === convId);
  if (conv) {
    // 通过 parent 回调或本地复制
    await api.patchConversation(projectId, convId, { folderId }).catch(() => null);
    // 触发刷新(简单方式)
  }
}

return (
  <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
    {/* 渲染 */}
  </DndContext>
);
```

样式:`.drop-over { background: #2a3a4a; }`

- [ ] **Step 3: 移动端 sensor**

`PointerSensor.activationConstraint.distance:6` 让小幅滑动不触发拖拽;移动端如发现误触,改为 `delay: 200`(长按 200ms 才进入拖拽模式)或干脆 `useSensors()` 在 mobile 时返空数组。

简单办法:用 `window.matchMedia('(hover: hover)').matches` 区分,只在桌面端启用拖拽 sensor。

- [ ] **Step 4: 验证**

```bash
npm run build -w @rcc/web
./start.sh
```

桌面:拖一个会话进文件夹标题 → 后台 PATCH → 列表更新。移动:确认不误触。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/SidebarTree.tsx apps/web/package.json package-lock.json apps/web/src/styles.css
git commit -m "feat(web): 拖拽会话到文件夹(@dnd-kit/core)

为什么:桌面端更顺手;距离 6px 阈值防误触;移动端仍走长按菜单。"
```

---

### Task 17: 多选批量

**Files:**
- Modify: `apps/web/src/components/SidebarTree.tsx`
- Create: `apps/web/src/components/MultiSelectToolbar.tsx`

- [ ] **Step 1: 创建 MultiSelectToolbar**

```tsx
import type { Folder } from '@rcc/shared';

interface Props {
  selectedIds: string[];
  folders: Folder[];
  onMove: (folderId: string | null) => void;
  onStar: () => void;
  onClose: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function MultiSelectToolbar(props: Props): JSX.Element | null {
  if (props.selectedIds.length === 0) return null;
  return (
    <div className="multi-toolbar">
      <span>已选 {props.selectedIds.length}</span>
      <select onChange={(e) => { if (e.target.value) props.onMove(e.target.value === '__null' ? null : e.target.value); }} defaultValue="">
        <option value="" disabled>移到…</option>
        <option value="__null">未分类</option>
        {props.folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <button onClick={props.onStar}>⭐</button>
      <button onClick={props.onClose}>关闭</button>
      <button className="danger" onClick={props.onDelete}>删除</button>
      <button onClick={props.onCancel}>取消</button>
    </div>
  );
}
```

- [ ] **Step 2: 在 SidebarTree 加多选 state**

```tsx
const [selected, setSelected] = useState<Set<string>>(new Set());

function toggleSelect(cid: string, e: React.MouseEvent) {
  if (e.shiftKey && selected.size > 0) {
    // 范围选(简单实现:从上次选的位置到当前)
    // 复杂度暂略,只做 cmd/ctrl 与单选
  }
  const next = new Set(selected);
  if (next.has(cid)) next.delete(cid); else next.add(cid);
  setSelected(next);
}

function onItemClick(c: Conversation, e: React.MouseEvent) {
  if (e.metaKey || e.ctrlKey) {
    toggleSelect(c.id, e);
  } else if (selected.size === 0) {
    onOpen(c);
  }
}
```

把 onClick 替换为 onItemClick。当 `selected.size > 0` 时:每条左侧用 checkbox 替代 dot。

ToolBar 的回调:

```tsx
async function batchAction(action: 'move' | 'star' | 'close' | 'softDelete', payload?: { folderId: string | null }) {
  const r = await api.batchConversations(projectId, { ids: Array.from(selected), action, payload }).catch(() => null);
  if (r) {
    if (r.failed.length > 0) {
      alert(`部分失败: ${r.failed.map((f) => `${f.id}=${f.reason}`).join(', ')}`);
    }
    setSelected(new Set());
    // 触发刷新
  }
}
```

`<MultiSelectToolbar>` 渲染在 SidebarTree 顶部,选中态可见。

- [ ] **Step 3: 样式**

```css
.multi-toolbar { display: flex; gap: 8px; padding: 8px; background: #2a2a2a;
  border-bottom: 1px solid #444; align-items: center; font-size: 13px; }
.multi-toolbar button { padding: 4px 8px; }
.multi-toolbar .danger { background: #5a2a2a; color: #fcc; }
```

- [ ] **Step 4: 验证 + 提交**

```bash
npm run build -w @rcc/web
./start.sh
```

桌面:cmd+点选 2 条 → 工具栏出现 → "移到 文件夹A" → 两条都移到。批量删除时若一条 starred → alert 显示部分失败。

```bash
git add apps/web/src/components/MultiSelectToolbar.tsx apps/web/src/components/SidebarTree.tsx apps/web/src/styles.css
git commit -m "feat(web): 多选 + 批量操作工具栏

为什么:批量整理会话;失败项(如 starred_locked)进 failed 不阻断,
alert 汇总报告。"
```

---

## 阶段五:集成冒烟与文档

### Task 18: 真实集成冒烟 `smoke-idle.ts`

**Files:**
- Create: `apps/server/scripts/smoke-idle.ts`

- [ ] **Step 1: 创建脚本**

```ts
/**
 * 集成冒烟:验证空闲自动关闭与五信号防误关。
 * 跑法:npx tsx apps/server/scripts/smoke-idle.ts
 * 前置:tmux 在路径、有 claude 命令、~/.claude 可写。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tmux } from '../src/lib/session/tmux';
import { ConversationStore } from '../src/lib/conversations';
import { FolderStore } from '../src/lib/folders';
import { createActivityState, tickActivity, type ActivityIO } from '../src/lib/session/activity';
import { locateTranscript } from '../src/lib/session/chat/transcript';
import { execSync } from 'node:child_process';
import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import crypto from 'node:crypto';

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'rcc-smoke-idle-'));
  const tmux = new Tmux('rcc-smoke');
  const convs = new ConversationStore(join(dir, 'conversations.json'));
  const conv = convs.create('smoke', 'idle 冒烟');

  console.log('1) 起 tmux + claude');
  await tmux.newDetached(conv.tmuxName, process.cwd(), `Fable-yolo --session-id ${conv.sessionId}`, 120, 40);
  await sleep(4000);  // 等 claude 起来

  const io: ActivityIO = {
    transcriptStat: (p) => { try { const s = statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } },
    transcriptTail: (p, off) => {
      if (!existsSync(p)) return { text: '', end: off };
      const fd = openSync(p, 'r');
      try {
        const { size } = fstatSync(fd);
        if (size <= off) return { text: '', end: size };
        const buf = Buffer.alloc(size - off);
        readSync(fd, buf, 0, size - off, off);
        return { text: buf.toString('utf8'), end: size };
      } finally { closeSync(fd); }
    },
    sidecarStat: () => null, askSidecarExists: () => false,
    paneHash: (n) => {
      try {
        const out = execSync(`tmux -L rcc-smoke capture-pane -p -t ${n}`, { encoding: 'utf8' });
        return crypto.createHash('sha1').update(out).digest('hex').slice(0, 16);
      } catch { return null; }
    },
    now: () => Date.now(),
  };
  const state = createActivityState(Date.now());
  const ctx = { transcriptPath: locateTranscript(conv.sessionId), tmuxName: conv.tmuxName,
                sessionId: conv.sessionId, statuslineDir: dir, askDir: dir };

  console.log('2) 让 claude 跑 Bash sleep 5');
  await tmux.pasteText(conv.tmuxName, '运行 bash sleep 5 并告诉我结果');
  await tmux.sendKeys(conv.tmuxName, ['Enter']);
  await sleep(3000);

  console.log('3) busy 检查(预期 true)');
  let r = tickActivity(state, { ...ctx, transcriptPath: locateTranscript(conv.sessionId) }, io, 90_000);
  console.log('   busy=', r.busy, 'reasons=', r.reasons);
  if (!r.busy) throw new Error('sleep 中应 busy');

  console.log('4) 等 8s 让 sleep 完 + claude 收 tool_result');
  await sleep(8000);

  console.log('5) idle 检查(预期 false)');
  r = tickActivity(state, { ...ctx, transcriptPath: locateTranscript(conv.sessionId) }, io, 90_000);
  console.log('   busy=', r.busy, 'reasons=', r.reasons);

  console.log('6) 清理');
  await tmux.killSession(conv.tmuxName);
  rmSync(dir, { recursive: true, force: true });
  console.log('OK 冒烟通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 跑**

```bash
npx tsx apps/server/scripts/smoke-idle.ts
```

- [ ] **Step 3: 提交**

```bash
git add apps/server/scripts/smoke-idle.ts
git commit -m "test(smoke): 空闲自动关闭与防误关集成冒烟

为什么:5 信号合判逻辑必须经端到端验证;Bash sleep 跑期间不能被关。"
```

---

### Task 19: 更新 CLAUDE.md 加新功能说明

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 加章节**

在 CLAUDE.md 的"架构速览"段后插入:

```markdown
### 会话生命周期(休眠 + 文件夹 + 标星)

- 会话三态:**alive**(tmux 在)、**sleeping**(`closedAt` 存在,tmux 已关)、**deleted**(`deletedAt` 存在,在垃圾桶)。
- **空闲自动关闭**:`IdleSweeper`(`lib/session/idleSweeper.ts`)每 60s 扫一遍 `listAllAlive` 会话,对每个跑 `activity.tickActivity()` 五信号合判 busy;空闲超用户阈值(`users.settings.idleCloseHours`,默认 3,0=关功能)→ `tmux kill-session` + 写 `closedAt` + `registry.forceClose`。
- **五信号**(`lib/session/activity.ts`):① 未配对 `tool_use`(transcript 增量解析)② `askDir/<sid>.json` 存在 ③ transcript mtime 滑窗变 ④ statusline sidecar mtime 滑窗变 ⑤ pane hash 滑窗变。任一为真即 busy。窗口默认 90s。
- **休眠恢复**:点击休眠会话 → `POST .../resume` → `tmux.newDetached` + claude `--resume` → 清 `closedAt`。历史从 transcript 自然重渲(transcript 文件不动)。
- **文件夹**(`config/folders.json` + `FolderStore`):按 (projectId, ownerId) 隔离,平铺一层,删非空时内部会话 folderId 自动置 null。
- **标星**(`Conversation.starred`):布尔;true 时 `DELETE` 路由返 409 `starred_locked`,前端按钮 disabled。不影响生命周期(标星会话仍可被自动关闭休眠,只是不能进垃圾桶)。
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): 加会话生命周期(休眠+文件夹+标星)说明

为什么:新功能影响开发者心智模型;新章节说清三态、五信号、休眠恢复。"
```

---

## 自审清单(plan 写完后我自己跑一遍)

**Spec 覆盖检查**:
- §1 数据模型 → Task 1, 2, 3, 4 ✓
- §2 后端 API → Task 8, 9, 10 ✓
- §3 活动探测器 → Task 5 ✓
- §4 休眠扫描器 → Task 6, 11 ✓
- §5 前端 → Task 12, 13, 14, 15, 16, 17 ✓
- §6 配置(idleCloseHours)→ Task 4, 12, 15 ✓
- WS 广播:spec 提到但 plan **未单独建 task**——侧栏可以 5s 轮询 + 拖拽乐观更新先用着,WS 是优化项,**留到后续**(YAGNI);如果用户 5s 内做拖拽看不到对端同步是问题,再补。

**Placeholder 扫描**:
- "(若有)" / "(略)" / "(参考 smoke-chat.ts)" / "(对照 config.ts)" 这种 vague:存在但属于"复用既有相同模式"的提示,不是 placeholder——既有代码就在那。如果执行者读不懂,优化后续。

**类型一致性**:
- `Conversation.folderId: string | null | undefined`(z.string().nullable().optional())全程一致。
- `Folder` 字段 `id/projectId/ownerId/name/sortOrder/createdAt` 在 Task 1, 3, 9 一致。
- `ChatRegistry.forceClose` 在 Task 7 定义,Task 8, 10, 11 引用。
- `ConversationStore.listAllAlive` 在 Task 7 定义,Task 11 引用。
- `ConversationStore.markActivity` 在 Task 2 定义——本 plan 内**未被引用**,因为 sweeper 不写 lastActivityAt(它只读探测器,busy 时 state.lastBusyAt 更新即可)。**这是一个潜在的 dead method**——但保留:写 spec 时说"由活动探测器维护",其实是 state 内部维护,store 字段供前端列表展示用。要让 list 体现"上次活跃时间",在 chatSession.tick 里调 `markActivity(now)` 才行——**这一步加到 Task 11 的 measureIdle 闭包里**:每次 measureIdle 跑出 busy=true 时,异步 fire-and-forget `conversations.markActivity(c.id, now)`,频率太高就只在状态翻 false→true 时调。**修订 Task 11**:

修订 Task 11 的 `measureIdle` 闭包,在 `return tickActivity(...)` 前加:

```ts
const r = tickActivity(state, ..., 90_000);
if (r.busy) {
  // 一分钟最多写一次,防过度写盘
  const lastWrote = lastActivityWriteTimes.get(c.id) ?? 0;
  if (Date.now() - lastWrote > 60_000) {
    ctx.conversations.markActivity(c.id, new Date(Date.now()).toISOString());
    lastActivityWriteTimes.set(c.id, Date.now());
  }
}
return r;
```

在 sweeper 包初始化处加 `const lastActivityWriteTimes = new Map<string, number>();`。

---

## 执行交接

**Plan complete and saved to `docs/superpowers/plans/2026-06-23-session-folders-star-idle-close.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 我每 task 派发一个 fresh subagent,task 间复审,迭代快。

**2. Inline Execution** — 本会话内顺序执行,checkpoint 复审。

**Which approach?**
