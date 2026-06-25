/**
 * 真实端到端冒烟：验证 AskUserQuestion「hook 真值检测 + 绝对数字键作答」闭环。
 * 起隔离 tmux 会话跑原生 claude（注入 --settings ask hook + RCC_ASK_DIR），诱发 AskUserQuestion；
 * 用真实 ChatSession（hook 模式）手动 tick，断言：
 *   1) 待答期 onAskPending 来自 hook（qTotal 有值，读屏路径永不设）、选项 Apple/Banana/Cherry、带 description；
 *   2) 先 Down Down 人工挪光标到第 3 项，再 answerPendingAsk([0]) → 经 AskDriver 绝对数字键 '1' 作答；
 *   3) 作答后 sidecar 被 PostToolUse 删除 → onAskPendingClear；
 *   4) transcript 落地的 AskUserQuestion 结果为 Apple（挪了光标也没点歪）。
 * 运行：npx tsx apps/server/scripts/smoke-ask-live.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tmux } from '../src/lib/session/tmux';
import { ChatSession } from '../src/lib/session/chat/chatSession';
import { scrapePane } from '../src/lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript } from '../src/lib/session/chat/transcript';
import { makeClaudeAdapter } from '../src/lib/session/chat/agent/claudeAdapter';
import { ensureAskHookSettings, askLaunchExtra } from '../src/lib/session/chat/askHookSettings';
import { readPendingAsk } from '../src/lib/session/chat/askSidecar';
import type { AskPending } from '@rcc/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccsmoke';
const NAME = 'rcc-smoke-ask';
const HOOK_SCRIPT = fileURLToPath(new URL('hooks/rcc-ask-hook.mjs', import.meta.url));

let askDir = '';
function cleanup() {
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  if (askDir) rmSync(askDir, { recursive: true, force: true });
}
function fail(msg: string): never {
  console.error('[smoke] FAIL:', msg);
  cleanup();
  process.exit(1);
}

async function main() {
  const sessionId = randomUUID();
  const tmux = new Tmux(SOCK);

  // 装配 hook：临时 askDir + settings（含绝对脚本路径），拼 launch 注入串。
  askDir = mkdtempSync(join(tmpdir(), 'rcc-ask-smoke-'));
  const settingsPath = join(askDir, 'ask-hooks.settings.json');
  ensureAskHookSettings({ askDir, hookScriptPath: HOOK_SCRIPT, settingsPath });
  const askLaunch = askLaunchExtra(askDir, settingsPath);
  console.log('[smoke] askDir=', askDir);

  let pending: AskPending | null = null;
  let pendingCount = 0;
  let cleared = 0;
  let failedMsg: string | null = null;
  const noop = () => {};

  const session = new ChatSession(
    {
      tmuxName: NAME,
      cwd: process.cwd(),
      launchCommand: 'claude --dangerously-skip-permissions',
      sessionId,
      effort: 'low',
      cols: 120,
      rows: 40,
      agentKind: 'claude',
    },
    {
      tmux,
      scrape: scrapePane,
      tail: new TranscriptTail(() => locateTranscript(sessionId)),
      hasTranscript: () => !!locateTranscript(sessionId),
      adapter: makeClaudeAdapter(process.env.USER ?? ''),
      pollMs: 400,
      // hook 真值模式
      askDir,
      askLaunch,
      readAskSidecar: readPendingAsk,
    },
    {
      onMessage: noop,
      onHistory: noop,
      onPreview: noop,
      onTurnState: noop,
      onAskState: noop,
      onAskPending: (a) => {
        pending = a;
        pendingCount++;
        console.log(`[smoke] onAskPending #${pendingCount}:`, JSON.stringify(a));
      },
      onAskPendingClear: () => {
        cleared++;
        console.log('[smoke] onAskPendingClear');
      },
      onAskPendingFailed: (e) => {
        failedMsg = e ?? 'unknown';
        console.log('[smoke] onAskPendingFailed:', failedMsg);
      },
      onHud: noop,
    },
  );

  console.log('[smoke] 启动 claude…', sessionId);
  await session.ensure();
  await sleep(9000);

  await session.sendText(
    'Use the AskUserQuestion tool now. One question: "Pick a fruit" (header "Fruit"). THREE options IN THIS EXACT ORDER, each WITH a short description: "Apple" (desc "a red fruit") / "Banana" (desc "a yellow fruit") / "Cherry" (desc "a small fruit"). Call the tool immediately, do not explain.',
  );

  // 等待 hook 待答检测(最多 ~24s)
  for (let i = 0; i < 60 && !pending; i++) {
    await sleep(400);
    await session.tick();
  }
  if (!pending) fail('待答期未触发 onAskPending(hook 检测失败)');
  const ap = pending as AskPending;
  if (ap.qTotal !== 1) fail(`qTotal 应为 1(证明来自 hook 而非读屏): ${JSON.stringify(ap)}`);
  const labels = ap.options.map((o) => o.label);
  if (labels.join(',') !== 'Apple,Banana,Cherry') fail(`选项顺序/标签不符: ${JSON.stringify(labels)}`);
  if (!ap.options.some((o) => o.description)) fail(`选项缺 description(hook 富字段未带): ${JSON.stringify(ap.options)}`);
  console.log('[smoke] ✓ hook 待答检测成立：含 description 的 Apple/Banana/Cherry');

  // 人工挪光标到第 3 项(Cherry)，再用绝对数字键作答第 0 项(Apple) —— 验证不点歪。
  console.log('[smoke] 模拟人工挪光标 Down Down…');
  await tmux.sendKeys(NAME, ['Down']);
  await sleep(300);
  await tmux.sendKeys(NAME, ['Down']);
  await sleep(300);
  console.log('[smoke] answerPendingAsk([0])（绝对数字键作答 Apple）…');
  await session.answerPendingAsk([0]);

  for (let i = 0; i < 30 && cleared === 0; i++) {
    await sleep(400);
    await session.tick();
  }
  if (failedMsg) fail(`自动作答失败: ${failedMsg}`);
  if (cleared === 0) fail('作答后未触发 onAskPendingClear(sidecar 未被 PostToolUse 删除)');
  if (session.getLiveAsk()) fail('作答后 getLiveAsk 仍非空');

  // 真相核对：transcript 落地的 AskUserQuestion 结果应为 Apple（挪了光标也没点歪）。
  await sleep(1500);
  const tpath = locateTranscript(sessionId);
  if (!tpath) fail('找不到 transcript');
  const answered = findAskAnswer(readFileSync(tpath as string, 'utf8'));
  console.log('[smoke] transcript 落地的作答:', JSON.stringify(answered));
  if (!answered || !/Apple/.test(answered)) fail(`作答落点不是 Apple(疑似点歪): ${answered}`);
  if (/Cherry|Banana/.test(answered)) fail(`作答落点含光标处的 Cherry/Banana(点歪了): ${answered}`);

  console.log('[smoke] PASS：hook 待答检测 → 挪光标 → 绝对数字键作答 Apple → 清除，闭环成立且未点歪');
  cleanup();
  process.exit(0);
}

/** 从 transcript 原文里抠出 AskUserQuestion 的作答结果字符串（含 answers 的那段）。 */
function findAskAnswer(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.includes('answers')) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const s = JSON.stringify(o);
      const m = s.match(/"answers"\s*:\s*\{[^}]*\}/);
      if (m) return m[0];
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return null;
}

main().catch((e) => {
  console.error('[smoke] 异常:', e);
  cleanup();
  process.exit(1);
});
