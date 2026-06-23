# AskUserQuestion hook 驱动 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本会话内 inline 执行）。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 把聊天模式 `AskUserQuestion` 的「检测/取选项/作答」从读屏改为 PreToolUse/PostToolUse hook 真值 + 绝对数字键作答，读屏仅作兜底，行为并行增量、单选一等公民。

**Architecture:** claude 启动注入 `--settings`（仅 AskUserQuestion 的 Pre/PostToolUse hook）+ `RCC_ASK_DIR` env；hook 脚本把工具输入落 sidecar（pre 写、post 删）；`ChatSession.tick` 读 sidecar 发 `ask_pending`（含问题正文/说明/多选/多问题进度）；`AskDriver` 用字面量数字键绝对作答（可选按前确认），完成由 sidecar 消失确认；hook 不可用时整条退回既有 `parseAskPickerLive`/`AskController`。

**Tech Stack:** TypeScript, Node, vitest（测试与源码共置），React, tmux。

---

## 文件结构

- 新 `apps/server/scripts/hooks/rcc-ask-hook.mjs` — node hook（pre 写 / post 删 sidecar）。
- 新 `apps/server/src/lib/session/chat/askSidecar.ts`(+`.test.ts`) — 读 sidecar + 映射协议。
- 新 `apps/server/src/lib/session/chat/askHookSettings.ts`(+`.test.ts`) — 幂等写 settings、拼 launch 注入串。
- 新 `apps/server/src/lib/session/chat/askDriver.ts`(+`.test.ts`) — 绝对数字键作答 + 可选按前确认 + 兜底信号。
- 改 `apps/server/src/lib/session/tmux.ts`(+`.test.ts`) — 加 `sendLiteralKeys`。
- 改 `apps/server/src/lib/session/chat/chatSession.ts`(+`.test.ts`) — launch 注入、tick sidecar 检测、driver 作答、多问题推进、getLiveAsk。
- 改 `packages/shared/src/chatWs.ts`(+`chatWs.test.ts`) — AskPending/AskPendingOption/ask_pending 增字段。
- 改 `apps/server/src/routes/chat.ts` — onAskPending 透传新字段。
- 改 `apps/server/src/context.ts`（或会话装配处）— 启动幂等 ensure settings、把 askDir/settingsArg/readAskSidecar 注入会话 deps。
- 改 `apps/web/src/lib/chatWs.ts` / `components/chat/ChatView.tsx` / `components/chat/LiveAskCard.tsx` — 透传并渲染富卡片。
- 改 `apps/server/scripts/smoke-ask-live.ts` — 注入 hook 的真机冒烟。

---

## Task 1: 协议扩字段（shared）

**Files:** Modify `packages/shared/src/chatWs.ts`; Test `packages/shared/src/chatWs.test.ts`

- [ ] **Step 1 写失败测试**：在 chatWs.test.ts 加：encode/decode `ask_pending` 往返保留 `question/header/qIndex/qTotal` 与 option.description。
```ts
it('ask_pending 携带问题正文/说明/多问题进度往返', () => {
  const msg = { type: 'ask_pending', question: 'Pick a fruit', header: 'Fruit', qIndex: 0, qTotal: 2, multiSelect: false,
    options: [{ index: 0, label: 'Apple', description: '苹果' }, { index: 1, label: 'Banana' }] } as const;
  const round = JSON.parse(encodeChatServer(msg));
  expect(round).toEqual(msg);
});
```
- [ ] **Step 2 跑测试看失败**：`npm test -w @rcc/shared -- chatWs`（类型不含新字段→TS 编译/断言失败）。
- [ ] **Step 3 实现**：`AskPendingOption` 增 `description?: string`；`AskPending` 增 `question?: string; header?: string; qIndex?: number; qTotal?: number`；`ask_pending` 消息类型同步增这四个可选字段。
- [ ] **Step 4 跑测试看通过**。
- [ ] **Step 5 提交**：`feat(shared): ask_pending 增问题正文/说明/多问题进度字段`。

## Task 2: hook 脚本

**Files:** Create `apps/server/scripts/hooks/rcc-ask-hook.mjs`; Test `apps/server/src/lib/session/chat/askHook.script.test.ts`

脚本逻辑：读 stdin JSON；`RCC_ASK_DIR` 未设→exit 0；`pre`→原子写 `${dir}/${session_id}.json={toolUseId,questions,ts}`；`post`→删该文件；任何异常 exit 0。

