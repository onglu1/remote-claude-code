/**
 * SPIKE：真实触发 AskUserQuestion，捕获原生 TUI 菜单快照（供 askScraper/askController 实现）。
 * 运行：npx tsx apps/server/scripts/spike-ask.ts
 * 隔离 socket rccnspike，结束清理。把疑似菜单屏写入 __fixtures__/ask_capture_*.txt。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Tmux } from '../src/lib/session/tmux';
import { locateTranscript } from '../src/lib/session/chat/transcript';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccnspike';
const NAME = 'rcc-spike-ask';
const OUT = join(process.cwd(), 'apps/server/src/lib/session/chat/__fixtures__');

async function main() {
  const sessionId = randomUUID();
  const tmux = new Tmux(SOCK);
  mkdirSync(OUT, { recursive: true });

  console.log('[spike] 启动交互式 claude（low effort 减少思考）…', sessionId);
  await tmux.newDetached(NAME, process.cwd(), `claude --dangerously-skip-permissions --effort low --session-id ${sessionId}`, 120, 40);
  await sleep(9000);

  // 直接诱导 AskUserQuestion（两个选项,带可识别标签）
  const prompt =
    'Use the AskUserQuestion tool now. One question: "Pick a fruit" (header "Fruit"). Two options: "Apple" / "Banana". Call the tool immediately, do not explain.';
  await tmux.pasteText(NAME, prompt);
  await tmux.sendKeys(NAME, ['Enter']);

  // 菜单判定:出现"独立短行含 Apple"(选项行,区别于被回显的长 prompt 句子)
  const isMenu = (pane: string) =>
    pane.split('\n').some((l) => {
      const t = l.trim();
      return t.length > 0 && t.length < 40 && /Apple/.test(t);
    });

  let saved = 0;
  let lastHash = '';
  for (let i = 0; i < 70; i++) {
    await sleep(1500);
    const pane = await tmux.capturePaneVisible(NAME);
    const lines = pane.split('\n').filter((l) => l.trim());
    if (isMenu(pane)) {
      const hash = lines.join('|');
      if (hash !== lastHash) {
        lastHash = hash;
        const f = join(OUT, `ask_capture_${String(saved).padStart(2, '0')}.txt`);
        writeFileSync(f, pane);
        saved++;
        console.log(`[spike] #${i} 菜单 → ${f}`);
        console.log('  样本行:', JSON.stringify(lines.slice(0, 6)));
        console.log('  ❯?', pane.includes('❯'), '| 数字编号?', /^\s*\d[.)]/m.test(pane), '| 复选框?', /[□☐☑☒◯●○•]/.test(pane));
      }
      if (saved >= 2) break;
    } else {
      console.log(`[spike] #${i} 思考/未出菜单。末行:`, JSON.stringify(lines.slice(-2)));
    }
  }

  const transcriptPath = locateTranscript(sessionId);
  console.log('[spike] 保存菜单快照数:', saved, '| transcript:', transcriptPath);

  // 清理
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(saved > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[spike] 异常:', e);
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
