# 多用户 unix 隔离 + 子用户 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 remote-cc 从"单 unix 用户跑全部 claude"升级成"每个 rcc 主账号绑一个真 unix 用户 + 子用户挂在主账号下 + sudo 包装命令实现 uid 隔离"。

**Architecture:** schema 加 `unixUser` + 新增 `SubUserStore`;新增 `runAs(unixUser, file, args)` 单注入点,当目标 unix === ServiceUser 时零开销直 exec、否则拼 `sudo -nH -u`;`Tmux` 实例化绑 unixUser 派生 socket;`AppContext` 暴露 `getTmux(unixUser)` / `askLaunchFor(unixUser)`;路由 `req.user.namespaceId` 替代 `req.user.id`;sidecar / FS browse root 按 unix 用户分子目录。

**Tech Stack:** TypeScript / Fastify / zod / vitest / argon2 / react / node-pty / tmux / sudo

> 仓库背景:`apps/server`(Fastify 后端,vitest 测试与源码共置)、`apps/web`(React + Vite)、`packages/shared`(zod schema)。重启服务用 `./start.sh`(改前端) / `./start.sh --no-build`(只改后端);改完必须重启,本服务非热更新。`npm test` 跑全栈测试。

---

## 阶段 1:Schema 扩展(共享类型)

