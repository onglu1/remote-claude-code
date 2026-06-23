/**
 * 集成冒烟:验证空闲自动关闭的五信号探测器与"Bash sleep 跑期间不被误关"。
 *
 * 跑法:
 *   npx tsx apps/server/scripts/smoke-idle.ts
 *
 * 前置条件:
 *   - 本机有 tmux 命令在 PATH。
 *   - 本机有 `Fable-yolo` 别名(用户的 claude 启动器);没有的话脚本会以
 *     "标"形式失败而非 throw——把"Fable-yolo not found"作为已知 skip 报出。
 *   - ~/.claude 可写(claude 会在那里写 transcript)。
 *
 * 步骤:
 *   1. 起 tmux + claude(--session-id) 跑空一个新会话
 *   2. 发"运行 bash sleep 5 并告诉我结果"让 claude 调 Bash 工具
 *   3. tickActivity 在 sleep 跑期间应返回 busy=true(信号:open_tool_use 或 transcript_mtime)
 *   4. 等 8s 让 sleep 完成 + claude 回应,再 tickActivity 应返 busy=false(idle)
 *   5. 清理 tmux 会话
 */
import { mkdtempSync, rmSync, statSync, openSync, fstatSync, readSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Tmux } from '../src/lib/session/tmux';
import { ConversationStore } from '../src/lib/conversations';
import { createActivityState, tickActivity, type ActivityIO } from '../src/lib/session/activity';
import { locateTranscript } from '../src/lib/session/chat/transcript';

const SOCK = 'rccsmokeidle';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function checkPrereqs(): Promise<void> {
  // tmux 必须有
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    throw new Error('tmux 未安装或不在 PATH;请先装 tmux');
  }
  // Fable-yolo 检测:bash 别名走交互式 shell 才看得到,不能用 which。
  // 用 bash -ic 跑 `command -v Fable-yolo` 检查;失败给个明确提示但不阻塞执行——
  // 让用户在自己机器跑时即时看到完整错误。
  try {
    const out = execSync('bash -ic "command -v Fable-yolo || echo MISSING"', { encoding: 'utf8' });
    if (out.trim().endsWith('MISSING')) {
      console.warn('[warn] Fable-yolo 别名未在 bash -ic 下找到;脚本继续跑但若 claude 拉不起来会很快 idle');
    }
  } catch {
    console.warn('[warn] 无法检测 Fable-yolo 别名;假设你本机配好了');
  }
}