- [ ] **Step 1 写失败测试**（用 `execFileSync('node', [script,'pre'])`，喂 stdin、设 env，断言 sidecar 内容；再 `post` 断言被删；`RCC_ASK_DIR` 未设时不抛、无文件）。
- [ ] **Step 2 跑测试看失败**（脚本不存在）。
- [ ] **Step 3 实现脚本**。
- [ ] **Step 4 跑测试看通过**。
- [ ] **Step 5 提交**：`feat(server): AskUserQuestion 捕获 hook 脚本(pre 写/post 删 sidecar)`。

## Task 3: askSidecar（读 + 映射）

**Files:** Create `askSidecar.ts` + `.test.ts`

接口：
```ts
export interface AskHookOption { label: string; description?: string }
export interface AskHookQuestion { question: string; header?: string; options: AskHookOption[]; multiSelect: boolean }
export interface AskHookPending { toolUseId: string; questions: AskHookQuestion[]; ts: number }
export function askSidecarPath(dir: string, sessionId: string): string
export function readPendingAsk(dir: string, sessionId: string): AskHookPending | null  // 缺/坏→null
export function toAskPending(p: AskHookPending, qIndex: number): AskPending  // 映射第 qIndex 题
```
- [ ] **Step 1 写失败测试**：临时目录写一个合法 sidecar→readPendingAsk 得结构；坏 JSON/缺文件→null；toAskPending 把 options→{index,label,description}、带 question/header/qIndex/qTotal、multiSelect。
- [ ] **Step 2 跑失败**。
- [ ] **Step 3 实现**（`fs.readFileSync` try/catch；映射纯函数）。
- [ ] **Step 4 跑通过**。
- [ ] **Step 5 提交**：`feat(server): askSidecar 读取 hook 落盘并映射为 AskPending(TDD)`。

## Task 4: askHookSettings（幂等写 settings + 拼注入串）

**Files:** Create `askHookSettings.ts` + `.test.ts`

```ts
export function buildAskHookSettings(hookScriptAbsPath: string): object  // {hooks:{PreToolUse:[{matcher:'AskUserQuestion',hooks:[{type:'command',command:`node "${p}" pre`}]}],PostToolUse:[…post]}}
export function ensureAskHookSettings(io: { mkdir; writeFile; readFile? }, opts: { askDir; hookScriptPath; settingsPath }): void  // mkdir askDir+settings 父目录；写 settings JSON（幂等：内容相同可跳过）
export function askLaunchExtra(askDir: string, settingsPath: string): { envExport: string; settingsArg: string }
//  envExport=`export RCC_ASK_DIR='${askDir}'; `  settingsArg=`--settings '${settingsPath}'`
```
- [ ] **Step 1 写失败测试**：buildAskHookSettings 含两 matcher 与绝对路径；ensure 写出可解析 JSON 且含绝对 hook 路径；askLaunchExtra 拼串正确。
- [ ] **Step 2 跑失败**。
- [ ] **Step 3 实现**。
- [ ] **Step 4 跑通过**。
- [ ] **Step 5 提交**：`feat(server): askHookSettings 幂等装配 --settings hook(TDD)`。

## Task 5: tmux.sendLiteralKeys

**Files:** Modify `tmux.ts`; Test `tmux.test.ts`

```ts
/** 发送字面量字符（数字键作答用），避免被当作按键名。tmux send-keys -l。 */
async sendLiteralKeys(name: string, text: string): Promise<void> {
  await this.exec('tmux', [...this.base(), 'send-keys', '-t', name, '-l', text]);
}
```
- [ ] **Step 1 写失败测试**：fake exec 断言 argv 末尾 `['send-keys','-t',name,'-l','1']`。
- [ ] **Step 2 跑失败**。
- [ ] **Step 3 实现**。
- [ ] **Step 4 跑通过**。
- [ ] **Step 5 提交**：`feat(server): Tmux.sendLiteralKeys(字面量按键,作答数字键用)`。

## Task 6: AskDriver（绝对数字键 + 按前确认 + 兜底信号）

**Files:** Create `askDriver.ts` + `.test.ts`