### Task 1:UserSchema 加 `unixUser` 字段

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.test.ts`(若已存在则追加;否则新建)

- [ ] **Step 1: 写 failing test**

在 `packages/shared/src/schemas.test.ts` 追加(若文件不存在则新建,顶部 `import { describe, it, expect } from 'vitest'; import { UserSchema } from './schemas';`):

```typescript
describe('UserSchema with unixUser', () => {
  it('accepts user with unixUser', () => {
    const u = UserSchema.parse({
      id: 'u1',
      username: 'alice',
      passwordHash: 'h',
      role: 'user',
      createdAt: '2026-06-23T00:00:00Z',
      unixUser: 'alice',
    });
    expect(u.unixUser).toBe('alice');
  });

  it('accepts user without unixUser (legacy compat)', () => {
    const u = UserSchema.parse({
      id: 'u1',
      username: 'alice',
      passwordHash: 'h',
      role: 'user',
      createdAt: '2026-06-23T00:00:00Z',
    });
    expect(u.unixUser).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:第一条 fail(`Unrecognized key(s) in object: 'unixUser'` 或 `unixUser: undefined`),第二条 pass。

- [ ] **Step 3: 改 UserSchema**

在 `packages/shared/src/schemas.ts` 的 `UserSchema = z.object({...})` 块里,在 `createdAt: z.string(),` 之后、`settings:` 之前插入:

```typescript
  /** 绑定的本机 unix 用户名(必填语义在路由层强制;schema 上 optional 以兼容存量)。 */
  unixUser: z.string().min(1).optional(),
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:两条全 pass。

- [ ] **Step 5: commit**

```
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): UserSchema 加 unixUser 字段(optional 兼容存量)"
```

---

### Task 2:新增 `SubUserSchema`

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: 写 failing test**

追加:

```typescript
import { SubUserSchema } from './schemas';

describe('SubUserSchema', () => {
  it('round-trips a valid subuser', () => {
    const s = SubUserSchema.parse({
      id: 's1',
      parentId: 'u1',
      username: 'alice_dev',
      passwordHash: 'h',
      displayName: '开发',
      createdAt: '2026-06-23T00:00:00Z',
    });
    expect(s.parentId).toBe('u1');
    expect(s.settings.idleCloseHours).toBe(3); // 默认值
  });

  it('rejects displayName too long', () => {
    expect(() =>
      SubUserSchema.parse({
        id: 's1',
        parentId: 'u1',
        username: 'alice_dev',
        passwordHash: 'h',
        displayName: 'x'.repeat(41),
        createdAt: '2026-06-23T00:00:00Z',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:`SubUserSchema is not exported`。

- [ ] **Step 3: 加 SubUserSchema**

在 `packages/shared/src/schemas.ts` 末尾、`UserSchema` 之后追加:

```typescript
/**
 * 子用户:挂在主账号下,独立用户名/口令登录,unix 身份继承父(不可改),
 * 资源 namespace 是自己 id(与父独立)。同 unix 下子用户互相在 unix 层零隔离。
 */
export const SubUserSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  displayName: z.string().min(1).max(40),
  createdAt: z.string(),
  settings: z
    .object({
      idleCloseHours: z.number().int().min(0).max(48).default(3),
    })
    .default({ idleCloseHours: 3 }),
});
export type SubUser = z.infer<typeof SubUserSchema>;
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:两条全 pass。

- [ ] **Step 5: commit**

```
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): 加 SubUserSchema(parentId/独立口令/独立 settings)"
```

---

### Task 3:扩展 `AuthUserSchema`(加 kind/parentId/unixUser/namespaceId)

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: 写 failing test**

追加:

```typescript
import { AuthUserSchema } from './schemas';

describe('AuthUserSchema extended', () => {
  it('accepts a primary user shape', () => {
    const a = AuthUserSchema.parse({
      id: 'u1',
      username: 'alice',
      role: 'user',
      kind: 'user',
      unixUser: 'alice',
      namespaceId: 'u1',
    });
    expect(a.kind).toBe('user');
    expect(a.parentId).toBeUndefined();
  });

  it('accepts a subuser shape with parentId', () => {
    const a = AuthUserSchema.parse({
      id: 's1',
      username: 'alice_dev',
      role: 'user',
      kind: 'subuser',
      parentId: 'u1',
      unixUser: 'alice',
      namespaceId: 's1',
    });
    expect(a.kind).toBe('subuser');
    expect(a.parentId).toBe('u1');
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:`Unrecognized key kind` 或类似。

- [ ] **Step 3: 改 AuthUserSchema**

替换 `packages/shared/src/schemas.ts` 中 `AuthUserSchema` 整段为:

```typescript
/**
 * 脱敏「当前用户」:给前端 + 鉴权挂载用;绝不含 passwordHash。
 * 主账号登录:id=user.id, kind='user', parentId 不填, namespaceId=user.id;
 * 子用户登录:id=subUser.id, kind='subuser', parentId=父 user.id, namespaceId=subUser.id。
 * unixUser 与 role 都解析自有效身份(子用户从父继承)。
 */
export const AuthUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  role: RoleSchema,
  kind: z.enum(['user', 'subuser']),
  parentId: z.string().min(1).optional(),
  unixUser: z.string().min(1),
  namespaceId: z.string().min(1),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=@rcc/shared -- schemas
```

预期:两条全 pass。

- [ ] **Step 5: 构建 shared,看是否有下游 ts 报错**

```
npm run build --workspace=@rcc/shared
```

预期:有可能下游使用 AuthUser 字面解构(只 destructure `id/username/role`)的地方编译成功(新增字段不影响解构);若有 strict 报错,记下来等阶段 2/6 改路由时一并处理。

- [ ] **Step 6: commit**

```
git add packages/shared/src/schemas.ts packages/shared/src/schemas.test.ts
git commit -m "feat(shared): AuthUserSchema 加 kind/parentId/unixUser/namespaceId"
```

---

## 阶段 2:SubUserStore + UserStore.migrate

### Task 4:新增 `SubUserStore`(载入/写盘/CRUD/.bak,与 UserStore 同风格)

**Files:**
- Create: `apps/server/src/lib/subUsers.ts`
- Test: `apps/server/src/lib/subUsers.test.ts`

- [ ] **Step 1: 写 failing test**

新建 `apps/server/src/lib/subUsers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubUserStore } from './subUsers';

describe('SubUserStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sub-'));
    file = path.join(dir, 'subusers.json');
  });

  it('returns empty when file missing', () => {
    const s = new SubUserStore(file);
    expect(s.load()).toEqual([]);
    expect(s.count()).toBe(0);
  });

  it('add → get → findByUsername → load round-trip', () => {
    const s = new SubUserStore(file);
    const added = s.add({
      parentId: 'u1',
      username: 'alice_dev',
      passwordHash: 'h',
      displayName: '开发',
    });
    expect(added.id).toBeTruthy();
    expect(added.settings.idleCloseHours).toBe(3);
    expect(s.findByUsername('alice_dev')?.id).toBe(added.id);
    expect(s.get(added.id)?.parentId).toBe('u1');
    expect(s.load().length).toBe(1);
  });

  it('rejects duplicate username within subusers', () => {
    const s = new SubUserStore(file);
    s.add({ parentId: 'u1', username: 'dup', passwordHash: 'h', displayName: 'd' });
    expect(() =>
      s.add({ parentId: 'u2', username: 'dup', passwordHash: 'h', displayName: 'd' }),
    ).toThrow(/已存在/);
  });

  it('setPassword updates only hash, leaves other fields', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'alice_dev', passwordHash: 'h1', displayName: 'd' });
    const updated = s.setPassword(a.id, 'h2');
    expect(updated?.passwordHash).toBe('h2');
    expect(updated?.username).toBe('alice_dev');
  });

  it('updateSettings persists idleCloseHours', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'alice_dev', passwordHash: 'h', displayName: 'd' });
    const updated = s.updateSettings(a.id, { idleCloseHours: 12 });
    expect(updated?.settings.idleCloseHours).toBe(12);
  });

  it('remove deletes the row, listByParent narrows', () => {
    const s = new SubUserStore(file);
    const a = s.add({ parentId: 'u1', username: 'a', passwordHash: 'h', displayName: 'd' });
    s.add({ parentId: 'u2', username: 'b', passwordHash: 'h', displayName: 'd' });
    expect(s.listByParent('u1').length).toBe(1);
    s.remove(a.id);
    expect(s.listByParent('u1')).toEqual([]);
    expect(s.count()).toBe(1);
  });

  it('write produces .bak backup', () => {
    const s = new SubUserStore(file);
    s.add({ parentId: 'u1', username: 'a', passwordHash: 'h', displayName: 'd' });
    s.add({ parentId: 'u1', username: 'b', passwordHash: 'h', displayName: 'd' });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- subUsers
```

预期:`Cannot find module './subUsers'`。

- [ ] **Step 3: 实现 SubUserStore**

新建 `apps/server/src/lib/subUsers.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SubUserSchema, type SubUser } from '@rcc/shared';

export interface SubUserCreate {
  parentId: string;
  username: string;
  passwordHash: string;
  displayName: string;
}

/**
 * 子用户存储:与 UserStore 同风格(显式 JSON + 原子写 tmp→rename + .bak)。
 * 不做 argon2(哈希在 context/路由层算好再传入),便于纯单测。
 */
export class SubUserStore {
  constructor(private readonly file: string) {}

  load(): SubUser[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown[];
    return arr.map((x) => SubUserSchema.parse(x));
  }

  count(): number {
    return this.load().length;
  }

  get(id: string): SubUser | undefined {
    return this.load().find((s) => s.id === id);
  }

  findByUsername(username: string): SubUser | undefined {
    return this.load().find((s) => s.username === username);
  }

  listByParent(parentId: string): SubUser[] {
    return this.load().filter((s) => s.parentId === parentId);
  }

  add(input: SubUserCreate): SubUser {
    const all = this.load();
    if (all.some((s) => s.username === input.username)) {
      throw new Error(`子用户名已存在: ${input.username}`);
    }
    const sub: SubUser = SubUserSchema.parse({
      id: crypto.randomUUID(),
      parentId: input.parentId,
      username: input.username,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      createdAt: new Date().toISOString(),
    });
    this.write([...all, sub]);
    return sub;
  }

  setPassword(id: string, passwordHash: string): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], passwordHash };
    this.write(all);
    return all[i];
  }

  updateSettings(id: string, settings: { idleCloseHours: number }): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], settings: { ...all[i].settings, ...settings } };
    this.write(all);
    return all[i];
  }

  rename(id: string, displayName: string): SubUser | undefined {
    const all = this.load();
    const i = all.findIndex((s) => s.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], displayName };
    this.write(all);
    return all[i];
  }

  remove(id: string): void {
    this.write(this.load().filter((s) => s.id !== id));
  }

  private write(subs: SubUser[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(subs, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- subUsers
```

预期:所有用例 pass。

- [ ] **Step 5: commit**

```
git add apps/server/src/lib/subUsers.ts apps/server/src/lib/subUsers.test.ts
git commit -m "feat(server): 加 SubUserStore(原子写 + .bak,与 UserStore 同风格)"
```

---

### Task 5:`UserStore.migrate(fallbackUnixUser)` + 全局 username 唯一互查

**Files:**
- Modify: `apps/server/src/lib/users.ts`
- Test: `apps/server/src/lib/users.test.ts`

- [ ] **Step 1: 写 failing test**

追加到 `apps/server/src/lib/users.test.ts`:

```typescript
import { SubUserStore } from './subUsers';

describe('UserStore.migrate', () => {
  it('backfills missing unixUser with fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-u-'));
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: 'u1', username: 'alice', passwordHash: 'h', role: 'admin', createdAt: '2026-01-01' },
      ]),
    );
    const s = new UserStore(file);
    s.migrate('wangleyan');
    expect(s.get('u1')?.unixUser).toBe('wangleyan');
  });

  it('does not overwrite existing unixUser (idempotent)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-u-'));
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(
      file,
      JSON.stringify([
        {
          id: 'u1',
          username: 'alice',
          passwordHash: 'h',
          role: 'admin',
          createdAt: '2026-01-01',
          unixUser: 'alice',
        },
      ]),
    );
    const s = new UserStore(file);
    s.migrate('wangleyan');
    expect(s.get('u1')?.unixUser).toBe('alice');
  });
});

describe('UserStore global username uniqueness with SubUserStore', () => {
  it('rejects adding user with username already taken by a subuser', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-u-'));
    const subFile = path.join(dir, 'subusers.json');
    const subs = new SubUserStore(subFile);
    subs.add({ parentId: 'u1', username: 'taken', passwordHash: 'h', displayName: 'd' });

    const userFile = path.join(dir, 'users.json');
    const users = new UserStore(userFile, subs);
    expect(() =>
      users.add({ username: 'taken', passwordHash: 'h', role: 'user' }),
    ).toThrow(/已存在/);
  });
});
```

(若 `users.test.ts` 文件顶部没有 `import { UserStore } from './users';` / `import fs, os, path`,补上。)

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- users
```

预期:`migrate is not a function` / `UserStore(file, subs)` 构造签名不接受第二个参数。

- [ ] **Step 3: 改 UserStore**

修改 `apps/server/src/lib/users.ts`:

构造函数改为接受可选的 SubUserStore 引用:

```typescript
import { SubUserStore } from './subUsers';

export class UserStore {
  constructor(
    private readonly file: string,
    private readonly subUsers?: SubUserStore,
  ) {}
  // ...
}
```

在 `add()` 里冲突检查处增加:

```typescript
  add(input: UserCreate): User {
    const users = this.load();
    if (users.some((u) => u.username === input.username)) {
      throw new Error(`用户名已存在: ${input.username}`);
    }
    if (this.subUsers?.findByUsername(input.username)) {
      throw new Error(`用户名已存在: ${input.username}`);
    }
    // ...原逻辑
  }
```

末尾追加 `migrate()`:

```typescript
  /**
   * 回填缺 unixUser 的存量用户为 fallbackUnixUser(通常是服务运行的 unix 用户)。
   * 幂等:已有 unixUser 的不动;无需改动则不写盘。
   */
  migrate(fallbackUnixUser: string): void {
    const users = this.load();
    let changed = false;
    const next = users.map((u) => {
      if (!u.unixUser) {
        changed = true;
        return { ...u, unixUser: fallbackUnixUser };
      }
      return u;
    });
    if (changed) this.write(next);
  }
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- users
```

预期:全 pass。

- [ ] **Step 5: SubUserStore 反向也加 UserStore 互查**

修改 `apps/server/src/lib/subUsers.ts`:

```typescript
import { UserStore } from './users';

export class SubUserStore {
  constructor(
    private readonly file: string,
    private readonly users?: UserStore,
  ) {}

  // ...add() 加:
  add(input: SubUserCreate): SubUser {
    const all = this.load();
    if (all.some((s) => s.username === input.username)) {
      throw new Error(`子用户名已存在: ${input.username}`);
    }
    if (this.users?.findByUsername(input.username)) {
      throw new Error(`用户名已存在(主账号): ${input.username}`);
    }
    // ...
  }
}
```

- [ ] **Step 6: 写互查 test**

追加到 `apps/server/src/lib/subUsers.test.ts`:

```typescript
import { UserStore } from './users';

it('rejects adding subuser with username already taken by a user', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sub-'));
  const userFile = path.join(dir, 'users.json');
  const subFile = path.join(dir, 'subusers.json');
  const users = new UserStore(userFile);
  users.add({ username: 'taken', passwordHash: 'h', role: 'user' });
  const subs = new SubUserStore(subFile, users);
  expect(() =>
    subs.add({ parentId: 'u1', username: 'taken', passwordHash: 'h', displayName: 'd' }),
  ).toThrow(/已存在/);
});
```

- [ ] **Step 7: 跑测试确认 pass**

```
npm test --workspace=apps/server -- 'users|subUsers'
```

预期:全 pass。

- [ ] **Step 8: commit**

```
git add apps/server/src/lib/users.ts apps/server/src/lib/users.test.ts \
        apps/server/src/lib/subUsers.ts apps/server/src/lib/subUsers.test.ts
git commit -m "feat(server): UserStore 加 migrate(fallbackUnixUser) + 全局 username 唯一互查"
```

---

## 阶段 3:`runAs` 工具

### Task 6:新增 `runAs` 命令包装,带零开销路径

**Files:**
- Create: `apps/server/src/lib/session/runAs.ts`
- Test: `apps/server/src/lib/session/runAs.test.ts`

- [ ] **Step 1: 写 failing test**

新建 `apps/server/src/lib/session/runAs.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { makeRunAs } from './runAs';

describe('runAs', () => {
  it('zero-overhead path: same user → calls exec directly with file+args', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await runAs('wangleyan', 'tmux', ['list-sessions']);
    expect(exec).toHaveBeenCalledWith('tmux', ['list-sessions']);
  });

  it('cross-user: prepends `sudo -nH -u <user> --` and forwards args', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await runAs('zhangsan', 'tmux', ['kill-session', '-t', 'foo']);
    expect(exec).toHaveBeenCalledWith('sudo', [
      '-n',
      '-H',
      '-u',
      'zhangsan',
      '--',
      'tmux',
      'kill-session',
      '-t',
      'foo',
    ]);
  });

  it('propagates exec errors', async () => {
    const exec = vi.fn(async () => {
      throw new Error('sudo: a password is required');
    });
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await expect(runAs('zhangsan', 'tmux', [])).rejects.toThrow(/password is required/);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- runAs
```

预期:`Cannot find module './runAs'`。

- [ ] **Step 3: 实现 runAs**

新建 `apps/server/src/lib/session/runAs.ts`:

```typescript
import type { ExecFn } from './tmux';

export interface RunAsDeps {
  exec: ExecFn;
  currentUser: string;
}

export type RunAsFn = (unixUser: string, file: string, args: string[]) => ReturnType<ExecFn>;

/**
 * 命令包装单注入点:
 *   - 目标 unix === ServiceUser → 直 exec,零 sudo 开销,行为等同当前单用户路径。
 *   - 跨 unix → 前缀 `sudo -nH -u <user> --`:-n 非交互(配错立刻报错而非挂起),
 *     -H 强制 HOME=/home/<user>(claude 解析 ~/.claude 必须对),-- 终结 sudo flag。
 * 二进制路径用绝对路径由调用方传入(配合 sudoers 白名单);本工具不解析 PATH。
 */
export function makeRunAs(deps: RunAsDeps): RunAsFn {
  return function runAs(unixUser, file, args) {
    if (unixUser === deps.currentUser) {
      return deps.exec(file, args);
    }
    return deps.exec('sudo', ['-n', '-H', '-u', unixUser, '--', file, ...args]);
  };
}
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- runAs
```

预期:三条全 pass。

- [ ] **Step 5: commit**

```
git add apps/server/src/lib/session/runAs.ts apps/server/src/lib/session/runAs.test.ts
git commit -m "feat(server): 加 runAs 命令包装(零开销路径 + sudo -nH 跨 unix)"
```

---

## 阶段 4:Tmux 实例化绑 unixUser

### Task 7:`Tmux` 构造支持注入 unixUser + runAs

**Files:**
- Modify: `apps/server/src/lib/session/tmux.ts`
- Test: `apps/server/src/lib/session/tmux.test.ts`(若存在则追加;否则新建)

- [ ] **Step 1: 写 failing test**

追加到 `apps/server/src/lib/session/tmux.test.ts`(或新建):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { Tmux } from './tmux';

describe('Tmux with unixUser binding', () => {
  it('uses runAs(unixUser, tmux, ...) when configured', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const t = new Tmux({
      socket: 'rcc-zhangsan',
      unixUser: 'zhangsan',
      exec,
      currentUser: 'wangleyan',
    });
    await t.killSession('rcc-foo');
    expect(exec).toHaveBeenCalledWith('sudo', [
      '-n', '-H', '-u', 'zhangsan', '--',
      'tmux', '-L', 'rcc-zhangsan', 'kill-session', '-t', 'rcc-foo',
    ]);
  });

  it('legacy positional constructor (socket, exec) still works for self exec', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const t = new Tmux('rcc', exec);     // 老签名,当前 unix 用户为 ServiceUser
    await t.killSession('rcc-foo');
    expect(exec).toHaveBeenCalledWith('tmux', ['-L', 'rcc', 'kill-session', '-t', 'rcc-foo']);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- 'session/tmux'
```

预期:`Tmux constructor` 不接受 object 形参。

- [ ] **Step 3: 改 Tmux 构造**

修改 `apps/server/src/lib/session/tmux.ts`,顶部加 import:

```typescript
import os from 'node:os';
import { makeRunAs, type RunAsFn } from './runAs';
```

替换类定义:

```typescript
export interface TmuxOptions {
  socket: string;
  unixUser?: string;
  exec?: ExecFn;
  /** 服务进程的 unix 用户名;默认 os.userInfo().username。 */
  currentUser?: string;
}

export class Tmux {
  private readonly socket: string;
  private readonly unixUser: string;
  private readonly runAs: RunAsFn;

  /**
   * 支持两种签名以保持向后兼容:
   *   new Tmux('rcc')                       // 老:socket only,默认 currentUser
   *   new Tmux('rcc', execFn)               // 老:socket + custom exec
   *   new Tmux({ socket, unixUser, exec })  // 新:对象式,可指定 unixUser
   */
  constructor(opts: string | TmuxOptions, execLegacy?: ExecFn) {
    let socket: string;
    let unixUser: string;
    let exec: ExecFn;
    let currentUser: string;
    if (typeof opts === 'string') {
      socket = opts;
      currentUser = os.userInfo().username;
      unixUser = currentUser;
      exec = execLegacy ?? realExec;
    } else {
      socket = opts.socket;
      currentUser = opts.currentUser ?? os.userInfo().username;
      unixUser = opts.unixUser ?? currentUser;
      exec = opts.exec ?? realExec;
    }
    this.socket = socket;
    this.unixUser = unixUser;
    this.runAs = makeRunAs({ exec, currentUser });
  }
  // ...保留 sessionName / base / 各方法
}
```

把类内部所有 `this.exec('tmux', args)` 调用替换为 `this.runAs(this.unixUser, 'tmux', args)`。

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- 'session/tmux'
```

预期:新增两条 + 现有所有用例 pass。

- [ ] **Step 5: 全栈 typecheck**

```
npm run typecheck
```

预期:有可能 `apps/server/src/context.ts` 中 `new Tmux(config.tmuxSocket)` 仍按旧 string 形参,类型 OK 不报错(向后兼容)。

- [ ] **Step 6: commit**

```
git add apps/server/src/lib/session/tmux.ts apps/server/src/lib/session/tmux.test.ts
git commit -m "feat(server): Tmux 支持注入 unixUser/runAs(向后兼容老 string 签名)"
```

---

## 阶段 5:context 重构(getTmux/askLaunchFor + SubUserStore)

### Task 8:`AppContext` 加 `getTmux(unixUser)` / `askLaunchFor(unixUser)` / `subUsers`

**Files:**
- Modify: `apps/server/src/context.ts`
- Modify: `apps/server/src/config.ts`
- Test: 沿用 `apps/server/src/app.test.ts`(若没有覆盖到这条路径,本任务不强制单测,集成测试在阶段 6 一起出)

- [ ] **Step 1: config.ts 加 SubUsers 路径 + ServiceUser env**

修改 `apps/server/src/config.ts`(若文件名/位置与预期不同,grep 找)。增加 env 项:

```typescript
// 新增字段(按现有 Config interface 风格补)
subUsersConfigPath: string;     // 默认 path.join(repoRoot, 'config/subusers.json')
serviceUser: string;            // 默认 os.userInfo().username,可由 RCC_SERVICE_USER 覆盖
fsBrowseRootMap: Record<string, string>;  // RCC_FS_BROWSE_ROOT_<UNIXUSER> env 解析
claudeBinary: string;           // RCC_CLAUDE_BINARY 或 'claude'
```

在解析逻辑里(env / 默认值):

```typescript
const subUsersConfigPath = path.join(repoRoot, 'config/subusers.json');
const serviceUser = process.env.RCC_SERVICE_USER ?? os.userInfo().username;
const claudeBinary = process.env.RCC_CLAUDE_BINARY ?? 'claude';
const fsBrowseRootMap: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('RCC_FS_BROWSE_ROOT_') && v) {
    fsBrowseRootMap[k.slice('RCC_FS_BROWSE_ROOT_'.length)] = v;
  }
}
```

(注意 import `os` 与 `path`,若未引入。)

- [ ] **Step 2: context.ts 改造**

修改 `apps/server/src/context.ts`:

加 import:

```typescript
import { SubUserStore } from './lib/subUsers';
```

`AppContext` 接口字段调整:

```typescript
export interface AppContext {
  config: Config;
  adminHash: string;
  projects: ProjectStore;
  users: UserStore;
  subUsers: SubUserStore;
  conversations: ConversationStore;
  folders: FolderStore;
  /** 按 unix 用户取(或新建)对应 Tmux 实例。lazy 缓存。 */
  getTmux: (unixUser: string) => Tmux;
  /** 按 unix 用户取 ask hook 注入参数(env+settings 路径)。 */
  askLaunchFor: (unixUser: string) => { envExport: string; settingsArg: string };
  registry: SessionRegistry;
  chatRegistry: ChatRegistry;
  research: ResearchProviderRegistry;
}
```

`buildContext` 改造关键段(在原 `tmux` / `askLaunch` 单例位置替换):

```typescript
export async function buildContext(config: Config): Promise<AppContext> {
  const adminHash = config.adminPasswordHash
    ? config.adminPasswordHash
    : await argon2.hash(config.adminPassword as string);

  const subUsers = new SubUserStore(config.subUsersConfigPath);
  const users = new UserStore(config.usersConfigPath, subUsers);
  // SubUserStore 也需要回引 users,完成双向唯一性检查:
  (subUsers as unknown as { users?: UserStore }).users = users;

  if (users.count() === 0) {
    users.add({ username: config.adminUsername, passwordHash: adminHash, role: 'admin' });
  }
  // 给缺 unixUser 的存量用户回填为 serviceUser(默认现状,零行为变化)。
  users.migrate(config.serviceUser);

  const admin = users.findByUsername(config.adminUsername);
  const projects = new ProjectStore(config.projectsConfigPath);
  if (admin) projects.migrate(admin.id);

  const conversations = new ConversationStore(config.conversationsConfigPath);
  conversations.migrate();
  const folders = new FolderStore(config.foldersConfigPath, conversations);

  // per-unix-user askDir + settings.json 落点:子目录 askDir/<unixUser>/
  const askHookScriptPath = path.join(config.repoRoot, 'apps/server/scripts/hooks/rcc-ask-hook.mjs');
  const askLaunchCache = new Map<string, { envExport: string; settingsArg: string }>();
  function askLaunchFor(unixUser: string) {
    const cached = askLaunchCache.get(unixUser);
    if (cached) return cached;
    const userAskDir = path.join(config.askDir, unixUser);
    const userSettingsPath = path.join(userAskDir, 'ask-hooks.settings.json');
    ensureAskHookSettings({
      askDir: userAskDir,
      hookScriptPath: askHookScriptPath,
      settingsPath: userSettingsPath,
    });
    const launch = askLaunchExtra(userAskDir, userSettingsPath);
    askLaunchCache.set(unixUser, launch);
    return launch;
  }

  // per-unix-user Tmux 实例缓存
  const tmuxCache = new Map<string, Tmux>();
  function getTmux(unixUser: string): Tmux {
    const cached = tmuxCache.get(unixUser);
    if (cached) return cached;
    const t = new Tmux({
      socket: `${config.tmuxSocket}-${unixUser}`,
      unixUser,
      currentUser: config.serviceUser,
    });
    tmuxCache.set(unixUser, t);
    return t;
  }

  // ChatRegistry / SessionRegistry / 等下游模块改为接受函数式注入
  const chatRegistry = new ChatRegistry((spec, events) => {
    const tmux = getTmux(spec.unixUser);            // ← spec 现在带 unixUser
    const askLaunch = askLaunchFor(spec.unixUser);
    const userAskDir = path.join(config.askDir, spec.unixUser);
    const tail = new TranscriptTail(() => locateTranscript(spec.sessionId));
    return new ChatSession(
      spec,
      {
        tmux,
        scrape: scrapePane,
        tail,
        hasTranscript: () => locateTranscript(spec.sessionId) !== null,
        statuslineDir: path.join(config.statuslineDir, spec.unixUser),
        readSidecar: (p: string) => {
          const content = readFileSync(p, 'utf8');
          const { mtimeMs } = statSync(p);
          return { content, mtimeMs };
        },
        askDir: userAskDir,
        askLaunch,
        readAskSidecar: readPendingAsk,
        cleanAskSidecar: (dir, sessionId) => {
          try {
            unlinkSync(askSidecarPath(dir, sessionId));
          } catch {/* 文件不存在是常态 */}
        },
      },
      events,
    );
  });

  const research = new ResearchProviderRegistry();
  return {
    config,
    adminHash,
    projects,
    users,
    subUsers,
    conversations,
    folders,
    getTmux,
    askLaunchFor,
    // SessionRegistry 工厂改接受 getTmux,见 Task 9
    registry: new SessionRegistry(makeRealBridgeFactory(getTmux)),
    chatRegistry,
    research,
  };
}
```

(原 `const tmux = new Tmux(config.tmuxSocket)` 与 `const askLaunch = askLaunchExtra(...)` 删除。)

- [ ] **Step 3: typecheck**

```
npm run typecheck
```

预期:`makeRealBridgeFactory(tmux)` / `chatRegistry` spec 不带 unixUser / 各 routes 仍用 `ctx.tmux` 报错——这些在阶段 6/7 修。本步只确保 context.ts 本身的字面 ts 错误清掉(SubUserStore 引用、字段类型)。如果有 inline cast 不优雅之处先留 `as unknown as`,不阻塞,后续可清。

- [ ] **Step 4: 暂不 commit**

(等 Task 9 一起改 SessionRegistry/ChatRegistry 注入再统一 commit。)

---

### Task 9:`SessionRegistry` / `ChatRegistry` / `IdleSweeper` 接受 `getTmux`

**Files:**
- Modify: `apps/server/src/lib/session/registry.ts`(SessionRegistry)
- Modify: `apps/server/src/lib/session/ptyBridge.ts`(makeRealBridgeFactory)
- Modify: `apps/server/src/lib/session/chat/chatRegistry.ts`
- Modify: `apps/server/src/lib/session/chat/chatSession.ts`(ChatSessionSpec 接口加 unixUser)
- Modify: `apps/server/src/lib/session/idleSweeper.ts`

- [ ] **Step 1: ChatSessionSpec 加 unixUser**

打开 `apps/server/src/lib/session/chat/chatSession.ts`,找 `ChatSessionSpec` 接口或类型,加字段:

```typescript
export interface ChatSessionSpec {
  // ...existing fields
  unixUser: string;     // 拉起 tmux/claude 用的 uid
}
```

- [ ] **Step 2: ChatRegistry 创建 spec 时传 unixUser**

修改 `apps/server/src/lib/session/chat/chatRegistry.ts`:

`ensure(...)` 入参增加 `unixUser`,赋值给 spec。具体签名按当前代码风格调整。

- [ ] **Step 3: 终端 SessionRegistry 同样改造**

修改 `apps/server/src/lib/session/registry.ts` 与 `ptyBridge.ts`:

- `makeRealBridgeFactory(getTmux: (u: string) => Tmux)` 替代原 `(tmux: Tmux)`。
- 创建 bridge 时把 unixUser 从 spec/registry attach 入口传进来,bridge 内部用 `getTmux(unixUser)`。

(具体改动以现状代码为准。本步重点是确保签名一致;实际改动 inline 写。)

- [ ] **Step 4: IdleSweeper 改造**

修改 `apps/server/src/lib/session/idleSweeper.ts`:

构造函数注入 `getTmux(unixUser): Tmux`,sweep 时每条会话查其 conversation → 项目 → ownerId → 解析出 unixUser(查 users + subUsers)。kill 时 `getTmux(unixUser).killSession(name)`。

helper:在 sweeper 模块顶部加:

```typescript
function resolveUnixUser(
  conv: Conversation,
  projects: ProjectStore,
  users: UserStore,
  subUsers: SubUserStore,
  fallback: string,
): string {
  const p = projects.get(conv.projectId);
  if (!p?.ownerId) return fallback;
  const u = users.get(p.ownerId);
  if (u?.unixUser) return u.unixUser;
  const s = subUsers.get(p.ownerId);
  if (s) {
    const parent = users.get(s.parentId);
    if (parent?.unixUser) return parent.unixUser;
  }
  return fallback;
}
```

注:fallback = ServiceUser。

- [ ] **Step 5: typecheck 全栈**

```
npm run typecheck
```

预期:剩余报错集中在 routes/(下阶段处理)。这一步把 lib/ 与 session/ 的内部一致性敲定。

- [ ] **Step 6: 跑 session 相关单测**

```
npm test --workspace=apps/server -- 'session'
```

预期:session 模块测试 pass(若有按 spec 的 unixUser 字段必填导致老测试 fail,把测试里的 spec 加上 `unixUser: 'wangleyan'`)。

- [ ] **Step 7: commit**

```
git add apps/server/src/context.ts apps/server/src/config.ts \
        apps/server/src/lib/session/registry.ts \
        apps/server/src/lib/session/ptyBridge.ts \
        apps/server/src/lib/session/chat/chatRegistry.ts \
        apps/server/src/lib/session/chat/chatSession.ts \
        apps/server/src/lib/session/idleSweeper.ts
git commit -m "refactor(server): context 暴露 getTmux/askLaunchFor;Registry/Sweeper 注入函数式 tmux 解析"
```

---

## 阶段 6:鉴权扩展(支持子用户登录)

### Task 10:`resolveUser` 支持子用户解析

**Files:**
- Modify: `apps/server/src/plugins/requireAuth.ts`
- Modify: `apps/server/src/lib/auth.ts`(可能不需改)
- Test: `apps/server/src/plugins/requireAuth.test.ts`(若不存在则新建)

- [ ] **Step 1: 写 failing test**

新建/追加 `apps/server/src/plugins/requireAuth.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signToken } from '../lib/auth';
import { UserStore } from '../lib/users';
import { SubUserStore } from '../lib/subUsers';
import { resolveUser } from './requireAuth';

describe('resolveUser supports subusers', () => {
  let users: UserStore;
  let subs: SubUserStore;
  const secret = 'test-secret';
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-auth-'));
    subs = new SubUserStore(path.join(dir, 'subusers.json'));
    users = new UserStore(path.join(dir, 'users.json'), subs);
    (subs as unknown as { users?: UserStore }).users = users;
  });

  it('resolves primary user, namespaceId=user.id, kind=user', () => {
    const u = users.add({ username: 'alice', passwordHash: 'h', role: 'user' });
    users.migrate('wangleyan');
    const fresh = users.get(u.id)!;
    const token = signToken(secret, 3600_000, fresh.id);
    const a = resolveUser(secret, users, subs, token);
    expect(a?.kind).toBe('user');
    expect(a?.id).toBe(fresh.id);
    expect(a?.namespaceId).toBe(fresh.id);
    expect(a?.unixUser).toBe('wangleyan');
    expect(a?.parentId).toBeUndefined();
  });

  it('resolves subuser, namespaceId=sub.id, parentId set, unixUser inherits parent', () => {
    const parent = users.add({ username: 'alice', passwordHash: 'h', role: 'user' });
    users.migrate('alice-unix');
    const sub = subs.add({ parentId: parent.id, username: 'alice_dev', passwordHash: 'h', displayName: '开发' });
    const token = signToken(secret, 3600_000, sub.id);
    const a = resolveUser(secret, users, subs, token);
    expect(a?.kind).toBe('subuser');
    expect(a?.id).toBe(sub.id);
    expect(a?.parentId).toBe(parent.id);
    expect(a?.namespaceId).toBe(sub.id);
    expect(a?.unixUser).toBe('alice-unix');
    expect(a?.role).toBe('user');  // 继承父
  });

  it('returns null when subuser parent missing (orphan)', () => {
    const sub = subs.add({ parentId: 'ghost', username: 'orphan', passwordHash: 'h', displayName: 'd' });
    const token = signToken(secret, 3600_000, sub.id);
    const a = resolveUser(secret, users, subs, token);
    expect(a).toBeNull();
  });

  it('returns null for invalid token', () => {
    const a = resolveUser(secret, users, subs, 'bad-token');
    expect(a).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- requireAuth
```

预期:`resolveUser(secret, users, subs, token)` 第三参数 type error(当前签名是三参)。

- [ ] **Step 3: 改 resolveUser 与 makeRequireAuth**

修改 `apps/server/src/plugins/requireAuth.ts`:

```typescript
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthUser, User, SubUser } from '@rcc/shared';
import { verifyToken, COOKIE_NAME } from '../lib/auth';
import type { UserStore } from '../lib/users';
import type { SubUserStore } from '../lib/subUsers';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function makeRequireAuth(secret: string, users: UserStore, subUsers: SubUserStore) {
  return async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = resolveUser(secret, users, subUsers, req.cookies?.[COOKIE_NAME]);
    if (!user) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.user = user;
  };
}

export function makeRequireAdminRole() {
  return async function requireAdminRole(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.user?.role !== 'admin') {
      await reply.code(403).send({ error: 'forbidden' });
    }
  };
}

export function resolveUser(
  secret: string,
  users: UserStore,
  subUsers: SubUserStore,
  token: string | undefined,
): AuthUser | null {
  const payload = verifyToken(secret, token);
  if (!payload) return null;
  const u = users.get(payload.userId);
  if (u) return toAuthUserFromPrimary(u);
  const s = subUsers.get(payload.userId);
  if (s) {
    const parent = users.get(s.parentId);
    if (!parent) return null;
    return toAuthUserFromSub(s, parent);
  }
  return null;
}

function toAuthUserFromPrimary(u: User): AuthUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    kind: 'user',
    unixUser: u.unixUser ?? 'unknown', // schema 上 optional;runtime 这条不应触发(context.migrate 已回填)
    namespaceId: u.id,
  };
}

function toAuthUserFromSub(s: SubUser, parent: User): AuthUser {
  return {
    id: s.id,
    username: s.username,
    role: parent.role,
    kind: 'subuser',
    parentId: parent.id,
    unixUser: parent.unixUser ?? 'unknown',
    namespaceId: s.id,
  };
}
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- requireAuth
```

预期:全 pass。

- [ ] **Step 5: 改所有调用 `makeRequireAuth` 的位置加上 subUsers 参数**

grep:

```
grep -rn 'makeRequireAuth' apps/server/src
```

每处把第二个参数后追加 `ctx.subUsers`(或对应的 store 引用)。

- [ ] **Step 6: typecheck**

```
npm run typecheck
```

预期:requireAuth 相关报错清。

- [ ] **Step 7: commit**

```
git add apps/server/src/plugins/requireAuth.ts apps/server/src/plugins/requireAuth.test.ts \
        $(grep -rl 'makeRequireAuth' apps/server/src)
git commit -m "feat(server): requireAuth/resolveUser 支持子用户登录,挂 kind/unixUser/namespaceId"
```

---

### Task 11:`POST /api/auth/login` 兼容子用户

**Files:**
- Modify: `apps/server/src/routes/auth.ts`
- Test: 集成测试在 `apps/server/src/app.test.ts` 风格补一条

- [ ] **Step 1: 写 failing 集成测试**

在 `apps/server/src/app.test.ts` 或合适的位置追加:

```typescript
describe('login with subuser', () => {
  it('subuser can log in with own password, gets token resolving to namespaceId=sub.id', async () => {
    // 用现有 app 起测试 fixture;ctx.users / ctx.subUsers 直接 seed
    // 具体写法跟现有用例风格一致(用 inject)。
  });
});
```

(若现有 app.test.ts 用 fastify inject,完整代码按既有 fixture 风格补;此处省略。)

- [ ] **Step 2: 改 login 路由**

修改 `apps/server/src/routes/auth.ts` 的 `POST /api/auth/login` 处理:

```typescript
app.post('/api/auth/login', async (req, reply) => {
  const { username, password } = req.body as { username: string; password: string };
  // 先查主账号
  const u = ctx.users.findByUsername(username);
  if (u && await argon2.verify(u.passwordHash, password)) {
    const token = signToken(ctx.config.sessionSecret, ctx.config.sessionTtlMs, u.id);
    reply.setCookie(COOKIE_NAME, token, cookieOpts);
    return { user: { id: u.id, username: u.username, role: u.role } };
  }
  // 再查子用户
  const s = ctx.subUsers.findByUsername(username);
  if (s && await argon2.verify(s.passwordHash, password)) {
    const parent = ctx.users.get(s.parentId);
    if (!parent) return reply.code(401).send({ error: 'orphan_subuser' });
    const token = signToken(ctx.config.sessionSecret, ctx.config.sessionTtlMs, s.id);
    reply.setCookie(COOKIE_NAME, token, cookieOpts);
    return { user: { id: s.id, username: s.username, role: parent.role } };
  }
  return reply.code(401).send({ error: 'unauthorized' });
});
```

(实际 cookieOpts / sessionTtl 名称按既有代码调整。)

- [ ] **Step 3: 跑集成测试**

```
npm test --workspace=apps/server -- app
```

预期:新增条 pass。

- [ ] **Step 4: commit**

```
git add apps/server/src/routes/auth.ts apps/server/src/app.test.ts
git commit -m "feat(server): POST /api/auth/login 兼容子用户(先查主账号,再查子用户)"
```

---

## 阶段 7:`canSeeProject` + 路由 namespaceId 改造

### Task 12:`canSeeProject` 按 `namespaceId`

**Files:**
- Modify: `apps/server/src/lib/authz.ts`
- Modify: `apps/server/src/lib/authz.test.ts`

- [ ] **Step 1: 重写 authz.test.ts**

替换 `apps/server/src/lib/authz.test.ts` 内容:

```typescript
import { describe, it, expect } from 'vitest';
import { canSeeProject } from './authz';

const admin = { role: 'admin' as const, namespaceId: 'admin1' };
const user = { role: 'user' as const, namespaceId: 'u1' };
const sub  = { role: 'user' as const, namespaceId: 's1' };

describe('canSeeProject by namespaceId', () => {
  it('admin sees any project', () => {
    expect(canSeeProject(admin, { ownerId: 'u1' })).toBe(true);
    expect(canSeeProject(admin, { ownerId: 's1' })).toBe(true);
    expect(canSeeProject(admin, {})).toBe(true);
  });
  it('user sees own', () => {
    expect(canSeeProject(user, { ownerId: 'u1' })).toBe(true);
  });
  it('user does not see others', () => {
    expect(canSeeProject(user, { ownerId: 's1' })).toBe(false);
    expect(canSeeProject(user, {})).toBe(false);
  });
  it('sibling subusers do not see each other', () => {
    expect(canSeeProject(sub, { ownerId: 's2' })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认 fail**

```
npm test --workspace=apps/server -- authz
```

预期:`canSeeProject` 签名不接受 namespaceId 字段。

- [ ] **Step 3: 改 authz.ts**

替换 `apps/server/src/lib/authz.ts`:

```typescript
import type { Role } from '@rcc/shared';

/**
 * 项目可见性:admin 看全部;否则按 namespaceId 比对项目 ownerId(语义=资源归属 key)。
 * 主账号 namespaceId === user.id;子用户 namespaceId === subUser.id(与父独立)。
 */
export function canSeeProject(
  user: { role: Role; namespaceId: string },
  project: { ownerId?: string },
): boolean {
  return user.role === 'admin' || project.ownerId === user.namespaceId;
}
```

- [ ] **Step 4: 跑测试确认 pass**

```
npm test --workspace=apps/server -- authz
```

预期:全 pass。

- [ ] **Step 5: commit**

```
git add apps/server/src/lib/authz.ts apps/server/src/lib/authz.test.ts
git commit -m "feat(server): canSeeProject 按 namespaceId(主账号/子用户独立 namespace)"
```

---

### Task 13:projects / conversations / folders 路由全部按 namespaceId

**Files:**
- Modify: `apps/server/src/routes/projects.ts`
- Modify: `apps/server/src/routes/sessions.ts`(若 conversations 路由在这)
- Modify: `apps/server/src/routes/folders.ts`(若独立文件)
- Modify: `apps/server/src/routes/chat.ts`
- Modify: `apps/server/src/routes/files.ts`(后续 task 还会改 unix 隔离,本步只改 namespaceId)
- Modify: `apps/server/src/routes/taskEvidence.ts`(可见性跟随项目,改用 namespaceId)

- [ ] **Step 1: grep 所有用到 `req.user.id` 的路径**

```
grep -rn 'req.user.id\|req\.user!.id' apps/server/src/routes
```

逐处评估:

- 如果是"判断资源归属"用途(canSeeProject / ownerId 比对)→ 改 `req.user.namespaceId`。
- 如果是"判断当前登录身份/给 admin API"用途(改自己口令、自己 settings)→ 保留 `req.user.id`(自身 id,不是 namespace)。

- [ ] **Step 2: 替换"归属"用途**

举例(projects.ts):

```typescript
// 旧
app.get('/api/projects', { preHandler: [requireAuth] }, async (req) => {
  return { projects: ctx.projects.load().filter((p) => canSeeProject(req.user!, p)) };
});

app.post('/api/projects', { preHandler: [requireAuth] }, async (req, reply) => {
  const body = ProjectCreateSchema.parse(req.body);
  const ownerId = req.user!.role === 'admin' && body.ownerId ? body.ownerId : req.user!.namespaceId;
  const project = ctx.projects.add({ ...body, ownerId });
  return reply.send({ project });
});
```

folders.ts:

```typescript
const folder = ctx.folders.create(projectId, req.user!.namespaceId, name);
```

类似地遍历所有 routes,把 ownerId 相关赋值/比对换 namespaceId。

- [ ] **Step 3: WS 握手中也按 namespaceId 比对**

`sessions.ts` / `chat.ts` 的 WS handler:解出 user 后用 `canSeeProject({ role: user.role, namespaceId: user.namespaceId }, project)` 关闸。

- [ ] **Step 4: 跑全栈测试**

```
npm test --workspace=apps/server
```

预期:绝大多数 pass;若有原本 mock `req.user = { id, role }` 的集成测试 fail,改 mock 加 `namespaceId/kind/unixUser/username`。

- [ ] **Step 5: commit**

```
git add apps/server/src/routes/
git commit -m "refactor(server): 资源归属路由全部按 req.user.namespaceId(主账号/子用户语义统一)"
```

---

## 阶段 8:sidecar 路径按 unix 用户分

### Task 14:`ensureAskHookSettings` 接收已含 unixUser 的 askDir

**Files:**
- Modify: `apps/server/src/lib/session/chat/askHookSettings.ts`(可能改动很小)
- 验证 Task 8 改造时已经在 `context.ts` 里按 unixUser 调用 ensureAskHookSettings

- [ ] **Step 1: 读 askHookSettings.ts 当前实现**

```
view apps/server/src/lib/session/chat/askHookSettings.ts
```

预期:已接受 `askDir`/`settingsPath` 入参,不需要本质改动——Task 8 的 `askLaunchFor` 已经传入 per-user 路径。

- [ ] **Step 2: 验证 sidecar 路径正确**

新加一个集成 smoke:启动 fixture,模拟两个不同 unixUser 的 chat session,验证 `<askDir>/<unixUser>/ask-hooks.settings.json` 都存在且互不覆盖。

```typescript
// apps/server/src/lib/session/chat/askHookSettings.test.ts 追加:
it('produces separate settings.json per unix user', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-ask-'));
  const scriptPath = '/x/rcc-ask-hook.mjs';
  for (const u of ['alice', 'bob']) {
    const askDir = path.join(tmpRoot, u);
    ensureAskHookSettings({
      askDir,
      hookScriptPath: scriptPath,
      settingsPath: path.join(askDir, 'ask-hooks.settings.json'),
    });
    expect(fs.existsSync(path.join(askDir, 'ask-hooks.settings.json'))).toBe(true);
  }
});
```

- [ ] **Step 3: 跑测试**

```
npm test --workspace=apps/server -- askHookSettings
```

预期:pass。

- [ ] **Step 4: commit**

```
git add apps/server/src/lib/session/chat/askHookSettings.test.ts
git commit -m "test(server): askHookSettings 按 unix 用户分子目录的隔离回归"
```

---

## 阶段 9:files 路由跨 unix 走 runAs

### Task 15:`listFiles` / `readFile` 跨 unix 时走 runAs

**Files:**
- Modify: `apps/server/src/lib/files.ts`
- Modify: `apps/server/src/routes/files.ts`
- Test: `apps/server/src/lib/files.test.ts`

- [ ] **Step 1: 决定接口**

`files.ts` 的 `listFiles(rootPath, relPath)` / `readFile(rootPath, relPath)` 当前直用 `fs`。新增 unixUser 入参,内部判断:

```typescript
function listFiles(rootPath: string, relPath: string, deps: {
  unixUser: string;
  currentUser: string;
  runAs: RunAsFn;
}): Promise<FileEntry[]> {
  if (deps.unixUser === deps.currentUser) {
    // 直走 fs(零开销路径,行为同前)
    return listFilesFs(rootPath, relPath);
  }
  // 跨 unix:用 runAs 跑 ls + stat
  return listFilesViaRunAs(rootPath, relPath, deps);
}
```

`listFilesViaRunAs` 实现思路:

- `runAs(unixUser, 'ls', ['-1A', '--', dir])` 取条目名
- 再对每条 `runAs(unixUser, 'stat', ['-c', '%n\t%F\t%s', '--', fullpath])` 取 kind/size
- 解析输出 → `FileEntry[]`

(细节:用 stat 的 `%F` 区分 directory/regular file 等;非这两类返回 'file' 兜底,size=0。)

- [ ] **Step 2: 写 test 用 fake runAs**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { listFilesViaRunAs } from './files';

describe('listFilesViaRunAs', () => {
  it('returns entries via ls + stat', async () => {
    const runAs = vi.fn().mockImplementation(async (_user, file, args) => {
      if (file === 'ls') return { stdout: 'a.txt\nb\n', stderr: '' };
      if (file === 'stat') {
        const target = args[args.length - 1];
        if (target.endsWith('a.txt')) return { stdout: 'a.txt\tregular file\t10\n', stderr: '' };
        if (target.endsWith('/b'))    return { stdout: 'b\tdirectory\t4096\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const entries = await listFilesViaRunAs('/root', '', { unixUser: 'zhangsan', currentUser: 'wly', runAs });
    expect(entries.map((e) => e.kind).sort()).toEqual(['dir', 'file']);
  });
});
```

- [ ] **Step 3: 实现 + 跑测试**

把 `listFilesViaRunAs` / `readFileViaRunAs` 实现写到 `apps/server/src/lib/files.ts`。导出 `listFilesViaRunAs`(便于单测)。

```
npm test --workspace=apps/server -- files
```

预期:pass。

- [ ] **Step 4: 路由层注入**

修改 `apps/server/src/routes/files.ts`,在调用 `listFiles` / `readFile` 时把 `unixUser`/`currentUser`/`runAs` 透传:

```typescript
const runAs = makeRunAs({ exec: realExec, currentUser: ctx.config.serviceUser });
// ...
const entries = await listFiles(project.path, relPath, {
  unixUser: req.user!.unixUser,
  currentUser: ctx.config.serviceUser,
  runAs,
});
```

(makeRunAs 调用可以放 context.ts 暴露为 `ctx.runAs`,避免每路由重新构造;按风格调整。)

- [ ] **Step 5: commit**

```
git add apps/server/src/lib/files.ts apps/server/src/lib/files.test.ts apps/server/src/routes/files.ts apps/server/src/context.ts
git commit -m "feat(server): files listFiles/readFile 跨 unix 走 runAs(ls/stat/cat)"
```

---

### Task 16:聊天图片上传跨 unix 走 runAs

**Files:**
- Modify: `apps/server/src/routes/chat.ts`(uploads 处理)

- [ ] **Step 1: grep 找上传落盘点**

```
grep -n 'rcc-uploads\|writeFile.*upload\|/uploads' apps/server/src/routes/chat.ts
```

- [ ] **Step 2: 改写盘逻辑**

如果 `unixUser === serviceUser`,直接 `fs.writeFile` 不变。否则:

```typescript
const tmpPath = path.join(os.tmpdir(), `rcc-upload-${crypto.randomUUID()}`);
await fs.promises.writeFile(tmpPath, buf);
// 用目标 unix 用户身份移到最终位置(cp 改 owner)
await ctx.runAs(req.user!.unixUser, 'mkdir', ['-p', path.dirname(finalPath)]);
await ctx.runAs(req.user!.unixUser, 'cp', [tmpPath, finalPath]);
await fs.promises.unlink(tmpPath);
```

(细节:`cp` 默认 owner 取 cp 进程的 uid → 目标 uid → 文件 owner = 目标 unix 用户 ✓。)

- [ ] **Step 3: 简单回归手测**

记 todo:阶段 13 冒烟里覆盖。本步只 commit。

- [ ] **Step 4: commit**

```
git add apps/server/src/routes/chat.ts
git commit -m "feat(server): 聊天上传跨 unix 走 runAs cp,文件 owner=目标用户"
```

---

## 阶段 10:admin 子用户 CRUD + 自助改口令

### Task 17:子用户管理 API

**Files:**
- Modify: `apps/server/src/routes/admin.ts`
- Test: `apps/server/src/app.test.ts`(扩展)

- [ ] **Step 1: 设计路由**

```
GET    /api/admin/subusers              // admin 看全部;非 admin 看自己父下的
POST   /api/admin/subusers              // body: { parentId, username, password, displayName }
PATCH  /api/admin/subusers/:id          // body: { password? | displayName? }
DELETE /api/admin/subusers/:id          // 删子用户
```

权限:

- 子用户登录(`req.user.kind === 'subuser'`)→ 403,拒绝任何子用户管理动作。
- admin → 全部允许。
- 普通主账号 → 仅能管 `parentId === req.user.id` 的子用户。

- [ ] **Step 2: 写 routes 代码**

在 `routes/admin.ts` 加(节选 GET / POST,其他类似):

```typescript
app.get('/api/admin/subusers', { preHandler: [requireAuth] }, async (req, reply) => {
  if (req.user!.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
  const all = ctx.subUsers.load().map(scrub);
  if (req.user!.role === 'admin') return { subusers: all };
  return { subusers: all.filter((s) => s.parentId === req.user!.id) };
});

app.post('/api/admin/subusers', { preHandler: [requireAuth] }, async (req, reply) => {
  if (req.user!.kind === 'subuser') return reply.code(403).send({ error: 'forbidden' });
  const { parentId, username, password, displayName } = req.body as {
    parentId: string; username: string; password: string; displayName: string;
  };
  if (req.user!.role !== 'admin' && parentId !== req.user!.id) {
    return reply.code(403).send({ error: 'forbidden_parent' });
  }
  const parent = ctx.users.get(parentId);
  if (!parent) return reply.code(400).send({ error: 'parent_not_found' });
  const passwordHash = await argon2.hash(password);
  const s = ctx.subUsers.add({ parentId, username, passwordHash, displayName });
  return { subuser: scrub(s) };
});

function scrub<T extends { passwordHash?: string }>(o: T): Omit<T, 'passwordHash'> {
  const { passwordHash: _ph, ...rest } = o;
  return rest;
}
```

PATCH / DELETE 同理(按现有 routes 风格)。

- [ ] **Step 3: 加集成测试**

在 `app.test.ts` 追加 3-4 条:admin POST、user POST 自己父下、user POST 别人父下 403、子用户登录 GET 403。

- [ ] **Step 4: 跑测试**

```
npm test --workspace=apps/server -- app
```

预期:pass。

- [ ] **Step 5: commit**

```
git add apps/server/src/routes/admin.ts apps/server/src/app.test.ts
git commit -m "feat(server): 子用户 CRUD(/api/admin/subusers,admin/user 各自管辖)"
```

---

### Task 18:自助改口令 `/api/me/password` + `/api/me/settings` 兼容子用户

**Files:**
- Modify: `apps/server/src/routes/admin.ts` 或 `routes/auth.ts`(看现有 me 路由在哪)

- [ ] **Step 1: grep 现有 me 路由**

```
grep -rn '/api/me/' apps/server/src/routes
```

- [ ] **Step 2: 在 me settings 旁加 me password**

```typescript
app.patch('/api/me/password', { preHandler: [requireAuth] }, async (req, reply) => {
  const { oldPassword, newPassword } = req.body as { oldPassword: string; newPassword: string };
  if (req.user!.kind === 'user') {
    const u = ctx.users.get(req.user!.id);
    if (!u || !(await argon2.verify(u.passwordHash, oldPassword))) {
      return reply.code(401).send({ error: 'wrong_password' });
    }
    ctx.users.setPassword(u.id, await argon2.hash(newPassword));
    return { ok: true };
  } else {
    const s = ctx.subUsers.get(req.user!.id);
    if (!s || !(await argon2.verify(s.passwordHash, oldPassword))) {
      return reply.code(401).send({ error: 'wrong_password' });
    }
    ctx.subUsers.setPassword(s.id, await argon2.hash(newPassword));
    return { ok: true };
  }
});
```

- [ ] **Step 3: 同步改 `/api/me/settings`**

让 settings 路由也根据 `req.user.kind` 写 users 或 subUsers:

```typescript
app.patch('/api/me/settings', { preHandler: [requireAuth] }, async (req, reply) => {
  const { idleCloseHours } = req.body as { idleCloseHours: number };
  if (req.user!.kind === 'user') {
    ctx.users.updateSettings(req.user!.id, { idleCloseHours });
  } else {
    ctx.subUsers.updateSettings(req.user!.id, { idleCloseHours });
  }
  return { idleCloseHours };
});
```

GET `/api/me/settings` 同理读对应 store。

- [ ] **Step 4: 跑测试 + commit**

```
npm test --workspace=apps/server
```

```
git add apps/server/src/routes/<目标文件>
git commit -m "feat(server): /api/me/password 自助改口令;/api/me/settings 兼容子用户"
```

---

## 阶段 11:前端 UI

### Task 19:`api.ts` 加子用户 + unixUser API 方法

**Files:**
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: 加 SubUser 类型 import + 接口**

在 import 块加 `SubUser`:

```typescript
import type {
  // ...
  Folder,
  SubUser,
} from '@rcc/shared';
```

在 `api = { ... }` 块尾追加:

```typescript
  // ---- 子用户 ----
  adminListSubUsers: () => req<{ subusers: SubUser[] }>('GET', '/api/admin/subusers'),
  adminAddSubUser: (s: { parentId: string; username: string; password: string; displayName: string }) =>
    req<{ subuser: SubUser }>('POST', '/api/admin/subusers', s),
  adminSetSubUserPassword: (id: string, password: string) =>
    req<{ subuser: SubUser }>('PATCH', `/api/admin/subusers/${id}`, { password }),
  adminRenameSubUser: (id: string, displayName: string) =>
    req<{ subuser: SubUser }>('PATCH', `/api/admin/subusers/${id}`, { displayName }),
  adminDeleteSubUser: (id: string) => req<{ ok: true }>('DELETE', `/api/admin/subusers/${id}`),

  // 主账号 add 加 unixUser 字段
  adminAddUser: (u: { username: string; password: string; role: Role; unixUser: string }) =>
    req<{ user: AuthUser }>('POST', '/api/admin/users', u),

  changeMyPassword: (oldPassword: string, newPassword: string) =>
    req<{ ok: true }>('PATCH', '/api/me/password', { oldPassword, newPassword }),
```

(替换原有 `adminAddUser` 的签名,增加 unixUser 必填。)

- [ ] **Step 2: commit**

```
git add apps/web/src/lib/api.ts
git commit -m "feat(web): api.ts 加子用户 CRUD + adminAddUser 必填 unixUser + 自助改口令"
```

---

### Task 20:`UserAdmin.tsx` 加 unixUser 字段 + 子用户管理

**Files:**
- Modify: `apps/web/src/components/UserAdmin.tsx`

- [ ] **Step 1: 表格加 unixUser 列**

在用户列表渲染处,每行额外显示 `user.unixUser`(用户对象类型从 shared 取,改成 AuthUser-like 含 unixUser)。后端 `GET /api/admin/users` 已经返回完整 User,展示 `unixUser ?? '—'`。

- [ ] **Step 2: 新增用户 form 加 unixUser 输入**

`<label>unix 用户名</label><input value={unixUser} onChange={...} required />`。

提交时传到 `api.adminAddUser({ ..., unixUser })`。

- [ ] **Step 3: 子用户展开**

每行用户后面加"展开子用户"按钮,点击后渲染该用户下的子用户列表(用 `adminListSubUsers` 过滤 parentId)。

子用户表格列:displayName / username / 创建时间 / 操作(改密码/删)。

底部加新增子用户 form(parentId 隐藏成当前父 id,username / password / displayName 输入)。

- [ ] **Step 4: 改密码 modal**

子用户改密码用 `api.adminSetSubUserPassword(id, newPwd)`;主账号自己改密码用新建 `MyAccount.tsx` 或塞顶栏菜单。

- [ ] **Step 5: 走查样式 + commit**

打开本机 web,跑 `./start.sh`,登录 admin,验收 UI;改 css 若挤(沿用 `.input/.btn/.field` 风格,不引新依赖)。

```
git add apps/web/src/components/UserAdmin.tsx apps/web/src/components/MyAccount.tsx ...
git commit -m "feat(web): UserAdmin 加 unixUser 列与子用户管理;新增 MyAccount 自助改密码"
```

---

### Task 21:普通用户视角的子用户管理(非 admin 主账号自管子用户)

**Files:**
- Create: `apps/web/src/components/SubUserAdmin.tsx`
- Modify: `apps/web/src/App.tsx`(或 ProjectList 侧栏入口)

- [ ] **Step 1: 加入口**

在侧栏当 `user.role === 'user' && user.kind === 'user'` 时显示"我的子用户"按钮 → 路由到 `SubUserAdmin`。

子用户登录(`user.kind === 'subuser'`)不显示此入口。

- [ ] **Step 2: SubUserAdmin 组件**

只列出自己父下的子用户(后端 GET 自动过滤);提供新增 / 改密 / 删 / 改 displayName。

- [ ] **Step 3: commit**

```
git add apps/web/src/components/SubUserAdmin.tsx apps/web/src/App.tsx
git commit -m "feat(web): 主账号用户的子用户自助管理面板"
```

---

## 阶段 12:环境变量 + 部署样例 + 文档

### Task 22:`.env.example` + `deploy/sudoers.remote-cc.example`

**Files:**
- Modify: `.env.example`
- Create: `deploy/sudoers.remote-cc.example`(若 `deploy/` 不存在则建)
- Modify: `README.md`(加多用户部署章节)
- Modify: `CLAUDE.md`(加多用户身份小节,接在「会话生命周期」后)

- [ ] **Step 1: 改 `.env.example`**

末尾追加:

```
# ---- 多用户 unix 隔离(可选;默认行为=单用户原样) ----
# 服务运行的 unix 用户名(默认 = whoami)。仅在罕见场景显式覆盖。
# RCC_SERVICE_USER=wangleyan

# claude 二进制绝对路径(写进 sudoers 白名单也要一致)。默认 'claude' 由 PATH 解析。
# RCC_CLAUDE_BINARY=/usr/local/bin/claude

# 按 unix 用户的可浏览根目录;缺省回退 ~<user>/projects。
# RCC_FS_BROWSE_ROOT_zhangsan=/home/zhangsan/work
```

- [ ] **Step 2: 建 sudoers example**

```
mkdir -p deploy
```

新建 `deploy/sudoers.remote-cc.example`:

```
# /etc/sudoers.d/remote-cc 的样例。按本机情况修改用户名 / claude 路径,
# 用 `visudo -c -f /etc/sudoers.d/remote-cc` 校验后再放生效。
#
# ServiceUser = 跑 ./start.sh 的本机用户,例如 wangleyan
# 目标用户 = 你打算给 rcc 主账号绑的 unix 用户,例如 zhangsan / lisi

wangleyan ALL=(zhangsan,lisi) NOPASSWD: \
  /usr/bin/tmux, \
  /usr/local/bin/claude, \
  /usr/bin/stat, \
  /usr/bin/cat, \
  /usr/bin/ls, \
  /usr/bin/find, \
  /usr/bin/tee, \
  /usr/bin/cp, \
  /usr/bin/mkdir
```

- [ ] **Step 3: README.md 加多用户章节**

在 README.md 末尾或 Security 之前插入"多用户部署"一节,说明:

1. useradd 建目标 unix 用户(自家 claude 各自登录拿订阅)。
2. 拷 deploy 样例到 /etc/sudoers.d/remote-cc,visudo 校验。
3. rcc admin UI 给主账号填 unixUser。
4. 子用户在主账号下挂,unix 身份继承父。
5. 安全须知:不向公网直接暴露端口、sudoers 白名单严格、claude 二进制路径绝对。

- [ ] **Step 4: CLAUDE.md 加章节**

在「## 架构速览」的「会话生命周期」小节后追加「### 多用户身份(unix 隔离 + 子用户)」一节,300 字内,讲清三层模型 + 命令包装 + sidecar 路径。

- [ ] **Step 5: commit**

```
git add .env.example deploy/sudoers.remote-cc.example README.md CLAUDE.md
git commit -m "docs: 多用户部署指南(sudoers 样例 + README + CLAUDE.md)"
```

---

## 阶段 13:冒烟 + 收尾

### Task 23:`smoke-multiuser.ts` 真实集成验证

**Files:**
- Create: `apps/server/scripts/smoke-multiuser.ts`

- [ ] **Step 1: 写脚本骨架**

按现有 `scripts/smoke-chat.ts` 风格,doc 顶部明确依赖:

- 本机已 useradd 出至少 2 个测试 unix 用户(如 `rcc-test1 / rcc-test2`),分别已登录过 claude 拿到自己的订阅。
- sudoers 已配:ServiceUser ALL=(rcc-test1,rcc-test2) NOPASSWD:...

脚本步骤:

1. 启动 fastify(用 buildContext 真实跑)。
2. 直接操作 stores 注入 admin + 两个主账号(unixUser 分别绑定)。
3. 模拟 login 拿 cookie。
4. POST 项目(各自家目录下)。
5. POST 会话 → ensure tmux 起,跑一条 echo prompt 测命令执行。
6. fs.statSync 验证项目下创建的文件 owner 是目标 unix 用户。
7. 跨用户 GET 项目列表验证不可见。
8. 清理:kill-session、删 transcript、删项目(可选)。

- [ ] **Step 2: package.json 加 script**

```
"smoke:multiuser": "tsx apps/server/scripts/smoke-multiuser.ts"
```

- [ ] **Step 3: 真实节点跑一次**

```
npm run smoke:multiuser
```

排坑:常见错误 `sudo: a password is required` → 检查 sudoers;`stat: cannot stat` → 检查目录权限。

- [ ] **Step 4: commit**

```
git add apps/server/scripts/smoke-multiuser.ts package.json
git commit -m "test(smoke): 多用户 unix 隔离端到端冒烟(双账号 + 文件 owner 验证)"
```

---

### Task 24:全栈测试 + typecheck + build,验收

- [ ] **Step 1: 全栈测试**

```
npm test
```

预期:所有单测 + 集成 pass。fix 残留 fail。

- [ ] **Step 2: typecheck**

```
npm run typecheck
```

预期:零错误。

- [ ] **Step 3: build**

```
npm run build
```

预期:前后端 build 成功,dist/ 产物完整。

- [ ] **Step 4: ./start.sh 重启验证**

```
./start.sh
```

打开网页,admin 登录,完整跑一遍现有功能(开终端、开聊天、发消息、AI 回复、休眠/恢复、文件浏览、上传图片)——全部对齐重构前体验。

- [ ] **Step 5: 创建一个 unixUser 绑定不同的主账号 + 子用户,真实验收**

需要本机准备:

- `sudo useradd -m -s /bin/bash rcc-test1`
- `sudo passwd rcc-test1`
- `su - rcc-test1 -c 'claude /login'` 让 rcc-test1 自己登 claude
- 把 sudoers 样例搬到 /etc/sudoers.d/remote-cc,visudo 校验
- rcc admin UI 加主账号 username=t1 unixUser=rcc-test1
- 退出 admin → 用 t1/口令登录 → 建项目(path 在 /home/rcc-test1/ 下)→ 开聊天 → 让 claude 写一个文件
- `ls -la <文件>` 确认 owner=rcc-test1
- t1 下挂个子用户 t1-dev,用 t1-dev 登录,看项目列表为空(子用户独立 namespace),自建项目跑同样流程,owner 仍 rcc-test1

- [ ] **Step 6: 全 task 关闭**

回 task list,完成所有 task,plan 收尾。

```
git log --oneline -20
```

确认 commit 历史完整、信息清晰。

---

## Self-Review Checklist(plan 写完执行)

- [ ] spec 每节都能映射到至少一个 task?
  - 三层身份模型 → Task 1-5
  - sudo wrapper → Task 6, 7
  - HOME/socket 派生 → Task 7, 9
  - sidecar 按 unix 用户分 → Task 8, 14
  - 路径与 sidecar → Task 8, 14
  - 路由 namespaceId 过滤 → Task 12, 13
  - sudoers 规范 → Task 22
  - 子用户 API + UI → Task 17, 19, 20, 21
  - 自助改口令 → Task 18, 20
  - 迁移策略 → Task 5(unixUser 回填)、Task 8(askLaunch 路径变更)
  - 测试策略 → 散布在各 task(TDD)+ Task 23 冒烟
  - 不破坏现有 → 每 task 保留向后兼容(Tmux 老签名、零开销路径)
- [ ] 占位符扫描:无 TBD / TODO / 之后填。✓
- [ ] 类型一致性:`getTmux` / `askLaunchFor` / `runAs` / `namespaceId` / `unixUser` / `kind` / `parentId` 全文统一。✓
- [ ] 频繁小步提交:每 task 末尾都有 commit step。✓
