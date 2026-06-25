/**
 * Rewind 集成冒烟：真实 tmux + 交互式 claude，闭环驱动原生 /rewind 走通。
 * 运行：npx tsx apps/server/scripts/smoke-rewind.ts
 * 隔离 socket rccrewind，临时目录工作，结束清理。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tmux } from '../src/lib/session/tmux';
import { ChatSession } from '../src/lib/session/chat/chatSession';
import { scrapePane } from '../src/lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript } from '../src/lib/session/chat/transcript';
import { makeClaudeAdapter } from '../src/lib/session/chat/agent/claudeAdapter';
import type { ChatMessage } from '@rcc/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccrewind';
const NAME = 'rcc-rewind-1';
const lineCount = (p: string | null) => (p && existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').length : 0);

async function main() {
  const sessionId = randomUUID();
  const work = mkdtempSync(join(tmpdir(), 'rcc-rewind-smoke-'));
  const tmux = new Tmux(SOCK);
  const messages: ChatMessage[] = [];
  const tail = new TranscriptTail(() => locateTranscript(sessionId));
  const session = new ChatSession(
    { tmuxName: NAME, cwd: work, launchCommand: 'claude --dangerously-skip-permissions', sessionId, cols: 120, rows: 40, agentKind: 'claude' },
    { tmux, scrape: scrapePane, tail, hasTranscript: () => locateTranscript(sessionId) !== null, adapter: makeClaudeAdapter(process.env.USER ?? ''), idleLimit: 6 },
    {
      onMessage: (m) => messages.push(m),
      onHistory: (ms) => {
        messages.length = 0;
        messages.push(...ms);
      },
      onPreview: () => {},
      onTurnState: () => {},
    },
  );

  console.log(`[smoke] session ${sessionId}, ensure() 启动…`);
  await session.ensure();
  await sleep(9000);
  if (/trust this folder/i.test(await tmux.capturePaneVisible(NAME))) {
    await tmux.sendKeys(NAME, ['Enter']);
    await sleep(4000);
  }

  console.log('[smoke] 发送建文件提示（产生带改动的 checkpoint）…');
  await session.sendText('Create a file named note.txt containing the single word hello, then reply exactly: done');
  for (let i = 0; i < 40; i++) {
    await session.tick();
    await sleep(700);
    if (messages.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'text')) && !session.isRunning()) break;
  }

  const tp = locateTranscript(sessionId);
  const linesBefore = lineCount(tp);

  console.log('[smoke] rewindOpen()…');
  const items = await session.rewindOpen();
  console.log('  checkpoint:', items.length, '改动:', items.map((i) => i.changes));

  let execOk = false;
  if (items.length > 0) {
    console.log('[smoke] rewindExecute(0, conversation)…');
    const r = await session.rewindExecute(0, 'conversation');
    execOk = r.ok;
    console.log('  ok:', r.ok, r.error ?? '');
  } else {
    await session.rewindCancel();
  }

  await sleep(1500);
  const paneAfter = await tmux.capturePaneVisible(NAME);
  const backToPrompt = !/Enter to continue · Esc to cancel/.test(paneAfter) && !/Confirm you want to restore/.test(paneAfter);
  const linesAfter = lineCount(tp);
  session.dispose();

  console.log('\n========== rewind 冒烟结果 ==========');
  console.log('checkpoint 数:', items.length);
  console.log('execute ok:', execOk);
  console.log('执行后回到正常 prompt（非 picker）:', backToPrompt);
  console.log(`transcript 行数 before/after: ${linesBefore}/${linesAfter}（应相等 → 印证 append-only 树、rewind 不截断）`);

  const ok = items.length > 0 && execOk && backToPrompt && linesBefore > 0 && linesBefore === linesAfter;

  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  rmSync(work, { recursive: true, force: true });
  if (tp && existsSync(tp)) rmSync(tp, { force: true });

  console.log('\n结论:', ok ? '✅ 通过（闭环驱动原生 rewind 端到端）' : '❌ 失败');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke] 异常:', e);
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