```ts
export interface AskDriverTmux { capturePaneVisible(n:string):Promise<string>; sendLiteralKeys(n:string,t:string):Promise<void>; sendKeys(n:string,k:string[]):Promise<void>; }
export interface AskDriverResult { ok: boolean; fallback?: boolean; error?: string }
export class AskDriver {
  constructor(name, tmux: AskDriverTmux, opts?: { guard?: boolean; settleMs?: number })
  async answer(options: {label:string}[], optionIndices: number[], multiSelect: boolean): Promise<AskDriverResult>
}
```
逻辑：multiSelect 或 indices.length!==1 或 (index+1)>9 → `{ok:false,fallback:true}`（交调用方转 AskController）。单选：guard 开→capturePaneVisible，断言存在 `^\s*❯?\s*${n}\.\s+<label>`（label trim、正则转义）；不命中→`{ok:false,fallback:true}`。命中（或 guard 关）→`sendLiteralKeys(name, String(index+1))`→`{ok:true}`（完成由上层经 sidecar 消失确认）。

- [ ] **Step 1 写失败测试**（fake tmux 记录调用）：
  - 单选 guard 关：answer([A,B,C],[2],false)→发 `'3'`、ok。
  - 单选 guard 开命中：pane 含 `❯ 3. Cherry`→发 `'3'`、ok。
  - 单选 guard 开不命中：pane 无该行→不发键、`fallback:true`。
  - 多选→不发键、`fallback:true`。
  - index+1>9→`fallback:true`。
- [ ] **Step 2 跑失败**。
- [ ] **Step 3 实现**。
- [ ] **Step 4 跑通过**。
- [ ] **Step 5 提交**：`feat(server): AskDriver 绝对数字键作答+按前确认(TDD)`。

## Task 7: chatSession 集成

**Files:** Modify `chatSession.ts` + `chatSession.test.ts`

改动：
1. `ChatSessionDeps` 增 `askDir?: string; askSettingsArg?: string; readAskSidecar?: (dir,sid)=>AskHookPending|null; makeAskDriver?: (name,tmux)=>AskDriver-like`。
2. `ensure()`：`const extra = this.deps.askDir ? \`export RCC_ASK_DIR='${this.deps.askDir}'; \` : ''; const settings = this.deps.askSettingsArg ? \` ${this.deps.askSettingsArg}\` : '';` 命令拼为 `${extra}${launchCommand} ${effort} ${idFlag}${settings}`。
3. tick()：HUD 段之后、`parseAskPickerLive` 之前插入 hook 段——`if (this.deps.askDir) { const p = (readAskSidecar??readPendingAsk)(dir,sid); if (p) { qi=this.askQIndex; ap=toAskPending(p,qi); sig=p.toolUseId+'#'+qi; 变则 emit onAskPending+记 lastAsk; running→false; holdPreview=false; return; } else if (this.lastAskSig){清+askQIndex=0+onAskPendingClear;} }` 且仅 `!this.deps.askDir` 时跑既有 `parseAskPickerLive` 段（其余一字不改）。
4. `answerPendingAsk`：hook 模式读 sidecar 取 `questions[askQIndex]`，`makeAskDriver().answer(opts,indices,multiSelect)`；`fallback`→`ensureAsk().answerCurrent`；成功→`advanceQ`（未到末题则 `askQIndex++`、`lastAskSig=''` 触发下题重发）；失败→`onAskPendingFailed`。非 hook 模式走既有。
5. `getLiveAsk()`：hook 模式 `const p=read(dir,sid); return p?toAskPending(p,this.askQIndex):null;` 否则既有 `this.lastAsk`。
6. 新私有 `askQIndex=0`、`ensureAskDriver()`。

- [ ] **Step 1 写失败测试**（注入 fake tmux + fake readAskSidecar + fake driver）：
  - sidecar 有→tick 发 `onAskPending`（含 description/question/qTotal）、`running=false`、不发 `onPreview`。
  - sidecar 由有转无→`onAskPendingClear`。
  - `answerPendingAsk([0])` hook 模式→调 driver.answer；driver `fallback`→调 `answerCurrent`；driver 失败→`onAskPendingFailed`。
  - 多问题：answer 第 0 题成功→askQIndex 进到 1，下个 tick 发第 1 题（qIndex=1）。
  - `ensure()` 注入 askDir/settingsArg→命令含 `export RCC_ASK_DIR=` 与 `--settings`。
  - `askDir` 未设→既有 `parseAskPickerLive` 路径与既有 35 用例全绿（回归）。
- [ ] **Step 2 跑失败**。
- [ ] **Step 3 实现**。
- [ ] **Step 4 跑通过**（含既有 35 用例）。
- [ ] **Step 5 提交**：`feat(server): chatSession 接 hook 检测+数字键作答+多问题推进(TDD)`。

## Task 8: 路由透传新字段

