/**
 * 真实跑 codex 的端到端冒烟:
 *  1) 启动一个 tmux + codex --yolo
 *  2) 越过"信任此目录?"确认页(发 Enter 选 Yes;非首次进该目录则无此页, Enter 无害)
 *  3) 发一条简单消息"hi"触发一个 turn —— codex 的 rollout jsonl 是**懒创建**的:
 *     光启动进主界面不写盘,要等第一条消息真正提交才在
 *     ~/.codex/sessions/YYYY/MM/DD/ 写出 rollout-<ts>-<uuid>.jsonl
 *  4) codexAdapter.discoverSessionId 扫到真实 UUID
 *  5) locateTranscript 能定位到该 jsonl
 *  6) CodexTranscriptTail 能 ingest jsonl 出 ChatMessage(至少含我发的 user "hi")
 *  7) 杀 tmux,清理 socket
 *
 * 跳过条件:本机没装 codex,直接返回(exit 0)不挂掉 CI。
 *
 * 运行:`npx tsx apps/server/scripts/smoke-codex.ts`
 *
 * 三个真机要点(本机 codex-cli 0.142.1 实测确认,见提交信息):
 *  A) 进未信任目录有"trust this directory?"确认页,需先发 Enter 越过才会真正启动。
 *  B) rollout jsonl 懒创建——必须先发一条消息触发 turn,故"发消息"在"discoverSessionId"之前
 *     (与 claude 一启动就有 transcript 不同)。
 *  C) 提交消息要"字面输入 + 间隔后单独发 Enter":紧贴文本的 Enter / paste 后立刻 Enter 会被吞,
 *     文本停在输入框不提交。故用 sendLiteralKeys 打字、稍候再 sendKeys(['Enter'])。
 *
 * 与 smoke-chat 一致用独立 socket 'rccsmoke' 不污染主 socket;
 * Tmux 对象式构造可传 unixUser(本机自跑时即 serviceUser,零开销直 exec)。
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import os from 'node:os';
import { Tmux } from '../src/lib/session/tmux';
import { makeCodexAdapter } from '../src/lib/session/chat/agent/codexAdapter';

const SOCK = 'rccsmoke';

async function main(): Promise<void> {
  // 检测本机是否有 codex(等同 smoke-idle.ts 检测 Fable-yolo 的做法):
  // command -v 走 bash -ic 让别名/PATH(含 nvm)都能命中。
  const hasCodex = spawnSync('bash', ['-ic', 'command -v codex']).status === 0;
  if (!hasCodex) {
    console.log('[smoke-codex] SKIP: 本机未装 codex CLI');
    return;
  }

  const serviceUser = os.userInfo().username;
  const tmuxName = `rcc-smoke-codex-${Date.now()}`;
  const tmux = new Tmux({ socket: SOCK, unixUser: serviceUser, currentUser: serviceUser });
  const adapter = makeCodexAdapter({
    serviceUser,
    // 当前用户用 os.homedir() 拿真实 HOME(避免 /home/<user> 在某些环境不成立);其他用户兜底 /home/<user>。
    homeFor: (u) => (u === serviceUser ? os.homedir() : `/home/${u}`),
  });

  let ok = false;
  try {
    console.log('[smoke-codex] 启动 codex --yolo in tmux:', tmuxName);
    // startedAt 取在"启动前":discoverSessionId 用 mtime >= startedAt 过滤,
    // 旧 rollout 的 mtime 远早于此天然被排除,不会误命中。
    const startedAt = Date.now();
    const cmd = adapter.buildLaunchCmd({ launchCommand: 'codex --yolo', sessionId: 'placeholder' });
    await tmux.newDetached(tmuxName, os.tmpdir(), cmd, 120, 40);

    console.log('[smoke-codex] 等 codex TUI 起来,发 Enter 越过"信任此目录?"页(无页则无害)...');
    await wait(5000);
    await tmux.sendKeys(tmuxName, ['Enter']);
    await wait(2500);

    console.log('[smoke-codex] 发"hi"(字面输入 + 间隔后单独 Enter 提交)以触发 rollout 写盘...');
    await tmux.sendLiteralKeys(tmuxName, 'hi');
    await wait(1000);
    await tmux.sendKeys(tmuxName, ['Enter']);

    console.log('[smoke-codex] 等 codex 写出 rollout jsonl,扫真实 UUID(最多 20s)...');
    const realSid = await adapter.discoverSessionId({
      tentativeSessionId: 'placeholder',
      unixUser: serviceUser,
      cwd: os.tmpdir(),
      timeoutMs: 20_000,
      startedAt,
    });
    if (!realSid) {
      console.error('[smoke-codex] FAIL: 20s 没扫到 rollout-*.jsonl(codex 可能启动慢/未提交/网络慢)');
      // 抓一眼屏方便排障
      console.error('[smoke-codex] pane:\n' + (await tmux.capturePaneVisible(tmuxName)));
      process.exit(1);
    }
    console.log('[smoke-codex] PASS: 扫到 sessionId =', realSid);

    console.log('[smoke-codex] 校验 locateTranscript 能定位到该 jsonl...');
    const located = adapter.locateTranscript(realSid, serviceUser, os.tmpdir());
    console.log('[smoke-codex] transcript 文件:', located ?? '(null)');

    console.log('[smoke-codex] tail 解析 jsonl,轮询最多 20s 看消息...');
    const tail = adapter.makeTranscriptTail(realSid, serviceUser, os.tmpdir());
    // 死等固定时间不可靠(codex 回应时延不定);轮询 activeChain,出现消息即提前结束。
    let chain = tail.activeChain();
    for (let i = 0; i < 20; i++) {
      await wait(1000);
      chain = tail.activeChain();
      // 期望至少看到一条 user 消息(我发的 hi);若 codex 已回应则还会有 assistant。
      if (chain.some((m) => m.role === 'user') && chain.some((m) => m.role === 'assistant')) break;
    }
    console.log('[smoke-codex] 消息数:', chain.length, '| 跳过行数:', tail.skippedLineCount?.() ?? 'n/a');
    for (const m of chain) {
      console.log('  -', m.role, ':', JSON.stringify(m.blocks).slice(0, 100));
    }

    // 判定:扫到真实 sessionId + 能定位文件 + tail 至少 ingest 出一条消息(user 或 assistant)。
    // assistant 回应依赖网络/额度,非硬性;至少要有 user "hi" 证明 tail 解析链路通畅。
    const hasUser = chain.some((m) => m.role === 'user');
    const hasAssistant = chain.some((m) => m.role === 'assistant');
    ok = Boolean(realSid) && located !== null && hasUser;
    if (ok && hasAssistant) {
      console.log('[smoke-codex] PASS: 看到 user + assistant 消息,端到端通畅');
    } else if (ok) {
      console.log('[smoke-codex] PASS(部分): 看到 user 消息且 tail 通畅;assistant 未回(网络/额度?),不阻断');
    } else {
      console.error('[smoke-codex] WARN: 扫到 sid 但 tail 未 ingest 出消息(codex 提交未成功?)');
    }
  } finally {
    await tmux.killSession(tmuxName);
    // 收尾:杀掉本冒烟独立 socket 的 tmux server,不留残会话。
    try {
      spawnSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
  }

  console.log('\n结论:', ok ? 'PASS 端到端通畅(扫到 sid + 定位文件 + tail 出消息)' : 'FAIL/WARN(见上)');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[smoke-codex] CRASH:', e);
  try {
    spawnSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
