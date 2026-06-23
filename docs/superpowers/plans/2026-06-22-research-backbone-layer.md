# 科研工作流系统 — 骨干层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把约定层搭好的空目录变成一张「只能用 `rlab` 动词修改、schema 永远自洽、人与 Agent 共用」的带类型科研知识图。

**Architecture:** 在 `packages/research-core` 内分层:`schema`(类型与校验)→ `store`(单节点 JSON 的原子 IO)→ `graph`(全量加载成内存图 + 查询)→ `derivedIndex`(可重建的派生缓存)→ `verbs/*`(写动词语义,纯函数 + 注入 IO)→ `brief`(纯计算的全局骨架渲染)→ `runCli`(动词分发 + 双输出)。核心库被 CLI 与未来 remote-cc 后端共用,同一张图永不分叉。

**Tech Stack:** TypeScript ESM、zod(判别联合 schema)、vitest(测试与源码共置、真实临时目录测 IO)、tsx(无构建直跑)、node:fs/path。

**设计依据:** `docs/superpowers/specs/2026-06-22-research-backbone-layer-design.md`(数据模型见 §2、存储索引 §3、CLI §4、模块 §5、分发 §6、测试 §7)。

---

## 文件结构总览

全部在 `packages/research-core/` 下(follow 约定层「文件小而专注、纯逻辑抽函数、IO 注入便于测」):

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/schema.ts` | 改 | 草案 → 完整判别联合(thread/idea/task/evidence/reference 各自 status、result、lifecycle、edge) |
| `src/schema.test.ts` | 改 | 更新草案测试为判别联合测试 |
| `src/nodeId.ts` | 建 | id ↔ 磁盘路径互转、type ↔ 目录名 |
| `src/numbering.ts` | 建 | 编号分配(扫目录取 max+1)、子编号校验 |
| `src/store.ts` | 建 | 单节点 JSON 读 / 写(原子 + .bak)/ 列举 / 存在性。纯 IO |
| `src/graph.ts` | 建 | 加载全部节点 → 内存图 + 查询(show/find/list/邻居/children 反向) |
| `src/derivedIndex.ts` | 建 | `.index/graph.json` 重建与读取 |
| `src/verbs/create.ts` | 建 | `add` / `set` |
| `src/verbs/structure.ts` | 建 | `link` / `unlink` / `contain` / `alias` |
| `src/verbs/incubate.ts` | 建 | `split` / `merge`(idea 孵化与凝结) |
| `src/verbs/lifecycle.ts` | 建 | `conclude` / `supersede` / `invalidate` / `drop` / `block` / `unblock` / `status` |
| `src/verbs/tension.ts` | 建 | `contradict` / `resolve` |
| `src/verbs/attach.ts` | 建 | `link-code` / `link-output` |
| `src/brief.ts` | 建 | 最简全局骨架的纯计算渲染 |
| `src/doctor.ts` | 改 | 增 schema 合法性 + 边引用完整性校验 |
| `src/runCli.ts` | 改 | 在 init/doctor 上 dispatch 全部动词 + 读动词 + `--json` |
| `src/index.ts` | 改 | barrel 导出新模块 |
| `bin/rlab.mjs` | 建 | 全局命令包装脚本(tsx 跑 cli.ts) |
| `scripts/smoke-backbone.ts` | 建 | 真实临时仓库端到端冒烟 |

**全程纪律:** TDD(先写失败测试)、每个动词核心是纯函数、IO 用注入或真实临时目录、频繁小步提交、提交信息中文说清「为什么」。

---

## Task 1: 完整节点 schema(判别联合)

**Files:**
- Modify: `packages/research-core/src/schema.ts`(整体替换草案)
- Modify: `packages/research-core/src/schema.test.ts`(替换草案测试)

- [ ] **Step 1: 写失败测试** — 替换 `packages/research-core/src/schema.test.ts` 全文:

```typescript
import { describe, it, expect } from 'vitest';
import {
  NodeTypeSchema,
  EvidenceResultSchema,
  EdgeSchema,
  LifecycleSchema,
  ResearchNodeSchema,
} from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };

describe('NodeTypeSchema', () => {
  it('接受五类节点', () => {
    for (const t of ['thread', 'idea', 'task', 'evidence', 'reference']) {
      expect(NodeTypeSchema.parse(t)).toBe(t);
    }
  });
  it('拒绝未知类型', () => {
    expect(() => NodeTypeSchema.parse('paper')).toThrow();
  });
});

describe('EdgeSchema', () => {
  it('自由语义边:to + label,note 可选', () => {
    const e = EdgeSchema.parse({ to: 'evidence/005', label: 'motivated-by' });
    expect(e.to).toBe('evidence/005');
    expect(e.note).toBeUndefined();
  });
  it('张力边带 state', () => {
    const e = EdgeSchema.parse({ to: 'evidence/009', label: 'contradicts', state: 'open' });
    expect(e.state).toBe('open');
  });
  it('拒绝空 to / 空 label', () => {
    expect(() => EdgeSchema.parse({ to: '', label: 'x' })).toThrow();
    expect(() => EdgeSchema.parse({ to: 'x', label: '' })).toThrow();
  });
});

describe('LifecycleSchema', () => {
  it('全部字段可选', () => {
    expect(LifecycleSchema.parse({})).toEqual({});
    const l = LifecycleSchema.parse({ supersededBy: 'task/024', at: '2026-06-22T00:00:00.000Z' });
    expect(l.supersededBy).toBe('task/024');
  });
});

describe('EvidenceResultSchema', () => {
  it('四值极性', () => {
    for (const r of ['positive', 'negative', 'inconclusive', 'mixed']) {
      expect(EvidenceResultSchema.parse(r)).toBe(r);
    }
    expect(() => EvidenceResultSchema.parse('maybe')).toThrow();
  });
});