**Files:** Modify `routes/chat.ts`

- [ ] **Step 1**：`onAskPending` 改为透传全部字段：`(a) => send({ type:'ask_pending', options:a.options, multiSelect:a.multiSelect, question:a.question, header:a.header, qIndex:a.qIndex, qTotal:a.qTotal })`。（`app.test.ts` 现有用例须仍绿。）
- [ ] **Step 2 跑** `npm test -w @rcc/server -- app.test`。
- [ ] **Step 3 提交**：`feat(server): chat 路由透传 ask_pending 富字段`。

## Task 9: 装配处幂等 ensure + 注入会话 deps

**Files:** Modify 会话装配处（`context.ts` 或 `chatRegistry`/`registry` 构造会话 deps 的地方；执行时 grep `new ChatSession(` / `ChatSessionDeps` 定位）

- [ ] **Step 1**：读环境 `RCC_ASK_DIR`（默认 `~/.claude/rcc-ask`）；abs hook 路径 = `<serverRoot>/scripts/hooks/rcc-ask-hook.mjs`；settingsPath = `<askDir>/ask-hooks.settings.json`。启动时 `ensureAskHookSettings(...)` 一次；构造会话 deps 时传 `askDir`、`askSettingsArg=askLaunchExtra(...).settingsArg`、`readAskSidecar=readPendingAsk`。
- [ ] **Step 2**：`npm run typecheck` 通过。
- [ ] **Step 3 提交**：`feat(server): 启动幂等装配 ask hook 并注入会话(默认 ~/.claude/rcc-ask)`。

## Task 10: 前端富卡片

**Files:** Modify `apps/web/src/lib/chatWs.ts`、`components/chat/ChatView.tsx`、`components/chat/LiveAskCard.tsx`

- [ ] **Step 1**：`chatWs.ts` 的 `onAskPending` 类型与透传增 `question?/header?/qIndex?/qTotal?` 及 option.description；`ask_pending` case 传全字段。
- [ ] **Step 2**：`ChatView.tsx` 的 `livePending` state 类型增同字段；`onAskPending` 存全量；`<LiveAskCard …/>` 传 `question/header/qIndex/qTotal`。
- [ ] **Step 3**：`LiveAskCard.tsx` 顶部显示 `question`（无则回退原「Claude 正在等待你的选择」）+ `header` chip + 多问题 `qIndex+1/qTotal`；每个选项渲染 `label` 下的 `description`。沿用现有 askcard 样式类。
- [ ] **Step 4**：`npm run build`（含前端类型检查）通过。
- [ ] **Step 5 提交**：`feat(web): LiveAskCard 富卡片(问题正文/说明/多问题进度)`。

## Task 11: 真机冒烟 + 全量验证

**Files:** Modify `apps/server/scripts/smoke-ask-live.ts`

- [ ] **Step 1**：smoke 注入 hook（ensure settings + 传 askDir/settingsArg/readAskSidecar 给 ChatSession），3 选项，断言：待答期 `onAskPending` 含 `description`；`Down Down` 挪光标后 `answerPendingAsk([0])` 仍精确得 Apple（经 transcript/PostToolUse 旁证或菜单关闭 + clear）；菜单关→`onAskPendingClear`。
- [ ] **Step 2 跑冒烟**：`npx tsx apps/server/scripts/smoke-ask-live.ts` → PASS。
- [ ] **Step 3 全量**：`npm test`、`npm run typecheck`、`npm run build` 全绿。
- [ ] **Step 4 提交**：`test(server): smoke-ask-live 注入 hook、验证数字键作答闭环`。

---

## Self-Review

- 覆盖 spec 各节：hook 注入(T4/T9)、sidecar(T2/T3)、检测(T7)、绝对数字键作答+按前确认(T6/T7)、协议富字段(T1/T8/T10)、富卡片(T10)、兜底降级(T6 fallback→AskController；T7 `!askDir` 走既有)、多问题推进(T7)、真机冒烟(T11)。✓
- 无占位符：各 Task 给出签名/关键实现/测试用例。✓
- 类型一致：`AskHookPending/AskHookQuestion/AskHookOption`、`AskPending(+question/header/qIndex/qTotal)`、`AskDriverResult{ok,fallback,error}`、`readPendingAsk/toAskPending/askLaunchExtra/ensureAskHookSettings/sendLiteralKeys` 全程同名。✓
- YAGNI：多选/多问题最佳努力 + 兜底；不动 parseAskPicker/rewind/effort/终端。✓
