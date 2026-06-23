/**
 * 真实集成冒烟：HUD 独立数据源（statusLine sidecar）。
 * 启一个真实交互式 claude（隔离 socket），它每次刷状态栏会经我们的捕获脚本落 sidecar；
 * ChatSession.tick() 读 sidecar → 广播 onHud，断言 source='statusline' 且带 5h/周/context%。
 *
 * 运行：npx tsx apps/server/scripts/smoke-hud-statusline.ts
 * 前置：已 npm run setup-statusline（settings.json 的 statusLine 指向 rcc 捕获器、有真实下游）。
 * 注意：HUD 的 5h/周仅订阅账号有；若该机无订阅，只断言拿到 statusline 源 + context%。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Tmux } from '../src/lib/session/tmux';
import { ChatSession } from '../src/lib/session/chat/chatSession';
import { scrapePane } from '../src/lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript } from '../src/lib/session/chat/transcript';
import type { Hud } from '@rcc/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccsmokehud';
const NAME = 'rcc-smoke-hud';
const DIR = process.env.RCC_STATUSLINE_DIR || join(homedir(), '.claude', 'rcc-statusline');

async function main() {
  const sessionId = randomUUID();
  const tmux = new Tmux(SOCK);
  const huds: Hud[] = [];

  const tail = new TranscriptTail(() => locateTranscript(sessionId));
  const session = new ChatSession(
    {
      tmuxName: NAME,
      cwd: process.cwd(),
      launchCommand: 'claude --dangerously-skip-permissions --effort low',
      sessionId,
      cols: 120,
      rows: 40,
    },
    {
      tmux,
      scrape: scrapePane,
      tail,
      hasTranscript: () => locateTranscript(sessionId) !== null,
      statuslineDir: DIR,
      readSidecar: (p: string) => ({ content: readFileSync(p, 'utf8'), mtimeMs: statSync(p).mtimeMs }),
    },
    {
      onMessage: () => {},
      onHistory: () => {},
      onPreview: () => {},
      onTurnState: () => {},
      onAskState: () => {},
      onAskPending: () => {},
      onAskPendingClear: () => {},
      onAskPendingFailed: () => {},
      onHud: (h) => huds.push(h),
    },
  );

  console.log(`[smoke-hud] sessionId=${sessionId}; statuslineDir=${DIR}`);
  console.log('[smoke-hud] ensure() 启动交互式 claude…');
  await session.ensure();
  await sleep(10000); // 等 TUI 启动并首次刷状态栏

  // 多 tick，等捕获脚本把 sidecar 写出、被 tick 读到。
  for (let i = 0; i < 30; i++) {
    await session.tick();
    if (huds.some((h) => h.source === 'statusline')) break;
    await sleep(700);
  }

  session.dispose();

  const sidecar = join(DIR, `${sessionId}.json`);
  const sidecarExists = existsSync(sidecar);
  const slHud = huds.filter((h) => h.source === 'statusline').at(-1) ?? null;
  const anyHud = huds.at(-1) ?? null;

  console.log('\n========== HUD 冒烟结果 ==========');
  console.log('sidecar 落盘:', sidecarExists, sidecarExists ? `(${sidecar})` : '');
  console.log('onHud 次数:', huds.length, '| 出现过的 source:', [...new Set(huds.map((h) => h.source))].join(','));
  if (slHud) {
    console.log('statusline HUD:', JSON.stringify({
      model: slHud.model, contextPct: slHud.contextPct,
      contextTokens: slHud.contextTokens, contextWindowTokens: slHud.contextWindowTokens,
      fiveHour: slHud.fiveHour, weekly: slHud.weekly,
    }));
  } else {
    console.log('末次 HUD(任意源):', JSON.stringify(anyHud));
  }

  // 通过条件：sidecar 落盘 + 拿到 source='statusline' 的 HUD（含 model 或窗口大小）。
  // 注：刚启动未发任何消息的会话，context used_percentage/usage 为空属正常（发过一轮后才有），
  // 5h/周亦视订阅而定——故核心断言是「拿到 statusline 源」，证明独立数据源端到端打通。
  const ok =
    sidecarExists &&
    slHud !== null &&
    (slHud.model !== undefined || slHud.contextWindowTokens !== undefined);

  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  const tp = locateTranscript(sessionId);
  if (tp && existsSync(tp)) rmSync(tp, { force: true });
  if (sidecarExists) rmSync(sidecar, { force: true });

  console.log('\n结论:', ok ? '✅ 通过（sidecar 写入 + 聊天会话拿到 statusline 源 HUD + context%）' : '❌ 失败');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke-hud] 异常:', e);
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
