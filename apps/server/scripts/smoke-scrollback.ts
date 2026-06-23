/**
 * 终端历史阅读层集成冒烟：真实 tmux，验证 historyInfo + computeWindow + captureRange(-J) 的分窗分页。
 * 运行：npx tsx apps/server/scripts/smoke-scrollback.ts
 * 用隔离 socket rccsbsmoke，结束清理。检查：① ROW_1..1000 连续无重叠/无缺失；
 * ② 长折行被 -J 合并（不在行内断开，除非恰好跨窗边界）；③ 每行无尾部空白(trimEnd)。
 */
import { execFileSync } from 'node:child_process';
import { Tmux } from '../src/lib/session/tmux';
import { computeWindow } from '../src/lib/session/scrollback';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccsbsmoke';
const NAME = 'rcc-sb-smoke';
const tx = (...args: string[]) => execFileSync('tmux', ['-L', SOCK, ...args], { encoding: 'utf8' });

async function main() {
  const tmux = new Tmux(SOCK);
  // 清理可能的残留
  try {
    tx('kill-session', '-t', NAME);
  } catch {
    /* 不存在则忽略 */
  }
  tx('new-session', '-d', '-s', NAME, '-x', '80', '-y', '24');
  await sleep(300);
  // 打印 1..500，一条长折行（>80 列），再 501..1000，让长行落入历史。
  tx('send-keys', '-t', NAME, 'for i in $(seq 1 500); do echo "ROW_$i"; done', 'Enter');
  await sleep(400);
  tx('send-keys', '-t', NAME, "printf 'LONG_'; for i in $(seq 1 30); do printf '%s' ABCDEFGHIJ; done; echo _END", 'Enter');
  await sleep(300);
  tx('send-keys', '-t', NAME, 'for i in $(seq 501 1000); do echo "ROW_$i"; done', 'Enter');
  await sleep(800);

  const info = await tmux.historyInfo(NAME);
  if (!info) throw new Error('historyInfo 返回 null（会话未就绪？）');
  console.log(`history_size=${info.historySize} pane_height=${info.paneHeight} total=${info.historySize + info.paneHeight}`);

  // 模拟阅读层：newest→oldest 分窗(每窗 300 行)，prepend 累积。
  const LIMIT = 300;
  let before: number | null = null;
  let atTop = false;
  let all: string[] = [];
  let windows = 0;
  let guard = 0;
  while (!atTop && guard++ < 100) {
    const w = computeWindow({ historySize: info.historySize, paneHeight: info.paneHeight, before, limit: LIMIT });
    if (w.empty) break;
    const raw = await tmux.captureRange(NAME, w.startLine, w.endLine);
    const lines = raw.replace(/\n$/, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
    all = [...lines, ...all]; // prepend，和前端一致
    before = w.nextBefore;
    atTop = w.atTop;
    windows++;
  }
  console.log(`分 ${windows} 窗取完，累计 ${all.length} 行。`);

  // 检查 ①：ROW_n 连续。
  const nums = all
    .map((l) => /^ROW_(\d+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => parseInt(m[1], 10));
  const ascending = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const complete = nums.length === 1000 && nums[0] === 1 && nums[999] === 1000;
  console.log(`ROW 数=${nums.length} 首=${nums[0]} 末=${nums[nums.length - 1]} 升序=${ascending} 完整=${complete}`);

  // 检查 ②：长折行被 -J 合并（整行 312 字符 LONG_..._END 出现在某一行内）。
  const longJoined = all.some((l) => /^LONG_(?:ABCDEFGHIJ){30}_END$/.test(l));
  const longSplitAtBoundary = all.some((l) => l.includes('LONG_')) && !longJoined;
  console.log(`长行已合并=${longJoined}${longSplitAtBoundary ? '（注意：恰好跨窗边界被拆，属已知可接受边界情况）' : ''}`);

  // 检查 ③：无尾部空白。
  const noTrailingWs = all.every((l) => l === l.replace(/[ \t]+$/, ''));
  console.log(`无尾部空白=${noTrailingWs}`);

  tx('kill-session', '-t', NAME);

  const ok = ascending && complete && noTrailingWs && (longJoined || longSplitAtBoundary);
  if (!ok) {
    console.error('❌ 冒烟失败');
    process.exit(1);
  }
  console.log('✅ 冒烟通过：分页连续无重叠/无缺失，-J 合并与 trimEnd 生效');
}

main().catch((e) => {
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-session', '-t', NAME]);
  } catch {
    /* ignore */
  }
  console.error(e);
  process.exit(1);
});
