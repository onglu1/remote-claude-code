/**
 * 聊天模式集成冒烟：真实 tmux + 真实交互式 claude，验证整条管线。
 * 运行：npx tsx apps/server/scripts/smoke-chat.ts
 * 需要宿主有 tmux 与 claude；用隔离 socket rccsmoke，结束清理。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { Tmux } from '../src/lib/session/tmux';
import { ChatSession } from '../src/lib/session/chat/chatSession';
import { scrapePane } from '../src/lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript } from '../src/lib/session/chat/transcript';
import { groupTurns, type ChatMessage } from '@rcc/shared';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOCK = 'rccsmoke';
const NAME = 'rcc-smoke-1';

async function main() {
  const sessionId = randomUUID();
  const tmux = new Tmux(SOCK);
  const previews: string[] = [];
  const messages: ChatMessage[] = [];
  const turns: boolean[] = [];

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
    { tmux, scrape: scrapePane, tail, hasTranscript: () => locateTranscript(sessionId) !== null, idleLimit: 6 },
    {
      onMessage: (m) => messages.push(m),
      // 本冒烟单会话单订阅、无 rewind 分叉,消息全走 onMessage;onHistory(骨架)忽略即可。
      onHistory: () => {},
      onPreview: (t) => previews.push(t),
      onTurnState: (r) => turns.push(r),
      onAskState: () => {},
      onAskPending: () => {},
      onAskPendingClear: () => {},
      onAskPendingFailed: () => {},
      onHud: () => {},
    },
  );

  console.log(`[smoke] session ${sessionId}, ensure() 启动交互式 claude…`);
  await session.ensure();
  await sleep(9000); // 等 TUI 启动

  console.log('[smoke] 发送提示(诱导一次工具调用)…');
  await session.sendText('Use the Bash tool to run exactly: echo smoke-ok . Then reply with: done');

  for (let i = 0; i < 45; i++) {
    await session.tick();
    await sleep(800);
    const hasAssistantText = messages.some(
      (m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'text'),
    );
    if (hasAssistantText && turns.includes(false)) break;
  }

  // 历史骨架 + 按需取正文(本特性):折叠旧回合、点开才取完整正文。
  const snap = session.getSkeleton();
  const lastAssistant = [...snap.items].reverse().find((i) => i.kind === 'assistant');
  const turnId = lastAssistant && lastAssistant.kind === 'assistant' ? lastAssistant.turnId : null;
  const turnBody = turnId ? session.getTurnBody(turnId) : null;
  const skeletonOk = snap.items.length >= 1 && turnId !== null && (turnBody?.length ?? 0) >= 1;

  session.dispose();

  const assistantTexts = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')));
  const transcriptPath = locateTranscript(sessionId);

  // 回合分组(与前端同一纯函数)——验证角色归属与工具配对
  const grouped = groupTurns(messages);
  const userTurns = grouped.filter((t) => t.kind === 'user').length;
  const assistantTurns = grouped.filter((t) => t.kind === 'assistant').length;
  const toolResults: Record<string, boolean> = {};
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') toolResults[b.toolUseId] = true;
  const toolUses = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use'));
  const toolsPaired = toolUses.every((b) => b.type === 'tool_use' && toolResults[b.id]);

  console.log('\n========== 冒烟结果 ==========');
  console.log('preview 次数:', previews.length, '| 末次预览:', JSON.stringify(previews.at(-1)?.slice(0, 60) ?? null));
  console.log('结构化消息数:', messages.length, '| 角色:', messages.map((m) => m.role).join(','));
  console.log('回合:', `用户回合=${userTurns}`, `助手回合=${assistantTurns}`, '| 工具调用数:', toolUses.length, '| 工具均配对:', toolsPaired);
  console.log('助手文本:', JSON.stringify(assistantTexts.join(' | ').slice(0, 120)));
  console.log('running 变迁:', turns.join('→'));
  console.log('transcript 落盘:', transcriptPath);
  console.log(
    '历史骨架:',
    `项数=${snap.items.length}`,
    `末助手 tail 截断=${lastAssistant?.kind === 'assistant' ? lastAssistant.tail?.truncated : 'n/a'}`,
    `| 取正文 turnId=${turnId} 正文消息数=${turnBody?.length ?? 0}`,
  );

  const ok =
    (previews.length > 0 || assistantTexts.length > 0) &&
    transcriptPath !== null &&
    turns.includes(true) &&
    userTurns === 1 && // 工具结果/meta 未被错当成用户气泡(只应有我发的 1 条用户回合)
    assistantTurns >= 1 &&
    toolsPaired && // 每个 tool_use 都配到结果
    skeletonOk; // 骨架可投影 + 按 turnId 取回完整正文

  // 清理
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  if (transcriptPath && existsSync(transcriptPath)) rmSync(transcriptPath, { force: true });

  console.log('\n结论:', ok ? '✅ 通过（读屏预览 + transcript 结构化 + 运行态 全部就绪）' : '❌ 失败');
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