function cleanup(name: string) {
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-session', '-t', name], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  空闲自动关闭五信号探测器集成冒烟 (smoke-idle)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await checkPrereqs();

  const workDir = mkdtempSync(join(tmpdir(), 'rcc-smoke-idle-'));
  const tmux = new Tmux(SOCK);
  const convs = new ConversationStore(join(workDir, 'conversations.json'));
  const conv = convs.create('smoke', 'idle-冒烟');

  console.log(`[1/6] 起 tmux + claude(--session-id ${conv.sessionId.slice(0, 8)}…)`);
  console.log(`      tmux 会话: ${conv.tmuxName} @ socket ${SOCK}`);

  try {
    await tmux.newDetached(
      conv.tmuxName,
      process.cwd(),
      `Fable-yolo --session-id ${conv.sessionId}`,
      120,
      40,
    );
  } catch (e) {
    console.error('[fatal] tmux 起会话失败:', e);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log('      等 6s 让 claude TUI 起来…');
  await sleep(6000);

  // ── 构造真实 ActivityIO(同 app.ts 生产路径) ──
  const io: ActivityIO = {
    transcriptStat: (p) => {
      try {
        const s = statSync(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
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
      } finally {
        closeSync(fd);
      }
    },
    sidecarStat: (dir, sid) => {
      try {
        const s = statSync(join(dir, `${sid}.json`));
        return { mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    askSidecarExists: (dir, sid) => existsSync(join(dir, `${sid}.json`)),
    paneHash: (name) => {
      try {
        const out = execSync(`tmux -L ${SOCK} capture-pane -p -t ${name}`, { encoding: 'utf8' });
        return crypto.createHash('sha1').update(out).digest('hex').slice(0, 16);
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
  };

  const state = createActivityState(Date.now());
  const transcriptPath0 = locateTranscript(conv.sessionId);
  const ctx = {
    transcriptPath: transcriptPath0 ?? '',
    tmuxName: conv.tmuxName,
    sessionId: conv.sessionId,
    statuslineDir: workDir, // 用一个不存在的目录,sidecarStat 自然 null
    askDir: workDir,
  };

  // 先空跑一次 tick:让 state 把当前 transcript 大小/mtime/pane hash 记下来
  // (第一次没参照值,五信号都返回 false 是正常的)
  console.log('\n[2/6] 预热 tick(初始化基线)');
  let r = tickActivity(state, ctx, io, 90_000);
  console.log(`      busy=${r.busy} reasons=[${r.reasons.join(',')}] (期望 false)`);

  // ── 让 claude 跑 bash sleep 5 ──
  console.log('\n[3/6] 发指令: "运行 bash sleep 5 并告诉我结果"');
  await tmux.pasteText(conv.tmuxName, '运行 bash sleep 5 并告诉我结果');
  await tmux.sendKeys(conv.tmuxName, ['Enter']);
  console.log('      等 3s 让 claude 收到指令并启动 Bash 工具…');
  await sleep(3000);

  // ── busy 检查:sleep 中应该有 open_tool_use 或 transcript_mtime ──
  console.log('\n[4/6] busy 检查(预期 true)');
  const transcriptPath1 = locateTranscript(conv.sessionId);
  r = tickActivity(state, { ...ctx, transcriptPath: transcriptPath1 ?? '' }, io, 90_000);
  console.log(`      busy=${r.busy} reasons=[${r.reasons.join(',')}]`);
  const busyOk = r.busy;
  if (!busyOk) {
    console.warn('      ⚠ 期望 busy=true 但实际 false;可能 claude 未拉起或未真正跑工具');
  }

  // ── 等 sleep 完 + claude 收 tool_result 后再测一次。
  //    claude 生成可能持续 20-40s,不要写死短等待——poll 至 idle 或超时。
  console.log('\n[5/6] 轮询等待 idle(最长 60s)');
  let idleOk = false;
  let lastReasons: string[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const tp = locateTranscript(conv.sessionId);
    r = tickActivity(state, { ...ctx, transcriptPath: tp ?? '' }, io, 90_000);
    lastReasons = r.reasons;
    process.stdout.write(`      tick #${i + 1} busy=${r.busy} reasons=[${r.reasons.join(',')}]\n`);
    if (!r.busy) {
      // 再多观察一次:确认真的 idle,避免抖动
      await sleep(2000);
      const tp2 = locateTranscript(conv.sessionId);
      r = tickActivity(state, { ...ctx, transcriptPath: tp2 ?? '' }, io, 90_000);
      if (!r.busy) {
        idleOk = true;
        break;
      }
    }
  }
  console.log('\n[6/6] idle 检查结果');
  if (!idleOk) {
    console.warn(`      ⚠ 期望 busy=false 但 60s 内未 idle;末次 reasons=[${lastReasons.join(',')}]`);
  } else {
    console.log('      ✓ 成功观察到 idle');
  }

  console.log('\n[cleanup] 杀 tmux 会话 + 删工作目录');
  cleanup(conv.tmuxName);
  rmSync(workDir, { recursive: true, force: true });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (busyOk && idleOk) {
    console.log('✅ 通过:Bash 工具跑期间不被误关 + 完成后探测器及时转 idle');
    process.exit(0);
  } else {
    console.log(`❌ 失败:busy 检查=${busyOk ? 'OK' : 'FAIL'} / idle 检查=${idleOk ? 'OK' : 'FAIL'}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n[fatal] 冒烟脚本异常:', e);
  process.exit(1);
});
