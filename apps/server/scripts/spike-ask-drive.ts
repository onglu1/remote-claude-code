/**
 * SPIKE 验证:真实触发 AskUserQuestion 并用 AskController 闭环驱动选中第 2 项(Banana)。
 * 运行：./node_modules/.bin/tsx apps/server/scripts/spike-ask-drive.ts
 * 隔离 socket rccnask,结束清理。验证:菜单出现→驱动→菜单关闭→transcript 落答案。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Tmux } from '../src/lib/session/tmux';
import { parseAskPicker } from '../src/lib/session/chat/askScraper';
import { AskController } from '../src/lib/session/chat/askController';
import { locateTranscript } from '../src/lib/session/chat/transcript';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccnask';
const NAME = 'rcc-ask-drive';

async function main() {
  const sessionId = randomUUID();
  const tmux = new Tmux(SOCK);
  console.log('[drive] 启动 claude(low effort)…', sessionId);
  await tmux.newDetached(NAME, process.cwd(), `claude --dangerously-skip-permissions --effort low --session-id ${sessionId}`, 120, 40);
  await sleep(9000);

  await tmux.pasteText(NAME, 'Use the AskUserQuestion tool now. One question: "Pick a fruit" (header "Fruit"). Two options: "Apple" / "Banana". Call it immediately, do not explain.');
  await tmux.sendKeys(NAME, ['Enter']);

  // 等菜单出现
  let opened = false;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const s = parseAskPicker(await tmux.capturePaneVisible(NAME));
    if (s.open) {
      opened = true;
      console.log('[drive] 菜单出现,选项:', JSON.stringify(s.options.map((o) => o.label)), '光标@', s.cursor);
      break;
    }
  }
  if (!opened) {
    console.log('[drive] ❌ 菜单未出现');
    cleanup();
    process.exit(1);
  }

  // 驱动:选第 2 项(transcript 序号 1 → TUI 编号 2 = Banana)
  const r = await new AskController(NAME, tmux, { settleMs: 400 }).answer([{ questionIndex: 0, optionIndices: [1] }]);
  console.log('[drive] answer 结果:', JSON.stringify(r));
  await sleep(2500);

  const closed = !parseAskPicker(await tmux.capturePaneVisible(NAME)).open;
  const tpath = locateTranscript(sessionId);
  let answered = false;
  let answerText = '';
  if (tpath) {
    const lines = readFileSync(tpath, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        if (o.toolUseResult && typeof o.toolUseResult === 'object' && o.toolUseResult.answers) {
          answered = true;
          answerText = JSON.stringify(o.toolUseResult.answers);
        }
        if (Array.isArray(o.message?.content)) {
          for (const b of o.message.content) {
            if (b.type === 'tool_result' && typeof b.content === 'string' && /Banana|Apple/.test(b.content)) {
              answered = true;
              answerText ||= b.content.slice(0, 120);
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  console.log('\n========== ask 驱动结果 ==========');
  console.log('controller.ok:', r.ok, '| 菜单已关闭:', closed, '| transcript 落答案:', answered);
  console.log('答案:', answerText);

  const ok = r.ok && closed && answered && /Banana/.test(answerText);
  cleanup();
  console.log('\n结论:', ok ? '✅ 通过(真实闭环驱动选中 Banana)' : '⚠️ 未完全通过(见上)');
  process.exit(ok ? 0 : 1);
}

function cleanup() {
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

main().catch((e) => {
  console.error('[drive] 异常:', e);
  cleanup();
  process.exit(1);
});