describe('ResearchNodeSchema 判别联合', () => {
  it('thread 合法 + 默认空数组', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open',
    });
    expect(n.type).toBe('thread');
    expect(n.edges).toEqual([]);
    expect(n.aliases).toEqual([]);
    expect(n.kind).toEqual([]);
  });

  it('idea 合法', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'idea/012', type: 'idea', title: '激活值统计特征', status: 'incubating',
    });
    expect(n.type).toBe('idea');
    if (n.type === 'idea') expect(n.status).toBe('incubating');
  });

  it('task 合法,可带 expectation / code / lifecycle,无 result', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'task/007', type: 'task', title: '错误类型×位置矩阵', status: 'todo',
      expectation: '预期高层注入危害更大', code: ['experiments/007_x'],
    });
    expect(n.type).toBe('task');
    if (n.type === 'task') {
      expect(n.expectation).toBe('预期高层注入危害更大');
      expect(n.code).toEqual(['experiments/007_x']);
      expect('result' in n).toBe(false);
    }
  });

  it('evidence 合法,result 必填', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'evidence/005', type: 'evidence', title: '危害排序确认',
      status: 'active', result: 'positive', output: ['output/005_x'],
    });
    expect(n.type).toBe('evidence');
    if (n.type === 'evidence') expect(n.result).toBe('positive');
  });

  it('evidence 缺 result → 拒绝', () => {
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'evidence/006', type: 'evidence', title: 'x', status: 'active',
    })).toThrow();
  });

  it('reference 合法,带 url / citekey,无 status', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'reference/vaswani2017', type: 'reference', title: 'Attention Is All You Need',
      citekey: 'vaswani2017', url: 'https://arxiv.org/abs/1706.03762',
    });
    expect(n.type).toBe('reference');
    if (n.type === 'reference') expect(n.citekey).toBe('vaswani2017');
  });

  it('task 非法 status → 拒绝', () => {
    expect(() => ResearchNodeSchema.parse({
      ...base, id: 'task/008', type: 'task', title: 'x', status: 'incubating',
    })).toThrow();
  });

  it('携带边与生命周期', () => {
    const n = ResearchNodeSchema.parse({
      ...base, id: 'task/024', type: 'task', title: 'v2 重做', status: 'active',
      edges: [{ to: 'evidence/005', label: 'motivated-by', note: '排序需受控验证' }],
      lifecycle: { supersedes: 'task/013', at: base.updatedAt },
    });
    expect(n.edges[0].note).toBe('排序需受控验证');
    if (n.type === 'task') expect(n.lifecycle?.supersedes).toBe('task/013');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/schema.test.ts`
Expected: FAIL —— 现有草案 schema 没有 `LifecycleSchema` 导出、`ResearchNodeSchema` 是宽松对象(不会因 evidence 缺 result 报错、不按 type 收紧 status)。

- [ ] **Step 3: 实现** — 替换 `packages/research-core/src/schema.ts` 全文:

```typescript
import { z } from 'zod';

/** 节点类型:核心实验链 + 外围 reference。 */
export const NodeTypeSchema = z.enum(['thread', 'idea', 'task', 'evidence', 'reference']);
export type NodeType = z.infer<typeof NodeTypeSchema>;

/** 各类型生命周期 status。 */
export const ThreadStatusSchema = z.enum(['open', 'parked', 'concluded']);
export const IdeaStatusSchema = z.enum(['incubating', 'parked', 'crystallized', 'dropped']);
export const TaskStatusSchema = z.enum([
  'todo', 'active', 'done', 'superseded', 'invalidated', 'dropped', 'blocked',
]);
export const EvidenceStatusSchema = z.enum(['active', 'superseded', 'invalidated']);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

/** evidence 结果极性:负结果一等公民;mixed = 某条件成立另一条件不成立。 */
export const EvidenceResultSchema = z.enum(['positive', 'negative', 'inconclusive', 'mixed']);
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

/** 边:自由语义边 {to,label,note};contradicts 额外用 state。 */
export const EdgeSchema = z.object({
  to: z.string().min(1),
  label: z.string().min(1),
  note: z.string().optional(),
  state: z.enum(['open', 'resolved']).optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;

/** 生命周期后继指针(由动词写入,非边)。 */
export const LifecycleSchema = z.object({
  supersededBy: z.string().optional(),
  supersedes: z.string().optional(),
  invalidatedReason: z.string().optional(),
  droppedReason: z.string().optional(),
  blockedOn: z.array(z.string()).optional(),
  at: z.string().optional(),
});
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/** 所有节点公共字段。 */
const baseShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  parent: z.string().optional(),
  edges: z.array(EdgeSchema).default([]),
  aliases: z.array(z.string()).default([]),
  kind: z.array(z.string()).default([]),
  text: z.string().optional(),
  lifecycle: LifecycleSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const ThreadNodeSchema = z.object({
  ...baseShape, type: z.literal('thread'), status: ThreadStatusSchema,
});
export const IdeaNodeSchema = z.object({
  ...baseShape, type: z.literal('idea'), status: IdeaStatusSchema,
});
export const TaskNodeSchema = z.object({
  ...baseShape,
  type: z.literal('task'),
  status: TaskStatusSchema,
  expectation: z.string().optional(),
  code: z.array(z.string()).default([]),
});
export const EvidenceNodeSchema = z.object({
  ...baseShape,
  type: z.literal('evidence'),
  status: EvidenceStatusSchema,
  result: EvidenceResultSchema,
  output: z.array(z.string()).default([]),
  manifest: z.string().optional(),
});
export const ReferenceNodeSchema = z.object({
  ...baseShape,
  type: z.literal('reference'),
  url: z.string().optional(),
  citekey: z.string().optional(),
});

/** 节点真值类型:判别联合,按 type 收紧。 */
export const ResearchNodeSchema = z.discriminatedUnion('type', [
  ThreadNodeSchema, IdeaNodeSchema, TaskNodeSchema, EvidenceNodeSchema, ReferenceNodeSchema,
]);
export type ResearchNode = z.infer<typeof ResearchNodeSchema>;
export type ThreadNode = z.infer<typeof ThreadNodeSchema>;
export type IdeaNode = z.infer<typeof IdeaNodeSchema>;
export type TaskNode = z.infer<typeof TaskNodeSchema>;
export type EvidenceNode = z.infer<typeof EvidenceNodeSchema>;
export type ReferenceNode = z.infer<typeof ReferenceNodeSchema>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/research-core && npx vitest run src/schema.test.ts`
Expected: PASS(全部用例)。

- [ ] **Step 5: 确认 barrel 仍导出** — `src/index.ts` 已 `export * from './schema'`,无需改。跑包级类型检查:

Run: `cd packages/research-core && npm run typecheck`
Expected: 通过(无未用变量、无类型错误)。

- [ ] **Step 6: 提交**

```bash
git add packages/research-core/src/schema.ts packages/research-core/src/schema.test.ts
git commit -m "feat(research): 节点 schema 收紧为判别联合(thread/idea/task/evidence/reference)

每类型 status 独立收紧;evidence result 四值必填;task 带 expectation/code、evidence 带 output/manifest;
统一 edges(含 contradicts 的 state)与 lifecycle 后继指针。"
```

---

## Task 2: nodeId(id↔路径) + numbering(编号分配)

**Files:**
- Create: `packages/research-core/src/nodeId.ts`
- Create: `packages/research-core/src/nodeId.test.ts`
- Create: `packages/research-core/src/numbering.ts`
- Create: `packages/research-core/src/numbering.test.ts`

- [ ] **Step 1: 写 nodeId 失败测试** — 建 `packages/research-core/src/nodeId.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { typeToDir, dirToType, parseId, idToPath, isValidNumber } from './nodeId';

describe('typeToDir / dirToType', () => {
  it('五类型 ↔ 目录名互转', () => {
    expect(typeToDir('thread')).toBe('threads');
    expect(typeToDir('evidence')).toBe('evidence');
    expect(typeToDir('reference')).toBe('references');
    expect(dirToType('tasks')).toBe('task');
    expect(dirToType('evidence')).toBe('evidence');
    expect(dirToType('unknown')).toBeUndefined();
  });
});

describe('parseId', () => {
  it('拆出 type 与编号', () => {
    expect(parseId('task/007')).toEqual({ type: 'task', number: '007' });
    expect(parseId('reference/vaswani2017')).toEqual({ type: 'reference', number: 'vaswani2017' });
  });
  it('拒绝缺 / 或缺编号或非法 type', () => {
    expect(() => parseId('task')).toThrow();
    expect(() => parseId('task/')).toThrow();
    expect(() => parseId('paper/1')).toThrow();
  });
});

describe('idToPath', () => {
  it('映射到 research/nodes 下的 JSON 路径', () => {
    expect(idToPath('task/007')).toBe('research/nodes/tasks/007.json');
    expect(idToPath('thread/003')).toBe('research/nodes/threads/003.json');
    expect(idToPath('reference/vaswani2017')).toBe('research/nodes/references/vaswani2017.json');
  });
});

describe('isValidNumber', () => {
  it('接受 3 位主编号与子编号', () => {
    expect(isValidNumber('007')).toBe(true);
    expect(isValidNumber('025.1')).toBe(true);
  });
  it('reference 的 citekey 视作合法编号(非空、无斜杠空格)', () => {
    expect(isValidNumber('vaswani2017')).toBe(true);
  });
  it('拒绝空 / 含斜杠 / 含空格', () => {
    expect(isValidNumber('')).toBe(false);
    expect(isValidNumber('a/b')).toBe(false);
    expect(isValidNumber('a b')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/nodeId.test.ts`
Expected: FAIL —— `nodeId.ts` 不存在。

- [ ] **Step 3: 实现 nodeId** — 建 `packages/research-core/src/nodeId.ts`:

```typescript
import { NodeTypeSchema, type NodeType } from './schema';

const TYPE_DIR: Record<NodeType, string> = {
  thread: 'threads',
  idea: 'ideas',
  task: 'tasks',
  evidence: 'evidence',
  reference: 'references',
};
const DIR_TYPE: Record<string, NodeType> = Object.fromEntries(
  Object.entries(TYPE_DIR).map(([t, d]) => [d, t as NodeType]),
);

export function typeToDir(type: NodeType): string {
  return TYPE_DIR[type];
}

export function dirToType(dir: string): NodeType | undefined {
  return DIR_TYPE[dir];
}

/** "task/007" → { type, number };校验 type 合法、编号非空。 */
export function parseId(id: string): { type: NodeType; number: string } {
  const slash = id.indexOf('/');
  if (slash < 0) throw new Error(`非法 id(缺 "/"): ${id}`);
  const type = NodeTypeSchema.parse(id.slice(0, slash));
  const number = id.slice(slash + 1);
  if (!isValidNumber(number)) throw new Error(`非法 id(编号非法): ${id}`);
  return { type, number };
}

/** id → 相对仓库根的 JSON 路径。 */
export function idToPath(id: string): string {
  const { type, number } = parseId(id);
  return `research/nodes/${typeToDir(type)}/${number}.json`;
}

/** 主编号 NNN / 子编号 NNN.M / reference 的 citekey:非空、无斜杠与空白。 */
export function isValidNumber(number: string): boolean {
  return number.length > 0 && !/[\s/]/.test(number);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/research-core && npx vitest run src/nodeId.test.ts`
Expected: PASS。

- [ ] **Step 5: 写 numbering 失败测试** — 建 `packages/research-core/src/numbering.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextNumber } from './numbering';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-num-'));
  fs.mkdirSync(path.join(root, 'research', 'nodes', 'tasks'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('nextNumber', () => {
  it('空目录从 001 开始', () => {
    expect(nextNumber(root, 'task')).toBe('001');
  });
  it('取现有最大主编号 +1,零填充 3 位', () => {
    const dir = path.join(root, 'research', 'nodes', 'tasks');
    fs.writeFileSync(path.join(dir, '001.json'), '{}');
    fs.writeFileSync(path.join(dir, '007.json'), '{}');
    expect(nextNumber(root, 'task')).toBe('008');
  });
  it('忽略子编号文件,只按主编号取 max', () => {
    const dir = path.join(root, 'research', 'nodes', 'tasks');
    fs.writeFileSync(path.join(dir, '025.json'), '{}');
    fs.writeFileSync(path.join(dir, '025.1.json'), '{}');
    expect(nextNumber(root, 'task')).toBe('026');
  });
  it('目录不存在也返回 001', () => {
    expect(nextNumber(root, 'idea')).toBe('001');
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/numbering.test.ts`
Expected: FAIL —— `numbering.ts` 不存在。

- [ ] **Step 7: 实现 numbering** — 建 `packages/research-core/src/numbering.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { type NodeType } from './schema';
import { typeToDir } from './nodeId';

/** 扫该类型目录,返回下一个主编号(零填充 3 位)。reference 用 citekey,不走此函数。 */
export function nextNumber(root: string, type: NodeType): string {
  const dir = path.join(root, 'research', 'nodes', typeToDir(type));
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)(?:\.\d+)?\.json$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return String(max + 1).padStart(3, '0');
}
```

- [ ] **Step 8: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/numbering.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 9: 提交**

```bash
git add packages/research-core/src/nodeId.ts packages/research-core/src/nodeId.test.ts packages/research-core/src/numbering.ts packages/research-core/src/numbering.test.ts
git commit -m "feat(research): id↔路径互转(nodeId)与每类型递增编号(numbering)

nodeId 负责 type↔目录、parseId、idToPath、编号合法性;numbering 扫目录取主编号 max+1、忽略子编号。"
```

---

## Task 3: store(单节点 JSON 的原子 IO)

**Files:**
- Create: `packages/research-core/src/store.ts`
- Create: `packages/research-core/src/store.test.ts`

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from './store';
import type { ResearchNode } from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };
const task007: ResearchNode = {
  id: 'task/007', type: 'task', title: '错误类型×位置矩阵', status: 'todo',
  edges: [], aliases: [], kind: [], code: [], ...base,
};
const thread003: ResearchNode = {
  id: 'thread/003', type: 'thread', title: '方向', status: 'open',
  edges: [], aliases: [], kind: [], ...base,
};

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-store-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('NodeStore 往返', () => {
  it('write 后 exists/read 取回等值', () => {
    store.write(task007);
    expect(store.exists('task/007')).toBe(true);
    expect(store.read('task/007').title).toBe('错误类型×位置矩阵');
  });
  it('落盘路径符合 idToPath', () => {
    store.write(task007);
    expect(fs.existsSync(path.join(root, 'research/nodes/tasks/007.json'))).toBe(true);
  });
  it('覆盖写产生 .bak,内容更新', () => {
    store.write(task007);
    store.write({ ...task007, title: '改名' });
    expect(fs.existsSync(path.join(root, 'research/nodes/tasks/007.json.bak'))).toBe(true);
    expect(store.read('task/007').title).toBe('改名');
  });
  it('read 不存在 → throw', () => {
    expect(() => store.read('task/999')).toThrow();
  });
  it('tryRead 不存在 → null', () => {
    expect(store.tryRead('task/999')).toBeNull();
  });
  it('write 非法节点(evidence 缺 result) → throw', () => {
    const bad = { id: 'evidence/005', type: 'evidence', title: 'x', status: 'active',
      edges: [], aliases: [], kind: [], output: [], ...base } as unknown as ResearchNode;
    expect(() => store.write(bad)).toThrow();
  });
});

describe('NodeStore 列举', () => {
  it('list / listByType', () => {
    store.write(task007);
    store.write(thread003);
    expect(store.list()).toHaveLength(2);
    expect(store.listByType('task')).toHaveLength(1);
    expect(store.listByType('idea')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/store.test.ts`
Expected: FAIL —— `store.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/store.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { ResearchNodeSchema, NodeTypeSchema, type ResearchNode, type NodeType } from './schema';
import { idToPath, typeToDir } from './nodeId';

/** 单节点 JSON 的读 / 写 / 列举。纯 IO,不懂语义。schema 校验在读写两端都做。 */
export class NodeStore {
  constructor(private readonly root: string) {}

  private abs(id: string): string {
    return path.join(this.root, idToPath(id));
  }

  exists(id: string): boolean {
    return fs.existsSync(this.abs(id));
  }

  /** 读 + schema 校验;不存在或非法即 throw。 */
  read(id: string): ResearchNode {
    const file = this.abs(id);
    if (!fs.existsSync(file)) throw new Error(`节点不存在: ${id}`);
    return ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  tryRead(id: string): ResearchNode | null {
    return this.exists(id) ? this.read(id) : null;
  }

  /** schema 校验 → 原子写(.bak + tmp + rename)。 */
  write(node: ResearchNode): void {
    const valid = ResearchNodeSchema.parse(node);
    const file = this.abs(valid.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  listByType(type: NodeType): ResearchNode[] {
    const dir = path.join(this.root, 'research', 'nodes', typeToDir(type));
    if (!fs.existsSync(dir)) return [];
    const out: ResearchNode[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      out.push(ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    }
    return out;
  }

  list(): ResearchNode[] {
    return NodeTypeSchema.options.flatMap((t) => this.listByType(t));
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/store.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/store.ts packages/research-core/src/store.test.ts
git commit -m "feat(research): NodeStore —— 单节点 JSON 原子读写与列举

读写两端都过 schema 校验;覆盖写留 .bak、tmp+rename 原子落盘;list/listByType 扫目录。"
```

---

## Task 4: graph(内存图与查询)

**Files:**
- Create: `packages/research-core/src/graph.ts`
- Create: `packages/research-core/src/graph.test.ts`

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/graph.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ResearchGraph } from './graph';
import type { ResearchNode } from './schema';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵实验', status: 'done', parent: 'thread/003', code: [],
    edges: [{ to: 'evidence/005', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '排序确认', status: 'active', result: 'positive',
    output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'idea/012', type: 'idea', title: '激活统计', status: 'incubating', parent: 'thread/003',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];
const g = new ResearchGraph(nodes);

describe('ResearchGraph', () => {
  it('get 取节点', () => {
    expect(g.get('task/007')?.title).toBe('矩阵实验');
    expect(g.get('task/999')).toBeUndefined();
  });
  it('childrenOf 按 parent 反向', () => {
    expect(g.childrenOf('thread/003').sort()).toEqual(['idea/012', 'task/007']);
  });
  it('inEdges 反向邻接', () => {
    expect(g.inEdges('evidence/005')).toEqual([
      { from: 'task/007', edge: { to: 'evidence/005', label: 'produces' } },
    ]);
  });
  it('outEdges 出边', () => {
    expect(g.outEdges('task/007')).toEqual([{ to: 'evidence/005', label: 'produces' }]);
  });
  it('roots = 无 parent(evidence/005 无 parent,故也是 root)', () => {
    expect(g.roots().map((x) => x.id).sort()).toEqual(['evidence/005', 'thread/003']);
  });
  it('listByType / listByStatus', () => {
    expect(g.listByType('idea').map((x) => x.id)).toEqual(['idea/012']);
    expect(g.listByStatus('done').map((x) => x.id)).toEqual(['task/007']);
  });
  it('find 子串匹配(大小写不敏感,跨 id/title)', () => {
    expect(g.find('矩阵').map((x) => x.id)).toEqual(['task/007']);
    expect(g.find('THREAD/003').map((x) => x.id)).toEqual(['thread/003']);
  });
  it('subtree 含自身与全部后代', () => {
    expect(g.subtree('thread/003').map((x) => x.id).sort())
      .toEqual(['idea/012', 'task/007', 'thread/003']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/graph.test.ts`
Expected: FAIL —— `graph.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/graph.ts`:

```typescript
import { type ResearchNode, type Edge, type NodeType } from './schema';

export interface InEdge {
  from: string;
  edge: Edge;
}

/** 全量节点构成的内存图:parent 反向(children)、边反向(inbound)、查询。 */
export class ResearchGraph {
  readonly nodes = new Map<string, ResearchNode>();
  private readonly children = new Map<string, string[]>();
  private readonly inbound = new Map<string, InEdge[]>();

  constructor(nodeList: ResearchNode[]) {
    for (const n of nodeList) this.nodes.set(n.id, n);
    for (const n of nodeList) {
      if (n.parent) {
        this.children.set(n.parent, [...(this.children.get(n.parent) ?? []), n.id]);
      }
      for (const e of n.edges) {
        this.inbound.set(e.to, [...(this.inbound.get(e.to) ?? []), { from: n.id, edge: e }]);
      }
    }
  }

  get(id: string): ResearchNode | undefined {
    return this.nodes.get(id);
  }
  childrenOf(id: string): string[] {
    return this.children.get(id) ?? [];
  }
  inEdges(id: string): InEdge[] {
    return this.inbound.get(id) ?? [];
  }
  outEdges(id: string): Edge[] {
    return this.nodes.get(id)?.edges ?? [];
  }

  roots(): ResearchNode[] {
    return [...this.nodes.values()].filter((n) => !n.parent);
  }
  listByType(type: NodeType): ResearchNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }
  listByStatus(status: string): ResearchNode[] {
    return [...this.nodes.values()].filter(
      (n) => 'status' in n && (n as { status?: string }).status === status,
    );
  }

  /** 子串匹配 id/title/summary/aliases/kind,大小写不敏感。 */
  find(query: string): ResearchNode[] {
    const q = query.toLowerCase();
    return [...this.nodes.values()].filter((n) => {
      const hay = [n.id, n.title, n.summary ?? '', ...n.aliases, ...n.kind].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  /** contains 子树(含自身),深度优先。 */
  subtree(id: string): ResearchNode[] {
    const out: ResearchNode[] = [];
    const visit = (cur: string): void => {
      const n = this.nodes.get(cur);
      if (!n) return;
      out.push(n);
      for (const c of this.childrenOf(cur)) visit(c);
    };
    visit(id);
    return out;
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/graph.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/graph.ts packages/research-core/src/graph.test.ts
git commit -m "feat(research): ResearchGraph —— 内存图与查询

构造时建 parent 反向(children)与边反向(inbound);提供 get/childrenOf/inEdges/outEdges/roots/listByType/listByStatus/find/subtree。"
```

---

## Task 5: derivedIndex(派生索引,写后重建)

**Files:**
- Create: `packages/research-core/src/derivedIndex.ts`
- Create: `packages/research-core/src/derivedIndex.test.ts`

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/derivedIndex.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from './store';
import { rebuildIndex, readIndex, indexPath } from './derivedIndex';
import type { ResearchNode } from './schema';

const base = { createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' };
const task007: ResearchNode = {
  id: 'task/007', type: 'task', title: '矩阵', status: 'todo',
  edges: [], aliases: [], kind: [], code: [], ...base,
};

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-idx-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('derivedIndex', () => {
  it('rebuild 写出 .index/graph.json 且含全量节点与 builtAt', () => {
    store.write(task007);
    const data = rebuildIndex(root, store, base.updatedAt);
    expect(fs.existsSync(indexPath(root))).toBe(true);
    expect(data.nodes).toHaveLength(1);
    expect(data.builtAt).toBe(base.updatedAt);
  });
  it('readIndex 取回 rebuild 的数据', () => {
    store.write(task007);
    rebuildIndex(root, store, base.updatedAt);
    expect(readIndex(root)?.nodes[0].id).toBe('task/007');
  });
  it('readIndex 缺失 → null', () => {
    expect(readIndex(root)).toBeNull();
  });
  it('rebuild 反映 store 当前快照', () => {
    store.write(task007);
    rebuildIndex(root, store);
    store.write({ ...task007, id: 'task/008' });
    const data = rebuildIndex(root, store);
    expect(data.nodes.map((n) => n.id).sort()).toEqual(['task/007', 'task/008']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/derivedIndex.test.ts`
Expected: FAIL —— `derivedIndex.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/derivedIndex.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { type ResearchNode } from './schema';
import { NodeStore } from './store';

/** 派生缓存:全量节点快照(可重建、非第二真值)。 */
export interface IndexData {
  builtAt: string;
  nodes: ResearchNode[];
}

export function indexPath(root: string): string {
  return path.join(root, 'research', '.index', 'graph.json');
}

/** 从 store 全量快照重建 .index/graph.json(原子写),返回写入的数据。 */
export function rebuildIndex(root: string, store: NodeStore, now?: string): IndexData {
  const data: IndexData = { builtAt: now ?? new Date().toISOString(), nodes: store.list() };
  const file = indexPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return data;
}

/** 读 .index/graph.json;缺失返回 null(调用方回退现场构建)。 */
export function readIndex(root: string): IndexData | null {
  const file = indexPath(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexData;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/derivedIndex.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/derivedIndex.ts packages/research-core/src/derivedIndex.test.ts
git commit -m "feat(research): 派生索引 —— 写后全量重建 .index/graph.json

rebuildIndex 原子写全量快照、readIndex 缺失回退 null;非第二真值、可随时重建。"
```

---

## Task 6: verbs/create(add、set)

**Files:**
- Create: `packages/research-core/src/verbs/create.ts`
- Create: `packages/research-core/src/verbs/create.test.ts`

**说明:** 写动词核心是纯函数 + 注入 store;落盘由 `store.write` 做 schema 校验。索引重建由 runCli 层在动词成功后统一触发(Task 11),verbs 不自行重建。

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/verbs/create.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode, setNode } from './create';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-create-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('addNode', () => {
  it('add task 分配 001、默认 todo、落盘', () => {
    const n = addNode(root, store, { type: 'task', title: '矩阵', now });
    expect(n.id).toBe('task/001');
    expect(n.type === 'task' && n.status).toBe('todo');
    expect(store.exists('task/001')).toBe(true);
  });
  it('连续 add 递增编号', () => {
    addNode(root, store, { type: 'task', title: 'a', now });
    expect(addNode(root, store, { type: 'task', title: 'b', now }).id).toBe('task/002');
  });
  it('add reference 必须 --as(citekey)', () => {
    expect(() => addNode(root, store, { type: 'reference', title: 'Attn', now })).toThrow();
    const r = addNode(root, store, { type: 'reference', title: 'Attn', as: 'vaswani2017', url: 'http://x', now });
    expect(r.id).toBe('reference/vaswani2017');
  });
  it('add 已存在 id → throw', () => {
    addNode(root, store, { type: 'task', title: 'a', as: '007', now });
    expect(() => addNode(root, store, { type: 'task', title: 'b', as: '007', now })).toThrow();
  });
  it('add evidence 缺 result → schema 拒绝', () => {
    expect(() => addNode(root, store, { type: 'evidence', title: 'e', now })).toThrow();
  });
  it('add evidence 带 result 合法', () => {
    const e = addNode(root, store, { type: 'evidence', title: 'e', result: 'negative', now });
    expect(e.type === 'evidence' && e.result).toBe('negative');
  });
  it('parent / summary 落入节点', () => {
    const n = addNode(root, store, { type: 'idea', title: 'i', parent: 'thread/003', summary: '一句话', now });
    expect(n.parent).toBe('thread/003');
    expect(n.summary).toBe('一句话');
  });
});

describe('setNode', () => {
  it('改 title/summary 并刷新 updatedAt', () => {
    addNode(root, store, { type: 'task', title: '旧', as: '007', now });
    const later = '2026-06-23T00:00:00.000Z';
    const u = setNode(store, { id: 'task/007', title: '新', summary: '摘要', text: 'research/text/tasks/007.md', now: later });
    expect(u.title).toBe('新');
    expect(u.summary).toBe('摘要');
    expect(u.text).toBe('research/text/tasks/007.md');
    expect(u.updatedAt).toBe(later);
  });
  it('expectation 仅对 task 生效', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const u = setNode(store, { id: 'task/007', expectation: '预期阳性', now });
    expect(u.type === 'task' && u.expectation).toBe('预期阳性');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/create.test.ts`
Expected: FAIL —— `verbs/create.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/verbs/create.ts`:

```typescript
import { type ResearchNode, type NodeType, type EvidenceResult } from '../schema';
import { NodeStore } from '../store';
import { nextNumber } from '../numbering';

export interface AddInput {
  type: NodeType;
  title: string;
  parent?: string;
  summary?: string;
  expectation?: string; // task
  result?: EvidenceResult; // evidence(直接 add 时)
  url?: string; // reference
  as?: string; // 显式编号 / citekey;reference 必填
  status?: string;
  now?: string;
}

const DEFAULT_STATUS: Record<NodeType, string | undefined> = {
  thread: 'open',
  idea: 'incubating',
  task: 'todo',
  evidence: 'active',
  reference: undefined,
};

export function addNode(root: string, store: NodeStore, input: AddInput): ResearchNode {
  let number = input.as;
  if (!number) {
    if (input.type === 'reference') throw new Error('reference 必须用 --as 指定 citekey');
    number = nextNumber(root, input.type);
  }
  const id = `${input.type}/${number}`;
  if (store.exists(id)) throw new Error(`节点已存在: ${id}`);
  const now = input.now ?? new Date().toISOString();
  const common = {
    id,
    title: input.title,
    summary: input.summary,
    parent: input.parent,
    edges: [],
    aliases: [],
    kind: [],
    createdAt: now,
    updatedAt: now,
  };
  const status = input.status ?? DEFAULT_STATUS[input.type];
  let node: ResearchNode;
  switch (input.type) {
    case 'thread':
    case 'idea':
      node = { ...common, type: input.type, status } as ResearchNode;
      break;
    case 'task':
      node = { ...common, type: 'task', status, code: [], expectation: input.expectation } as ResearchNode;
      break;
    case 'evidence':
      node = { ...common, type: 'evidence', status, result: input.result, output: [] } as ResearchNode;
      break;
    case 'reference':
      node = { ...common, type: 'reference', url: input.url, citekey: number } as ResearchNode;
      break;
  }
  store.write(node); // schema 校验把关(如 evidence 缺 result → throw)
  return node;
}

export interface SetInput {
  id: string;
  title?: string;
  summary?: string;
  expectation?: string;
  text?: string; // 指向散文文件路径(如 research/text/tasks/007.md);散文内容由人/AI 自由写,CLI 只存指向
  now?: string;
}

export function setNode(store: NodeStore, input: SetInput): ResearchNode {
  const node = store.read(input.id);
  const updated: ResearchNode = { ...node, updatedAt: input.now ?? new Date().toISOString() };
  if (input.title !== undefined) updated.title = input.title;
  if (input.summary !== undefined) updated.summary = input.summary;
  if (input.text !== undefined) updated.text = input.text;
  if (input.expectation !== undefined && updated.type === 'task') updated.expectation = input.expectation;
  store.write(updated);
  return updated;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/verbs/create.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/verbs/create.ts packages/research-core/src/verbs/create.test.ts
git commit -m "feat(research): 写动词 add/set

add 按类型默认 status、自动编号(reference 用 citekey)、schema 校验落盘;set 改 title/summary/expectation 并刷新 updatedAt。"
```

---

## Task 7: verbs/structure(link、unlink、contain、alias)

**Files:**
- Create: `packages/research-core/src/verbs/structure.ts`
- Create: `packages/research-core/src/verbs/structure.test.ts`

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/verbs/structure.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import type { ResearchNode } from '../schema';
import { linkNodes, unlinkNodes, containNode, aliasNode } from './structure';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '方向', status: 'open', edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵', status: 'todo', edges: [], aliases: [], kind: [], code: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '结论', status: 'active', result: 'positive', output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];

let root: string;
let store: NodeStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-struct-'));
  store = new NodeStore(root);
  for (const n of nodes) store.write(n);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('linkNodes', () => {
  it('在 from 加自由语义边(含 note)', () => {
    const u = linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', note: '产出', now: T });
    expect(u.edges).toContainEqual({ to: 'evidence/005', label: 'produces', note: '产出' });
  });
  it('to 不存在 → throw', () => {
    expect(() => linkNodes(store, { from: 'task/007', to: 'evidence/999', label: 'x', now: T })).toThrow();
  });
});

describe('unlinkNodes', () => {
  it('删指向 to 的边;带 label 只删该 label', () => {
    linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', now: T });
    linkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'supports', now: T });
    const u = unlinkNodes(store, { from: 'task/007', to: 'evidence/005', label: 'produces', now: T });
    expect(u.edges).toEqual([{ to: 'evidence/005', label: 'supports' }]);
  });
});

describe('containNode', () => {
  it('设 parent', () => {
    const u = containNode(store, { child: 'task/007', parent: 'thread/003', now: T });
    expect(u.parent).toBe('thread/003');
  });
  it('--out 解除 parent', () => {
    containNode(store, { child: 'task/007', parent: 'thread/003', now: T });
    const u = containNode(store, { child: 'task/007', now: T });
    expect(u.parent).toBeUndefined();
  });
  it('自包含 → throw', () => {
    expect(() => containNode(store, { child: 'task/007', parent: 'task/007', now: T })).toThrow();
  });
  it('parent 不存在 → throw', () => {
    expect(() => containNode(store, { child: 'task/007', parent: 'thread/999', now: T })).toThrow();
  });
});

describe('aliasNode', () => {
  it('加别名;重复不重复加', () => {
    aliasNode(store, { id: 'task/007', name: 'ORS', now: T });
    const u = aliasNode(store, { id: 'task/007', name: 'ORS', now: T });
    expect(u.aliases).toEqual(['ORS']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/structure.test.ts`
Expected: FAIL —— `verbs/structure.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/verbs/structure.ts`:

```typescript
import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';

function touch(node: ResearchNode, now?: string): ResearchNode {
  return { ...node, updatedAt: now ?? new Date().toISOString() };
}

export interface LinkInput {
  from: string;
  to: string;
  label: string;
  note?: string;
  now?: string;
}
export function linkNodes(store: NodeStore, input: LinkInput): ResearchNode {
  const from = store.read(input.from);
  store.read(input.to); // 校验 to 存在
  const edge = input.note
    ? { to: input.to, label: input.label, note: input.note }
    : { to: input.to, label: input.label };
  const updated = { ...touch(from, input.now), edges: [...from.edges, edge] };
  store.write(updated);
  return updated;
}

export interface UnlinkInput {
  from: string;
  to: string;
  label?: string;
  now?: string;
}
export function unlinkNodes(store: NodeStore, input: UnlinkInput): ResearchNode {
  const from = store.read(input.from);
  const edges = from.edges.filter(
    (e) => !(e.to === input.to && (input.label === undefined || e.label === input.label)),
  );
  const updated = { ...touch(from, input.now), edges };
  store.write(updated);
  return updated;
}

export interface ContainInput {
  child: string;
  parent?: string; // undefined = 解除
  now?: string;
}
export function containNode(store: NodeStore, input: ContainInput): ResearchNode {
  const child = store.read(input.child);
  if (input.parent !== undefined) {
    if (input.parent === input.child) throw new Error('节点不能包含自身');
    store.read(input.parent); // 校验 parent 存在
  }
  const updated: ResearchNode = { ...touch(child, input.now), parent: input.parent };
  store.write(updated);
  return updated;
}

export interface AliasInput {
  id: string;
  name: string;
  now?: string;
}
export function aliasNode(store: NodeStore, input: AliasInput): ResearchNode {
  const node = store.read(input.id);
  if (node.aliases.includes(input.name)) return node;
  const updated = { ...touch(node, input.now), aliases: [...node.aliases, input.name] };
  store.write(updated);
  return updated;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/verbs/structure.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/verbs/structure.ts packages/research-core/src/verbs/structure.test.ts
git commit -m "feat(research): 写动词 link/unlink/contain/alias

link 加自由语义边(可带 note);unlink 按 to[+label] 删边;contain 设/解 parent(防自包含、校验存在);alias 去重加别名。"
```

---

## Task 8: verbs/incubate(split、merge)

**Files:**
- Create: `packages/research-core/src/verbs/incubate.ts`
- Create: `packages/research-core/src/verbs/incubate.test.ts`

**说明:** 体现 idea 孵化工作流 —— `split` 把模糊 idea 拆成子 idea(留在其下),`merge` 把若干 idea 凝成一个 task 并在被并 idea 上留 `crystallized-into` 血缘。两者复用 `addNode`(Task 6)。

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/verbs/incubate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { splitIdea, mergeIdeas } from './incubate';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-incub-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('splitIdea', () => {
  it('在原 idea 下建子 idea(parent 指向原 idea、递增编号)', () => {
    addNode(root, store, { type: 'idea', title: '模糊直觉', as: '001', now });
    const kids = splitIdea(root, store, { id: 'idea/001', into: ['子A', '子B'], now });
    expect(kids.map((k) => k.id)).toEqual(['idea/002', 'idea/003']);
    expect(kids.every((k) => k.parent === 'idea/001')).toBe(true);
    expect(kids[0].type).toBe('idea');
  });
  it('原 idea 不存在 → throw', () => {
    expect(() => splitIdea(root, store, { id: 'idea/099', into: ['x'], now })).toThrow();
  });
});

describe('mergeIdeas', () => {
  it('凝成 task,被并 idea 标 crystallized 并加 crystallized-into 边', () => {
    addNode(root, store, { type: 'idea', title: 'i1', as: '001', now });
    addNode(root, store, { type: 'idea', title: 'i2', as: '002', now });
    const task = mergeIdeas(root, store, { ids: ['idea/001', 'idea/002'], title: '凝成实验', now });
    expect(task.id).toBe('task/001');
    expect(task.type === 'task' && task.status).toBe('todo');
    const i1 = store.read('idea/001');
    expect(i1.type === 'idea' && i1.status).toBe('crystallized');
    expect(i1.edges).toContainEqual({ to: 'task/001', label: 'crystallized-into' });
  });
  it('被并含非 idea → throw,且不建出半成品 task', () => {
    addNode(root, store, { type: 'task', title: 't', as: '009', now });
    expect(() => mergeIdeas(root, store, { ids: ['task/009'], title: 'x', now })).toThrow();
    expect(store.exists('task/001')).toBe(false);
  });
  it('空 ids → throw', () => {
    expect(() => mergeIdeas(root, store, { ids: [], title: 'x', now })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/incubate.test.ts`
Expected: FAIL —— `verbs/incubate.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/verbs/incubate.ts`:

```typescript
import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';
import { addNode } from './create';

export interface SplitInput {
  id: string;
  into: string[];
  now?: string;
}
export function splitIdea(root: string, store: NodeStore, input: SplitInput): ResearchNode[] {
  store.read(input.id); // 校验原节点存在
  const created: ResearchNode[] = [];
  for (const title of input.into) {
    created.push(addNode(root, store, { type: 'idea', title, parent: input.id, now: input.now }));
  }
  return created;
}

export interface MergeInput {
  ids: string[];
  title: string;
  now?: string;
}
export function mergeIdeas(root: string, store: NodeStore, input: MergeInput): ResearchNode {
  if (input.ids.length === 0) throw new Error('merge 至少需要一个 idea');
  // 先全量校验(失败则不建 task,保持原子)
  const ideas = input.ids.map((id) => {
    const n = store.read(id);
    if (n.type !== 'idea') throw new Error(`merge 只接受 idea: ${id}`);
    return n;
  });
  const now = input.now ?? new Date().toISOString();
  const task = addNode(root, store, { type: 'task', title: input.title, now });
  for (const idea of ideas) {
    store.write({
      ...idea,
      status: 'crystallized',
      updatedAt: now,
      edges: [...idea.edges, { to: task.id, label: 'crystallized-into' }],
    });
  }
  return task;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/verbs/incubate.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/verbs/incubate.ts packages/research-core/src/verbs/incubate.test.ts
git commit -m "feat(research): idea 孵化动词 split/merge

split 在原 idea 下建子 idea;merge 先全量校验再凝成 task、被并 idea 标 crystallized 并留 crystallized-into 血缘。"
```

---

## Task 9: verbs/lifecycle(conclude、supersede、invalidate、drop、block、unblock、status)

**Files:**
- Create: `packages/research-core/src/verbs/lifecycle.ts`
- Create: `packages/research-core/src/verbs/lifecycle.test.ts`

**说明:** 生命周期 = 节点 status + 后继指针(`lifecycle`,公共字段)。`conclude` 复用 `addNode` 建 evidence。本层不做 `invalidate` 沿 depends-on 的连坐复查(洞察层)。

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/verbs/lifecycle.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import {
  concludeTask, supersedeNode, invalidateNode, dropNode, blockNode, unblockNode, setStatus,
} from './lifecycle';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-life-'));
  store = new NodeStore(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('concludeTask', () => {
  it('标 task done、建 evidence(result/summary)、连 produces 边', () => {
    addNode(root, store, { type: 'task', title: '矩阵', as: '007', now });
    const { task, evidence } = concludeTask(root, store, { task: 'task/007', result: 'positive', summary: '排序确认', now });
    expect(task.type === 'task' && task.status).toBe('done');
    expect(task.edges).toContainEqual({ to: evidence.id, label: 'produces' });
    expect(evidence.type === 'evidence' && evidence.result).toBe('positive');
    expect(evidence.summary).toBe('排序确认');
  });
  it('manifest / output 落到 evidence', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const { evidence } = concludeTask(root, store, { task: 'task/007', result: 'negative', manifest: 'output/007/MANIFEST.json', output: ['output/007'], now });
    expect(evidence.type === 'evidence' && evidence.manifest).toBe('output/007/MANIFEST.json');
    expect(evidence.type === 'evidence' && evidence.output).toEqual(['output/007']);
  });
  it('conclude 非 task → throw', () => {
    addNode(root, store, { type: 'idea', title: 'i', as: '001', now });
    expect(() => concludeTask(root, store, { task: 'idea/001', result: 'positive', now })).toThrow();
  });
});

describe('supersede / invalidate / drop / block / unblock', () => {
  beforeEach(() => {
    addNode(root, store, { type: 'task', title: 'v1', as: '013', now });
    addNode(root, store, { type: 'task', title: 'v2', as: '024', now });
  });
  it('supersede 改双方状态与指针', () => {
    const u = supersedeNode(store, { id: 'task/013', by: 'task/024', now });
    expect(u.type === 'task' && u.status).toBe('superseded');
    expect(u.lifecycle?.supersededBy).toBe('task/024');
    expect(store.read('task/024').lifecycle?.supersedes).toBe('task/013');
  });
  it('invalidate 记原因', () => {
    const u = invalidateNode(store, { id: 'task/013', reason: 'fi_server 参数有误', now });
    expect(u.type === 'task' && u.status).toBe('invalidated');
    expect(u.lifecycle?.invalidatedReason).toBe('fi_server 参数有误');
  });
  it('drop 记原因(可对 idea,验证 lifecycle 公共字段)', () => {
    addNode(root, store, { type: 'idea', title: '弃', as: '001', now });
    const u = dropNode(store, { id: 'idea/001', reason: '方向不值得', now });
    expect(u.type === 'idea' && u.status).toBe('dropped');
    expect(u.lifecycle?.droppedReason).toBe('方向不值得');
  });
  it('block 记 blockedOn;unblock 回 active 并清除', () => {
    const b = blockNode(store, { id: 'task/013', on: ['task/024'], now });
    expect(b.type === 'task' && b.status).toBe('blocked');
    expect(b.lifecycle?.blockedOn).toEqual(['task/024']);
    const u = unblockNode(store, { id: 'task/013', now });
    expect(u.type === 'task' && u.status).toBe('active');
    expect(u.lifecycle?.blockedOn).toBeUndefined();
  });
});

describe('setStatus', () => {
  it('合法推进 todo→active', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    const u = setStatus(store, { id: 'task/007', set: 'active', now });
    expect(u.type === 'task' && u.status).toBe('active');
  });
  it('非法状态(task 设 incubating)→ throw', () => {
    addNode(root, store, { type: 'task', title: 't', as: '007', now });
    expect(() => setStatus(store, { id: 'task/007', set: 'incubating', now })).toThrow();
  });
  it('reference 无状态 → throw', () => {
    addNode(root, store, { type: 'reference', title: 'r', as: 'k2017', now });
    expect(() => setStatus(store, { id: 'reference/k2017', set: 'active', now })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/lifecycle.test.ts`
Expected: FAIL —— `verbs/lifecycle.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/verbs/lifecycle.ts`:

```typescript
import { type ResearchNode, type EvidenceResult, type Lifecycle } from '../schema';
import { NodeStore } from '../store';
import { addNode } from './create';

/** 只更新 lifecycle(不碰 status),类型安全。 */
function patchLifecycle(node: ResearchNode, patch: Partial<Lifecycle>, now: string): ResearchNode {
  return { ...node, updatedAt: now, lifecycle: { ...(node.lifecycle ?? {}), ...patch, at: now } };
}
/** 改 status + lifecycle;status 合法性交由 store.write 的 schema 校验。 */
function transition(node: ResearchNode, status: string, patch: Partial<Lifecycle>, now: string): ResearchNode {
  return { ...node, status, updatedAt: now, lifecycle: { ...(node.lifecycle ?? {}), ...patch, at: now } } as ResearchNode;
}

export interface ConcludeInput {
  task: string;
  result: EvidenceResult;
  summary?: string;
  manifest?: string;
  output?: string[];
  as?: string;
  now?: string;
}
export function concludeTask(
  root: string,
  store: NodeStore,
  input: ConcludeInput,
): { task: ResearchNode; evidence: ResearchNode } {
  const task = store.read(input.task);
  if (task.type !== 'task') throw new Error(`conclude 只接受 task: ${input.task}`);
  const now = input.now ?? new Date().toISOString();
  const ev = addNode(root, store, {
    type: 'evidence', title: `${task.title} · 结论`, summary: input.summary, result: input.result, as: input.as, now,
  });
  if (input.manifest !== undefined || (input.output && input.output.length > 0)) {
    store.write({ ...ev, manifest: input.manifest, output: input.output ?? [], updatedAt: now } as ResearchNode);
  }
  const updatedTask = {
    ...task, status: 'done', updatedAt: now, edges: [...task.edges, { to: ev.id, label: 'produces' }],
  } as ResearchNode;
  store.write(updatedTask);
  return { task: updatedTask, evidence: store.read(ev.id) };
}

export interface SupersedeInput { id: string; by: string; reason?: string; now?: string; }
export function supersedeNode(store: NodeStore, input: SupersedeInput): ResearchNode {
  const node = store.read(input.id);
  const by = store.read(input.by);
  const now = input.now ?? new Date().toISOString();
  const patch: Partial<Lifecycle> = { supersededBy: input.by };
  if (input.reason) patch.invalidatedReason = input.reason;
  const updated = transition(node, 'superseded', patch, now);
  store.write(updated);
  store.write(patchLifecycle(by, { supersedes: input.id }, now));
  return updated;
}

export interface InvalidateInput { id: string; reason: string; now?: string; }
export function invalidateNode(store: NodeStore, input: InvalidateInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'invalidated', { invalidatedReason: input.reason }, now);
  store.write(updated);
  return updated;
}

export interface DropInput { id: string; reason: string; now?: string; }
export function dropNode(store: NodeStore, input: DropInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'dropped', { droppedReason: input.reason }, now);
  store.write(updated);
  return updated;
}

export interface BlockInput { id: string; on: string[]; now?: string; }
export function blockNode(store: NodeStore, input: BlockInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const updated = transition(node, 'blocked', { blockedOn: input.on }, now);
  store.write(updated);
  return updated;
}

export interface UnblockInput { id: string; now?: string; }
export function unblockNode(store: NodeStore, input: UnblockInput): ResearchNode {
  const node = store.read(input.id);
  const now = input.now ?? new Date().toISOString();
  const lifecycle: Lifecycle = { ...(node.lifecycle ?? {}) };
  delete lifecycle.blockedOn;
  const updated = { ...node, status: 'active', updatedAt: now, lifecycle: { ...lifecycle, at: now } } as ResearchNode;
  store.write(updated);
  return updated;
}

export interface StatusInput { id: string; set: string; now?: string; }
export function setStatus(store: NodeStore, input: StatusInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type === 'reference') throw new Error('reference 无状态');
  const updated = { ...node, status: input.set, updatedAt: input.now ?? new Date().toISOString() } as ResearchNode;
  store.write(updated); // schema 校验 status 是否对该 type 合法
  return updated;
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/verbs/lifecycle.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/verbs/lifecycle.ts packages/research-core/src/verbs/lifecycle.test.ts
git commit -m "feat(research): 生命周期动词 conclude/supersede/invalidate/drop/block/unblock/status

conclude 一步建 evidence+produces 边并标 task done;supersede 双向指针;invalidate/drop 记原因;block/unblock 管 blockedOn;status 通用推进由 schema 把关。"
```

---

## Task 10: verbs/tension(contradict、resolve) + verbs/attach(link-code、link-output)

**Files:**
- Create: `packages/research-core/src/verbs/tension.ts` + `.test.ts`
- Create: `packages/research-core/src/verbs/attach.ts` + `.test.ts`

### 10a. tension

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/verbs/tension.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { contradictNodes, resolveContradiction } from './tension';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-tension-'));
  store = new NodeStore(root);
  addNode(root, store, { type: 'evidence', title: 'e1', result: 'positive', as: '005', now });
  addNode(root, store, { type: 'evidence', title: 'e2', result: 'negative', as: '009', now });
  addNode(root, store, { type: 'task', title: '隔离实验', as: '030', now });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('contradictNodes', () => {
  it('双向加 contradicts 边(state=open,可带 note)', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', note: '设置微差', now });
    expect(store.read('evidence/005').edges).toContainEqual({ to: 'evidence/009', label: 'contradicts', state: 'open', note: '设置微差' });
    expect(store.read('evidence/009').edges).toContainEqual({ to: 'evidence/005', label: 'contradicts', state: 'open', note: '设置微差' });
  });
});

describe('resolveContradiction', () => {
  it('双向 contradicts 翻 resolved', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', now });
    const e5 = store.read('evidence/005').edges.find((e) => e.label === 'contradicts');
    expect(e5?.state).toBe('resolved');
  });
  it('--by 时双方加 resolved-by 边指向 task', () => {
    contradictNodes(store, { a: 'evidence/005', b: 'evidence/009', now });
    resolveContradiction(store, { a: 'evidence/005', b: 'evidence/009', by: 'task/030', now });
    expect(store.read('evidence/005').edges).toContainEqual({ to: 'task/030', label: 'resolved-by' });
    expect(store.read('evidence/009').edges).toContainEqual({ to: 'task/030', label: 'resolved-by' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/tension.test.ts`
Expected: FAIL —— `verbs/tension.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/verbs/tension.ts`:

```typescript
import { type ResearchNode, type Edge } from '../schema';
import { NodeStore } from '../store';

export interface ContradictInput { a: string; b: string; note?: string; now?: string; }
export function contradictNodes(store: NodeStore, input: ContradictInput): { a: ResearchNode; b: ResearchNode } {
  const a = store.read(input.a);
  const b = store.read(input.b);
  const now = input.now ?? new Date().toISOString();
  const mk = (to: string): Edge =>
    input.note
      ? { to, label: 'contradicts', state: 'open', note: input.note }
      : { to, label: 'contradicts', state: 'open' };
  const ua: ResearchNode = { ...a, updatedAt: now, edges: [...a.edges, mk(input.b)] };
  const ub: ResearchNode = { ...b, updatedAt: now, edges: [...b.edges, mk(input.a)] };
  store.write(ua);
  store.write(ub);
  return { a: ua, b: ub };
}

export interface ResolveInput { a: string; b: string; by?: string; now?: string; }
export function resolveContradiction(store: NodeStore, input: ResolveInput): { a: ResearchNode; b: ResearchNode } {
  const now = input.now ?? new Date().toISOString();
  const flip = (node: ResearchNode, other: string): ResearchNode => {
    const edges: Edge[] = node.edges.map((e) =>
      e.label === 'contradicts' && e.to === other ? { ...e, state: 'resolved' } : e,
    );
    if (input.by) edges.push({ to: input.by, label: 'resolved-by' });
    return { ...node, updatedAt: now, edges };
  };
  const a = flip(store.read(input.a), input.b);
  const b = flip(store.read(input.b), input.a);
  store.write(a);
  store.write(b);
  return { a, b };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/research-core && npx vitest run src/verbs/tension.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/verbs/tension.ts packages/research-core/src/verbs/tension.test.ts
git commit -m "feat(research): 张力动词 contradict/resolve

contradict 双向加 contradicts 边(state=open);resolve 翻 resolved,--by 给双方加 resolved-by 指向隔离 task。"
```

### 10b. attach

- [ ] **Step 6: 写失败测试** — 建 `packages/research-core/src/verbs/attach.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeStore } from '../store';
import { addNode } from './create';
import { linkCode, linkOutput } from './attach';

let root: string;
let store: NodeStore;
const now = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-attach-'));
  store = new NodeStore(root);
  addNode(root, store, { type: 'task', title: 't', as: '007', now });
  addNode(root, store, { type: 'evidence', title: 'e', result: 'positive', as: '005', now });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('linkCode', () => {
  it('给 task 加 code 路径(去重)', () => {
    linkCode(store, { id: 'task/007', path: 'experiments/007_x', now });
    const u = linkCode(store, { id: 'task/007', path: 'experiments/007_x', now });
    expect(u.type === 'task' && u.code).toEqual(['experiments/007_x']);
  });
  it('非 task → throw', () => {
    expect(() => linkCode(store, { id: 'evidence/005', path: 'x', now })).toThrow();
  });
});

describe('linkOutput', () => {
  it('给 evidence 加 output 路径并可设 manifest', () => {
    const u = linkOutput(store, { id: 'evidence/005', path: 'output/005', manifest: 'output/005/MANIFEST.json', now });
    expect(u.type === 'evidence' && u.output).toEqual(['output/005']);
    expect(u.type === 'evidence' && u.manifest).toBe('output/005/MANIFEST.json');
  });
  it('非 evidence → throw', () => {
    expect(() => linkOutput(store, { id: 'task/007', path: 'x', now })).toThrow();
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/verbs/attach.test.ts`
Expected: FAIL —— `verbs/attach.ts` 不存在。

- [ ] **Step 8: 实现** — 建 `packages/research-core/src/verbs/attach.ts`:

```typescript
import { type ResearchNode } from '../schema';
import { NodeStore } from '../store';

export interface LinkCodeInput { id: string; path: string; now?: string; }
export function linkCode(store: NodeStore, input: LinkCodeInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'task') throw new Error('link-code 只接受 task');
  const now = input.now ?? new Date().toISOString();
  const code = node.code.includes(input.path) ? node.code : [...node.code, input.path];
  const updated: ResearchNode = { ...node, code, updatedAt: now };
  store.write(updated);
  return updated;
}

export interface LinkOutputInput { id: string; path: string; manifest?: string; now?: string; }
export function linkOutput(store: NodeStore, input: LinkOutputInput): ResearchNode {
  const node = store.read(input.id);
  if (node.type !== 'evidence') throw new Error('link-output 只接受 evidence');
  const now = input.now ?? new Date().toISOString();
  const output = node.output.includes(input.path) ? node.output : [...node.output, input.path];
  const updated: ResearchNode = {
    ...node, output, updatedAt: now, ...(input.manifest ? { manifest: input.manifest } : {}),
  };
  store.write(updated);
  return updated;
}
```

- [ ] **Step 9: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/verbs/attach.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 10: 提交**

```bash
git add packages/research-core/src/verbs/attach.ts packages/research-core/src/verbs/attach.test.ts
git commit -m "feat(research): 挂接动词 link-code/link-output

link-code 给 task 挂实验代码目录、link-output 给 evidence 挂产物与 manifest,均去重并按 type 守卫。"
```

---

## Task 11: brief(最简全局骨架,纯计算)

**Files:**
- Create: `packages/research-core/src/brief.ts`
- Create: `packages/research-core/src/brief.test.ts`

**说明:** 纯遍历 `contains` 树缩进打印 `id [status] title`,evidence 附 result 极性符号。无 LLM、无 token 预算(那些留洞察层)。`seen` 去重并兜底 parent 指向缺失节点的孤儿。

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/brief.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ResearchGraph } from './graph';
import { renderBrief } from './brief';
import type { ResearchNode } from './schema';

const T = '2026-06-22T00:00:00.000Z';
const nodes: ResearchNode[] = [
  { id: 'thread/003', type: 'thread', title: '错误危害方向', status: 'open', edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'task/007', type: 'task', title: '矩阵实验', status: 'done', parent: 'thread/003', code: [],
    edges: [{ to: 'evidence/005', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'evidence/005', type: 'evidence', title: '排序确认', status: 'active', result: 'positive',
    output: [], edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
  { id: 'idea/012', type: 'idea', title: '激活统计', status: 'incubating', parent: 'thread/003',
    edges: [], aliases: [], kind: [], createdAt: T, updatedAt: T },
];
const out = renderBrief(new ResearchGraph(nodes));

describe('renderBrief', () => {
  it('thread 下缩进列出 children', () => {
    expect(out).toContain('thread/003 [open] 错误危害方向');
    expect(out).toContain('  task/007 [done] 矩阵实验');
    expect(out).toContain('  idea/012 [incubating] 激活统计');
  });
  it('evidence 附 result 极性符号', () => {
    expect(out).toContain('evidence/005 [active +] 排序确认');
  });
  it('children 按 id 排序(idea 在 task 前)', () => {
    const lines = out.split('\n');
    expect(lines.findIndex((l) => l.includes('idea/012')))
      .toBeLessThan(lines.findIndex((l) => l.includes('task/007')));
  });
  it('每个节点只出现一次', () => {
    expect(out.split('\n').filter((l) => l.includes('task/007'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/research-core && npx vitest run src/brief.test.ts`
Expected: FAIL —— `brief.ts` 不存在。

- [ ] **Step 3: 实现** — 建 `packages/research-core/src/brief.ts`:

```typescript
import { type ResearchGraph } from './graph';
import { type ResearchNode } from './schema';

const RESULT_SYMBOL: Record<string, string> = {
  positive: '+', negative: '-', inconclusive: '?', mixed: '±',
};

function statusTag(node: ResearchNode): string {
  if (node.type === 'reference') return 'ref';
  if (node.type === 'evidence') {
    const sym = RESULT_SYMBOL[node.result] ?? '';
    return `${node.status} ${sym}`.trim();
  }
  return node.status;
}

function line(node: ResearchNode, depth: number): string {
  return `${'  '.repeat(depth)}${node.id} [${statusTag(node)}] ${node.title}`;
}

/** 遍历 contains 树缩进渲染;seen 去重 + 兜底孤儿。纯计算。 */
export function renderBrief(graph: ResearchGraph): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const node = graph.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    lines.push(line(node, depth));
    for (const child of graph.childrenOf(id).slice().sort()) visit(child, depth + 1);
  };
  const all = [...graph.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of all) if (!n.parent) visit(n.id, 0);
  for (const n of all) if (!seen.has(n.id)) visit(n.id, 0); // 兜底:parent 缺失的孤儿
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `cd packages/research-core && npx vitest run src/brief.test.ts && npm run typecheck`
Expected: PASS + 类型检查通过。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/src/brief.ts packages/research-core/src/brief.test.ts
git commit -m "feat(research): 最简 brief —— contains 树缩进骨架

纯计算遍历容器树,每行 id[status]title、evidence 附 result 极性符号;seen 去重并兜底孤儿。智能摘要/预算留洞察层。"
```

---

## Task 12: doctor 增强 + runCli 全动词 dispatch + barrel

**Files:**
- Modify: `packages/research-core/src/doctor.ts`(加 schema + 边引用校验)
- Modify: `packages/research-core/src/doctor.test.ts`(若不存在则建)
- Modify: `packages/research-core/src/runCli.ts`(在 init/doctor 上加全部动词)
- Modify: `packages/research-core/src/runCli.test.ts`(若不存在则建)
- Modify: `packages/research-core/src/index.ts`(barrel 补导出)

### 12a. doctor 增强

- [ ] **Step 1: 写失败测试** — 建/替换 `packages/research-core/src/doctor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldResearchRepo } from './scaffold';
import { checkResearchRepo } from './doctor';
import { NodeStore } from './store';
import type { ResearchNode } from './schema';

let root: string;
const T = '2026-06-22T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-doctor-'));
  scaffoldResearchRepo(root, { projectName: 'T' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('checkResearchRepo 增强', () => {
  it('干净 scaffold(无节点)→ ok', () => {
    expect(checkResearchRepo(root).ok).toBe(true);
  });
  it('schema 非法的节点 → invalidNodes', () => {
    fs.writeFileSync(path.join(root, 'research/nodes/tasks/007.json'), '{"id":"task/007","type":"task"}');
    const r = checkResearchRepo(root);
    expect(r.ok).toBe(false);
    expect(r.invalidNodes).toContain('research/nodes/tasks/007.json');
  });
  it('边指向不存在节点 → danglingRefs', () => {
    const store = new NodeStore(root);
    const task: ResearchNode = {
      id: 'task/007', type: 'task', title: 't', status: 'todo', code: [],
      edges: [{ to: 'evidence/999', label: 'produces' }], aliases: [], kind: [], createdAt: T, updatedAt: T,
    };
    store.write(task);
    const r = checkResearchRepo(root);
    expect(r.ok).toBe(false);
    expect(r.danglingRefs).toContain('task/007 → evidence/999');
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/research-core && npx vitest run src/doctor.test.ts` → FAIL(DoctorReport 无 invalidNodes/danglingRefs)。

- [ ] **Step 3: 实现** — 替换 `packages/research-core/src/doctor.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_DIRS, REQUIRED_FILES } from './layout';
import { ResearchNodeSchema, NodeTypeSchema, type ResearchNode } from './schema';
import { typeToDir } from './nodeId';

export interface DoctorReport {
  ok: boolean;
  missingDirs: string[];
  missingFiles: string[];
  invalidNodes: string[];
  danglingRefs: string[];
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function scanNodes(root: string): { ids: Set<string>; invalid: string[]; valid: ResearchNode[] } {
  const ids = new Set<string>();
  const invalid: string[] = [];
  const valid: ResearchNode[] = [];
  for (const type of NodeTypeSchema.options) {
    const dir = path.join(root, 'research', 'nodes', typeToDir(type));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const rel = `research/nodes/${typeToDir(type)}/${f}`;
      try {
        const n = ResearchNodeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        ids.add(n.id);
        valid.push(n);
      } catch {
        invalid.push(rel);
      }
    }
  }
  return { ids, invalid, valid };
}

/** 校验目录/文件规范 + 节点 schema 合法性 + 边/父引用完整性。 */
export function checkResearchRepo(root: string): DoctorReport {
  const missingDirs = REQUIRED_DIRS.filter((d) => !isDir(path.join(root, d)));
  const missingFiles = REQUIRED_FILES.filter((f) => !isFile(path.join(root, f)));
  const { ids, invalid, valid } = scanNodes(root);
  const dangling: string[] = [];
  for (const n of valid) {
    if (n.parent && !ids.has(n.parent)) dangling.push(`${n.id} → ${n.parent}`);
    for (const e of n.edges) if (!ids.has(e.to)) dangling.push(`${n.id} → ${e.to}`);
  }
  const ok =
    missingDirs.length === 0 && missingFiles.length === 0 && invalid.length === 0 && dangling.length === 0;
  return { ok, missingDirs, missingFiles, invalidNodes: invalid, danglingRefs: dangling };
}
```

- [ ] **Step 4: 跑确认通过** — `cd packages/research-core && npx vitest run src/doctor.test.ts` → PASS。

### 12b. runCli 全动词 + barrel

- [ ] **Step 5: 写失败测试** — 建/替换 `packages/research-core/src/runCli.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './runCli';
import { scaffoldResearchRepo } from './scaffold';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-cli-'));
  scaffoldResearchRepo(root, { projectName: 'T' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('runCli 写读闭环', () => {
  it('add → conclude → brief 全链', () => {
    expect(runCli(['add', 'thread', '--title', '方向', '--as', '003'], root).code).toBe(0);
    expect(runCli(['add', 'task', '--title', '矩阵', '--as', '007', '--parent', 'thread/003'], root).code).toBe(0);
    expect(runCli(['conclude', 'task/007', '--result', 'positive', '--summary', '确认'], root).code).toBe(0);
    const b = runCli(['brief'], root);
    expect(b.stdout).toContain('thread/003');
    expect(b.stdout).toContain('task/007');
  });
  it('show --json 输出结构', () => {
    runCli(['add', 'idea', '--title', '灵感', '--as', '012'], root);
    const data = JSON.parse(runCli(['show', 'idea/012', '--json'], root).stdout);
    expect(data.node.id).toBe('idea/012');
  });
  it('find / list --type', () => {
    runCli(['add', 'task', '--title', '矩阵实验', '--as', '007'], root);
    expect(runCli(['find', '矩阵'], root).stdout).toContain('task/007');
    expect(runCli(['list', '--type', 'task'], root).stdout).toContain('task/007');
  });
  it('写动词后 .index 重建', () => {
    runCli(['add', 'task', '--title', 't', '--as', '007'], root);
    expect(fs.existsSync(path.join(root, 'research/.index/graph.json'))).toBe(true);
  });
  it('未知命令 → code 1', () => {
    expect(runCli(['bogus'], root).code).toBe(1);
  });
  it('动词出错(conclude 不存在 task)→ code 1 且不崩溃', () => {
    expect(runCli(['conclude', 'task/999', '--result', 'positive'], root).code).toBe(1);
  });
  it('doctor 在干净 scaffold → ok(code 0)', () => {
    expect(runCli(['doctor'], root).code).toBe(0);
  });
});
```

- [ ] **Step 6: 跑确认失败** — `cd packages/research-core && npx vitest run src/runCli.test.ts` → FAIL(动词未实现)。

- [ ] **Step 7: 实现** — 替换 `packages/research-core/src/runCli.ts` 全文:

```typescript
import path from 'node:path';
import { scaffoldResearchRepo } from './scaffold';
import { checkResearchRepo } from './doctor';
import { NodeStore } from './store';
import { ResearchGraph } from './graph';
import { rebuildIndex } from './derivedIndex';
import { renderBrief } from './brief';
import { NodeTypeSchema, type ResearchNode, type NodeType, type EvidenceResult } from './schema';
import { addNode, setNode } from './verbs/create';
import { linkNodes, unlinkNodes, containNode, aliasNode } from './verbs/structure';
import { splitIdea, mergeIdeas } from './verbs/incubate';
import {
  concludeTask, supersedeNode, invalidateNode, dropNode, blockNode, unblockNode, setStatus,
} from './verbs/lifecycle';
import { contradictNodes, resolveContradiction } from './verbs/tension';
import { linkCode, linkOutput } from './verbs/attach';

export interface CliResult {
  code: number;
  stdout: string;
}

const USAGE = [
  'rlab —— 科研工作流 CLI',
  '',
  '脚手架:  rlab init [dir] [--name N] [--force]   |   rlab doctor [dir]   |   rlab reindex [dir]',
  '安装:    rlab install   (软链 ~/.local/bin/rlab,任意仓库可用)',
  '建节点:  rlab add <type> --title T [--as N] [--parent P] [--summary S] [--result R] [--url U]',
  '改字段:  rlab set <id> [--title T] [--summary S] [--expectation E] [--text path]',
  '连边:    rlab link <from> <to> --label L [--note N]   |   rlab unlink <from> <to> [--label L]',
  '包含:    rlab contain <child> --in <parent>   |   rlab contain <child> --out',
  '孵化:    rlab split <idea> --into A,B,C   |   rlab merge <id...> --title T',
  '结论:    rlab conclude <task> --result R [--summary S] [--manifest M] [--output O1,O2]',
  '生命周期: rlab supersede <id> --by <newId> [--reason R] | invalidate <id> --reason R',
  '         rlab drop <id> --reason R | block <id> --on a,b | unblock <id> | status <id> --set S',
  '张力:    rlab contradict <a> <b> [--note N]   |   rlab resolve <a> <b> [--by <task>]',
  '挂接:    rlab alias <id> --add N | link-code <task> <path> | link-output <evidence> <path> [--manifest M]',
  '读图:    rlab brief | show <id> [--deep] | find <query> | list [--type T] [--status S]',
  '通用:    任意命令加 --json 输出结构化结果',
  '',
].join('\n');

interface Flags {
  [k: string]: string | true;
}
function parseFlags(rest: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}
function s(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}
function csv(flags: Flags, key: string): string[] | undefined {
  const v = s(flags, key);
  return v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean);
}
function nodeStatus(node: ResearchNode): string {
  return node.type === 'reference' ? 'ref' : node.status;
}
function ok(stdout: string): CliResult {
  return { code: 0, stdout: stdout.endsWith('\n') ? stdout : stdout + '\n' };
}
function fail(stdout: string): CliResult {
  return { code: 1, stdout: stdout.endsWith('\n') ? stdout : stdout + '\n' };
}
function emit(flags: Flags, human: string, data: unknown): CliResult {
  return ok(flags.json ? JSON.stringify(data, null, 2) : human);
}

function runWrite(cmd: string, root: string, store: NodeStore, pos: string[], flags: Flags): CliResult | null {
  const done = (human: string, data: unknown): CliResult => {
    rebuildIndex(root, store);
    return emit(flags, human, data);
  };
  switch (cmd) {
    case 'add': {
      const type: NodeType = NodeTypeSchema.parse(pos[0]);
      const node = addNode(root, store, {
        type,
        title: s(flags, 'title') ?? '',
        parent: s(flags, 'parent'),
        summary: s(flags, 'summary'),
        expectation: s(flags, 'expectation'),
        result: s(flags, 'result') as EvidenceResult | undefined,
        url: s(flags, 'url'),
        as: s(flags, 'as'),
      });
      return done(`已建 ${node.id}`, node);
    }
    case 'set':
      return done(`已更新 ${pos[0]}`, setNode(store, {
        id: pos[0], title: s(flags, 'title'), summary: s(flags, 'summary'),
        expectation: s(flags, 'expectation'), text: s(flags, 'text'),
      }));
    case 'link':
      return done(`已连 ${pos[0]} → ${pos[1]}`, linkNodes(store, {
        from: pos[0], to: pos[1], label: s(flags, 'label') ?? '', note: s(flags, 'note'),
      }));
    case 'unlink':
      return done(`已删边 ${pos[0]} → ${pos[1]}`, unlinkNodes(store, {
        from: pos[0], to: pos[1], label: s(flags, 'label'),
      }));
    case 'contain':
      return done(`已设容器 ${pos[0]}`, containNode(store, {
        child: pos[0], parent: flags.out ? undefined : s(flags, 'in'),
      }));
    case 'split': {
      const kids = splitIdea(root, store, { id: pos[0], into: csv(flags, 'into') ?? [] });
      return done(`已拆出 ${kids.map((k) => k.id).join(', ')}`, kids);
    }
    case 'merge': {
      const t = mergeIdeas(root, store, { ids: pos, title: s(flags, 'title') ?? '' });
      return done(`已凝成 ${t.id}`, t);
    }
    case 'conclude': {
      const r = concludeTask(root, store, {
        task: pos[0], result: s(flags, 'result') as EvidenceResult,
        summary: s(flags, 'summary'), manifest: s(flags, 'manifest'), output: csv(flags, 'output'),
      });
      return done(`${r.task.id} done,产出 ${r.evidence.id}`, r);
    }
    case 'supersede':
      return done(`${pos[0]} 被 ${s(flags, 'by')} 取代`, supersedeNode(store, {
        id: pos[0], by: s(flags, 'by') ?? '', reason: s(flags, 'reason'),
      }));
    case 'invalidate':
      return done(`${pos[0]} 已作废`, invalidateNode(store, { id: pos[0], reason: s(flags, 'reason') ?? '' }));
    case 'drop':
      return done(`${pos[0]} 已丢弃`, dropNode(store, { id: pos[0], reason: s(flags, 'reason') ?? '' }));
    case 'block':
      return done(`${pos[0]} 已阻塞`, blockNode(store, { id: pos[0], on: csv(flags, 'on') ?? [] }));
    case 'unblock':
      return done(`${pos[0]} 已解除阻塞`, unblockNode(store, { id: pos[0] }));
    case 'status':
      return done(`${pos[0]} 状态已更新为 ${s(flags, 'set')}`, setStatus(store, {
        id: pos[0], set: s(flags, 'set') ?? '',
      }));
    case 'contradict':
      return done(`${pos[0]} ⇄ ${pos[1]} 张力(open)`, contradictNodes(store, {
        a: pos[0], b: pos[1], note: s(flags, 'note'),
      }));
    case 'resolve':
      return done(`${pos[0]} ⇄ ${pos[1]} 已解决`, resolveContradiction(store, {
        a: pos[0], b: pos[1], by: s(flags, 'by'),
      }));
    case 'alias':
      return done(`${pos[0]} 加别名 ${s(flags, 'add')}`, aliasNode(store, { id: pos[0], name: s(flags, 'add') ?? '' }));
    case 'link-code':
      return done(`${pos[0]} 挂代码 ${pos[1]}`, linkCode(store, { id: pos[0], path: pos[1] }));
    case 'link-output':
      return done(`${pos[0]} 挂产物 ${pos[1]}`, linkOutput(store, {
        id: pos[0], path: pos[1], manifest: s(flags, 'manifest'),
      }));
    default:
      return null;
  }
}

function renderShow(graph: ResearchGraph, node: ResearchNode, deep: boolean): string {
  const lines = [`${node.id} [${nodeStatus(node)}] ${node.title}`];
  if (node.summary) lines.push(`  摘要: ${node.summary}`);
  for (const e of node.edges) lines.push(`  → ${e.to} (${e.label}${e.note ? ': ' + e.note : ''})`);
  for (const ie of graph.inEdges(node.id)) lines.push(`  ← ${ie.from} (${ie.edge.label})`);
  if (deep) for (const c of graph.subtree(node.id).slice(1)) lines.push(`  ⊂ ${c.id} ${c.title}`);
  return lines.join('\n');
}

function runRead(cmd: string, store: NodeStore, pos: string[], flags: Flags): CliResult | null {
  const graph = new ResearchGraph(store.list());
  switch (cmd) {
    case 'brief':
      return emit(flags, renderBrief(graph), { brief: renderBrief(graph) });
    case 'show': {
      const node = graph.get(pos[0]);
      if (!node) return fail(`节点不存在: ${pos[0]}`);
      const data = { node, inEdges: graph.inEdges(pos[0]), subtree: flags.deep ? graph.subtree(pos[0]) : undefined };
      return emit(flags, renderShow(graph, node, flags.deep === true), data);
    }
    case 'find': {
      const hits = graph.find(pos[0] ?? '');
      return emit(flags, hits.map((n) => `${n.id}  ${n.title}`).join('\n') || '(无匹配)', hits);
    }
    case 'list': {
      const t = s(flags, 'type');
      const st = s(flags, 'status');
      const nodes = [...graph.nodes.values()]
        .filter((n) => (!t || n.type === t) && (!st || nodeStatus(n) === st))
        .sort((a, b) => a.id.localeCompare(b.id));
      return emit(flags, nodes.map((n) => `${n.id}  ${n.title}`).join('\n') || '(空)', nodes);
    }
    default:
      return null;
  }
}

export function runCli(argv: string[], cwd: string): CliResult {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return ok(USAGE);
  const { pos, flags } = parseFlags(rest);

  if (cmd === 'init') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const report = scaffoldResearchRepo(root, {
      projectName: s(flags, 'name') ?? path.basename(root),
      force: flags.force === true,
    });
    return ok([
      'rlab init: ' + root,
      'created: ' + (report.created.length ? report.created.join(', ') : '(无)'),
      'skipped: ' + (report.skipped.length ? report.skipped.join(', ') : '(无)'),
      '',
      '下一步: 填写 docs/overview.md(研究宪章),然后 rlab add thread 起第一个方向。',
    ].join('\n'));
  }

  if (cmd === 'doctor') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const r = checkResearchRepo(root);
    if (r.ok) return ok('rlab doctor: ok —— ' + root);
    return fail([
      'rlab doctor: 不合规 —— ' + root,
      'missing dirs:  ' + (r.missingDirs.join(', ') || '(无)'),
      'missing files: ' + (r.missingFiles.join(', ') || '(无)'),
      'invalid nodes: ' + (r.invalidNodes.join(', ') || '(无)'),
      'dangling refs: ' + (r.danglingRefs.join(', ') || '(无)'),
    ].join('\n'));
  }

  if (cmd === 'reindex') {
    const root = path.resolve(cwd, pos[0] ?? '.');
    const data = rebuildIndex(root, new NodeStore(root));
    return ok(`rlab reindex: ${data.nodes.length} 个节点 → research/.index/graph.json`);
  }

  const store = new NodeStore(cwd);
  try {
    return runWrite(cmd, cwd, store, pos, flags) ?? runRead(cmd, store, pos, flags) ?? fail(`未知命令: ${cmd}\n\n${USAGE}`);
  } catch (e) {
    return fail(`错误: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 8: 实现 barrel** — 替换 `packages/research-core/src/index.ts`:

```typescript
export * from './schema';
export * from './layout';
export * from './templates';
export * from './scaffold';
export * from './doctor';
export * from './nodeId';
export * from './numbering';
export * from './store';
export * from './graph';
export * from './derivedIndex';
export * from './brief';
export * from './verbs/create';
export * from './verbs/structure';
export * from './verbs/incubate';
export * from './verbs/lifecycle';
export * from './verbs/tension';
export * from './verbs/attach';
export * from './runCli';
```

- [ ] **Step 9: 跑全包测试 + 类型检查**

Run: `cd packages/research-core && npx vitest run && npm run typecheck`
Expected: 全部 PASS + 类型检查通过(若 barrel 有重名导出冲突，在此暴露并改名解决)。

- [ ] **Step 10: 提交**

```bash
git add packages/research-core/src/doctor.ts packages/research-core/src/doctor.test.ts packages/research-core/src/runCli.ts packages/research-core/src/runCli.test.ts packages/research-core/src/index.ts
git commit -m "feat(research): doctor 校验节点 schema+引用完整性;runCli 接全部读写动词

doctor 增 invalidNodes/danglingRefs;runCli dispatch add/set/link/contain/split/merge/conclude/生命周期/张力/挂接 + show/find/list/brief,写动词后重建索引,--json 双输出;barrel 补导出。"
```

---

## Task 13: 全局分发(bin/rlab + install)

**Files:**
- Create: `packages/research-core/src/install.ts` + `.test.ts`
- Create: `packages/research-core/bin/rlab.mjs`
- Modify: `packages/research-core/package.json`(加 bin、script 改名)
- Modify: `packages/research-core/src/runCli.ts`(加 install case)
- Modify: `packages/research-core/src/index.ts`(导出 install)

**目标:** 同机任意目录(含无 Node 的 Python 项目 sample-finetune)可执行 `rlab`,操作其所在仓库的 `research/`。无构建步,tsx 直跑源码。

- [ ] **Step 1: 写失败测试** — 建 `packages/research-core/src/install.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRlab } from './install';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-install-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('installRlab', () => {
  it('软链 binScript → targetDir/rlab', () => {
    const binScript = path.join(root, 'rlab.mjs');
    fs.writeFileSync(binScript, '#!/usr/bin/env node\n');
    const target = installRlab(binScript, path.join(root, 'bin'));
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readlinkSync(target)).toBe(binScript);
  });
  it('幂等:重复装覆盖、不报错', () => {
    const binScript = path.join(root, 'rlab.mjs');
    fs.writeFileSync(binScript, '#!/usr/bin/env node\n');
    const t1 = installRlab(binScript, path.join(root, 'bin'));
    const t2 = installRlab(binScript, path.join(root, 'bin'));
    expect(t2).toBe(t1);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd packages/research-core && npx vitest run src/install.test.ts` → FAIL(install.ts 不存在)。

- [ ] **Step 3: 实现 install** — 建 `packages/research-core/src/install.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';

/** 幂等软链 binScript → targetDir/rlab。返回 target 路径。 */
export function installRlab(binScript: string, targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  try {
    fs.chmodSync(binScript, 0o755);
  } catch {
    /* 测试占位脚本可能无权限,忽略 */
  }
  const target = path.join(targetDir, 'rlab');
  try {
    fs.lstatSync(target);
    fs.unlinkSync(target); // 已存在则先删(幂等)
  } catch {
    /* 不存在 */
  }
  fs.symlinkSync(binScript, target);
  return target;
}
```

- [ ] **Step 4: 跑确认通过** — `cd packages/research-core && npx vitest run src/install.test.ts` → PASS。

- [ ] **Step 5: 建包装脚本** — 建 `packages/research-core/bin/rlab.mjs`:

```javascript
#!/usr/bin/env node
// 全局 rlab 命令包装:用 tsx 跑 research-core 的 cli.ts,工作目录为调用方 cwd。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../packages/research-core/bin
const cli = path.join(here, '..', 'src', 'cli.ts');
// tsx 可能在本包或被 monorepo 根 hoist;都找不到则退回 PATH 上的 tsx
const candidates = [
  path.join(here, '..', 'node_modules', '.bin', 'tsx'),
  path.join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx'),
];
const tsx = candidates.find((p) => fs.existsSync(p)) ?? 'tsx';
const r = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
process.exit(r.status ?? 1);
```

- [ ] **Step 6: 改 package.json** — 把 `"research": "tsx src/cli.ts"` 改名并加 `bin`。将:

```json
    "research": "tsx src/cli.ts"
  },
  "dependencies":
```

替换为:

```json
    "rlab": "tsx src/cli.ts"
  },
  "bin": { "rlab": "./bin/rlab.mjs" },
  "dependencies":
```

- [ ] **Step 7: runCli 加 install case + barrel 导出** — 在 `runCli.ts` 顶部 import 补:

```typescript
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { installRlab } from './install';
```

在 `runCli` 函数里 `reindex` 分支之后、`const store = new NodeStore(cwd);` 之前插入:

```typescript
  if (cmd === 'install') {
    const here = path.dirname(fileURLToPath(import.meta.url)); // .../src
    const binScript = path.join(here, '..', 'bin', 'rlab.mjs');
    const targetDir = path.join(os.homedir(), '.local', 'bin');
    const target = installRlab(binScript, targetDir);
    return ok(`已软链 ${target} → ${binScript}\n确保 ${targetDir} 在 PATH(如 export PATH="$HOME/.local/bin:$PATH")。`);
  }
```

在 `index.ts` barrel 追加一行 `export * from './install';`。

- [ ] **Step 8: 跑测试 + 类型检查 + 真实安装验证**

```bash
cd packages/research-core && npx vitest run && npm run typecheck
# 真实安装并在另一目录验证(模拟 sample-finetune 那样的外部仓库)
npx tsx src/cli.ts install
SMOKE=$(mktemp -d) && (cd "$SMOKE" && ~/.local/bin/rlab init && ~/.local/bin/rlab add thread --title 外部仓库测试 --as 001 && ~/.local/bin/rlab brief)
rm -rf "$SMOKE"
```
Expected: 测试 + 类型检查通过;`rlab` 在外部临时目录能 init/add/brief,操作的是该目录的 `research/`。

- [ ] **Step 9: 提交**

```bash
git add packages/research-core/src/install.ts packages/research-core/src/install.test.ts packages/research-core/bin/rlab.mjs packages/research-core/package.json packages/research-core/src/runCli.ts packages/research-core/src/index.ts
git commit -m "feat(research): 全局分发 —— bin/rlab 包装 + rlab install 幂等软链

包装脚本用 tsx 跑 cli.ts、cwd 为调用方目录;rlab install 幂等软链到 ~/.local/bin/rlab,任意科研仓库(含 Python 项目)可用;package.json 加 bin、script 改名 rlab。"
```

---

## Task 14: 真实集成冒烟

**Files:**
- Create: `packages/research-core/scripts/smoke-backbone.ts`
- Modify: `packages/research-core/package.json`(加 smoke script)

**说明:** 对照 spec §4「三个必须扛住的意外」跑真实端到端 —— 建图→结论→矛盾→解决→取代→作废→孵化→brief→doctor,任一步非 0 退出即失败。这是 CLAUDE.md 要求的「真实集成验证」。

- [ ] **Step 1: 建冒烟脚本** — 建 `packages/research-core/scripts/smoke-backbone.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/runCli';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-smoke-'));
function run(args: string[]): void {
  const r = runCli(args, root);
  process.stdout.write(`$ rlab ${args.join(' ')}\n${r.stdout}\n`);
  if (r.code !== 0) {
    process.stderr.write(`❌ 失败: rlab ${args.join(' ')}\n`);
    process.exit(1);
  }
}

run(['init']);
run(['add', 'thread', '--title', '错误危害方向', '--as', '003', '--summary', '研究错误注入危害']);
run(['add', 'idea', '--title', '激活值统计特征', '--as', '012', '--parent', 'thread/003']);
run(['add', 'task', '--title', '错误类型×位置矩阵', '--as', '007', '--parent', 'thread/003', '--expectation', '高层注入危害更大']);
run(['link-code', 'task/007', 'experiments/007_matrix']);
run(['conclude', 'task/007', '--result', 'positive', '--summary', '危害排序确认', '--output', 'output/007', '--manifest', 'output/007/MANIFEST.json']);
run(['add', 'task', '--title', '重测矩阵', '--as', '008', '--parent', 'thread/003']);
run(['conclude', 'task/008', '--result', 'negative', '--summary', '相反结论']);
run(['contradict', 'evidence/001', 'evidence/002', '--note', '设置微差导致结论相反']);
run(['add', 'task', '--title', '隔离哪个旋钮', '--as', '009']);
run(['resolve', 'evidence/001', 'evidence/002', '--by', 'task/009']);
run(['supersede', 'task/007', '--by', 'task/008', '--reason', '换更优设计']);
run(['invalidate', 'evidence/002', '--reason', 'fi_server 配置有误']);
run(['merge', 'idea/012', '--title', '凝成激活统计实验']);
run(['brief']);
run(['doctor']);

process.stdout.write('✅ 骨干层冒烟通过(init→建图→结论→张力→解决→取代→作废→孵化→brief→doctor 全绿)\n');
fs.rmSync(root, { recursive: true, force: true });
```

- [ ] **Step 2: package.json 加 smoke script** — 将:

```json
    "rlab": "tsx src/cli.ts"
  },
```

替换为:

```json
    "rlab": "tsx src/cli.ts",
    "smoke": "tsx scripts/smoke-backbone.ts"
  },
```

- [ ] **Step 3: 跑冒烟确认全链绿**

Run: `cd packages/research-core && npm run smoke`
Expected: 每条命令打印输出且 0 退出;最后打印「✅ 骨干层冒烟通过」;`doctor` 报 ok(图引用完整)。

- [ ] **Step 4: 跑全量测试 + 类型检查最终确认**

Run: `cd packages/research-core && npm test && npm run typecheck`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/research-core/scripts/smoke-backbone.ts packages/research-core/package.json
git commit -m "test(research): 骨干层真实集成冒烟

端到端跑 init→建图→conclude→contradict→resolve→supersede→invalidate→merge→brief→doctor,验证图自洽、引用完整。"
```

---

## 完成标准

全部 14 个任务做完后:

- `packages/research-core` 提供完整的带类型科研图:schema 判别联合、store 原子 IO、graph 查询、派生索引、全套读写动词、最简 brief。
- `rlab` CLI 可在任意科研仓库(含 Python 项目)init/建图/查询;写动词后索引自动重建;`doctor` 守 schema 与引用完整性;`--json` 供后端消费。
- 全量单测 + 真实冒烟绿;`@rcc/shared` 与 `@rcc/server` 既有测试不受影响。
- 后续层(洞察:brief 智能摘要/next/连坐;呈现:remote-cc 后端与网页)在此核心库上增量构建。
