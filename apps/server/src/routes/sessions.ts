import crypto from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AgentKind, Conversation, ScrollbackChunk } from '@rcc/shared';
import { ConversationCreateSchema, decodeClientMessage, encodeServerMessage } from '@rcc/shared';
import type { AppContext } from '../context';
import { makeRequireAuth, resolveUser } from '../plugins/requireAuth';
import { COOKIE_NAME } from '../lib/auth';
import { computeWindow } from '../lib/session/scrollback';
import { readPendingAsk } from '../lib/session/chat/askSidecar';
import { makeClaudeAdapter } from '../lib/session/chat/agent/claudeAdapter';
import { makeCodexAdapter } from '../lib/session/chat/agent/codexAdapter';
import { resolveLaunchCommand } from '../lib/session/chat/agent/resolveLaunchCommand';
import { conversationRuntimeKey } from '../lib/conversationIdentity';
import { resolveSessionScope, resolveVisibleProject } from './sessionScope';
// PATCH 入参:三选一(name/folderId/starred),至少给一个字段;trim 与长度约束保持旧 rename 语义。
// folderId:undefined=不改、null=显式清除、字符串=指向某文件夹(下方路由校验存在与归属)。
const PatchConvSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    folderId: z.string().nullable().optional(),
    starred: z.boolean().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.folderId !== undefined || v.starred !== undefined,
    { message: '至少提供一个可改字段' },
  );

// 批量动作入参:ids 限 1..200 防一次太重;action 决定后续解析路径(move 还要 payload.folderId)。
const BatchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['move', 'star', 'unstar', 'close', 'softDelete']),
  payload: z.object({ folderId: z.string().nullable().optional() }).optional(),
});

export async function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  // 两个 agent 适配器各建一次缓存复用(无 per-session 状态,按 agentKind 选其一),
  // 避免每个请求重建。与 context.ts 同模式:claude 命令输出与既有 buildClaudeCmd 一字不差,
  // 故 claude 路径行为零变化;codex 拼 'codex --yolo' / 'codex resume --yolo <UUID>'。
  const claudeAdapter = makeClaudeAdapter(ctx.config.serviceUser);
  const codexAdapter = makeCodexAdapter({
    serviceUser: ctx.config.serviceUser,
    // 给 unix 用户名 → HOME:ServiceUser 用进程 HOME,其余按 /home/<user> 约定
    // (与 projectsDirFor 的跨用户 home 解析同源)。
    homeFor: (u: string) => (u === ctx.config.serviceUser ? os.homedir() : `/home/${u}`),
  });
  const pickAdapter = (kind: AgentKind) => (kind === 'codex' ? codexAdapter : claudeAdapter);

  // 会话存活判定:按 unixUser 路由到对应 socket(子用户和父共用一个 socket,主账号自己)。
  // 多用户隔离设计 2026-06-23:不再用 ctx.tmux 单例(那是 ServiceUser=wangleyan 的),
  // 否则跨 unix 用户的会话永远判 dead。
  async function aliveOf(
    projectId: string,
    unixUser: string,
    conv: { id: string; tmuxName: string },
  ): Promise<boolean> {
    const alive = new Set(await ctx.getTmux(unixUser).listSessions());
    return alive.has(conv.tmuxName) || ctx.registry.isActive(conversationRuntimeKey(projectId, conv.id));
  }

  async function withAlive(projectId: string, unixUser: string): Promise<Conversation[]> {
    const alive = new Set(await ctx.getTmux(unixUser).listSessions());
    return ctx.conversations.listByProject(projectId).map((c) => ({
      ...c,
      alive: alive.has(c.tmuxName) || ctx.registry.isActive(conversationRuntimeKey(projectId, c.id)),
    }));
  }

  function markConversationActive(projectId: string, convId: string) {
    return ctx.conversations.markActiveInProject(projectId, convId, new Date().toISOString());
  }

  // ---- 会话元数据 REST ----
  app.get(
    '/api/projects/:id/conversations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = resolveVisibleProject(ctx, req.user!, id);
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return { conversations: await withAlive(id, req.user!.unixUser) };
    },
  );

  app.post(
    '/api/projects/:id/conversations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = resolveVisibleProject(ctx, req.user!, id);
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const parse = ConversationCreateSchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0]?.message ?? 'bad request' });
      }
      const requestedAgent = parse.data.agentKind ?? 'claude';
      if (!ctx.agentAccess.canUse(req.user!, requestedAgent)) {
        return reply.code(403).send({ error: 'agent_access_denied' });
      }
      // 显式指定 sessionId 时:首次拉起 ensure() 会检测 transcript 已存在 → --resume,接续旧对话。
      // agentKind/launchCommand 透传 ConversationStore(缺省 claude + 走 adapter 默认,行为零变化)。
      // codex + 用户显式传 sessionId:置 codexSessionDiscovered=true 仅记录"传入的是候选真实 UUID"。
      // 是否 resume 仍必须由 adapter 在当前项目 cwd 下定位到对应 transcript 决定。
      const explicitCodexResume =
        !!parse.data.sessionId && (parse.data.agentKind ?? 'claude') === 'codex';
      const conv = ctx.conversations.create(id, parse.data.name ?? '', parse.data.sessionId, {
        agentKind: parse.data.agentKind,
        launchCommand: parse.data.launchCommand,
        codexSessionDiscovered: explicitCodexResume,
      });
      return { conversation: { ...conv, alive: false } };
    },
  );

  // 列垃圾箱:已软删除的会话,按删除时间倒序(最近删的最上)。
  app.get(
    '/api/projects/:id/conversations/trash',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = resolveVisibleProject(ctx, req.user!, id);
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const list = ctx.conversations.listDeletedByProject(id)
        .map((c) => ({ ...c, alive: false })) // 软删除时已杀 tmux,alive 永远 false
        .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
      return { conversations: list };
    },
  );

  // 恢复软删除:清 deletedAt;tmux 不主动重启,用户进入会话时 ensure 自然按 --resume 拉。
  app.post(
    '/api/projects/:id/conversations/:cid/restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid, { includeDeleted: true });
      if (!scope || !scope.conversation.deletedAt) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const restored = ctx.conversations.restoreInProject(id, cid);
      if (!restored) return reply.code(404).send({ error: 'conversation not found' });
      return { conversation: { ...restored, alive: false } };
    },
  );

  // 关闭/删除会话:默认软删除(进垃圾箱可恢复);query.hard=1 时彻底删(从存储抹掉)。
  // 两种都会先杀 tmux 释放 claude TUI(transcript 文件不动,仍可 resume)。
  app.delete(
    '/api/projects/:id/conversations/:cid',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid, { includeDeleted: true });
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const conv = scope.conversation;
      const hard = (req.query as { hard?: string }).hard === '1';
      // 标星会话拒软删(避免误丢进垃圾箱);硬删 hard=1 是显式动作,不拦。
      if (!hard && conv.starred) {
        return reply.code(409).send({ error: 'starred_locked' });
      }
      // tmux 一定杀(无论软/硬):软删时如果 TUI 还活着,留着也没意义且占资源。
      await ctx.getTmux(req.user!.unixUser).killSession(conv.tmuxName);
      ctx.chatRegistry.forceClose(scope.runtimeKey);
      if (hard) {
        ctx.conversations.hardDeleteInProject(id, cid);
      } else {
        ctx.conversations.softDeleteInProject(id, cid);
      }
      return { ok: true, hard };
    },
  );

  // 局部更新：name / folderId / starred。folderId 必须指向本项目存在文件夹;null 显式清除归属。
  // 复用 ConversationStore.update;与其它会话路由同样的可见性过滤(含垃圾箱排除)。
  app.patch(
    '/api/projects/:id/conversations/:cid',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const parse = PatchConvSchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0]?.message ?? 'bad request' });
      }
      // resolveSessionScope 默认排除 deletedAt:垃圾箱里的会话不该被改名/加星/挪文件夹。
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      // folderId 非空时校验存在且属于本项目;null 表示显式清除归属(允许)。
      if (parse.data.folderId !== undefined && parse.data.folderId !== null) {
        const f = ctx.folders.get(parse.data.folderId);
        if (!f || f.projectId !== id) {
          return reply.code(400).send({ error: 'folder not found' });
        }
      }
      const updated = ctx.conversations.updateInProject(id, cid, parse.data);
      if (!updated) return reply.code(404).send({ error: 'conversation not found' });
      return { conversation: { ...updated, alive: await aliveOf(id, req.user!.unixUser, updated) } };
    },
  );

  // ---- 生命周期:手动 close(休眠)/ resume(从休眠拉回)/ batch(批量动作)----
  // close:幂等。已 closedAt 直接返回当前状态。
  // 杀 tmux 释放 claude TUI;transcript 不动,resume 后 --resume 接续。
  app.post(
    '/api/projects/:id/conversations/:cid/close',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const conv = scope.conversation;
      if (conv.closedAt) return { conversation: { ...conv, alive: false } };
      await ctx.getTmux(req.user!.unixUser).killSession(conv.tmuxName);
      ctx.chatRegistry.forceClose(scope.runtimeKey);
      const updated = ctx.conversations.updateInProject(id, cid, { closedAt: new Date().toISOString() });
      return { conversation: { ...updated, alive: false } };
    },
  );

  // resume:幂等。未 closedAt 直接返回当前状态(alive 实时探)。
  // 否则走 adapter 沿 reflow 模式拉起 tmux + agent(有 transcript→resume,首次→launch)。
  app.post(
    '/api/projects/:id/conversations/:cid/resume',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const { project, conversation: conv } = scope;
      if (!ctx.agentAccess.canUse(req.user!, conv.agentKind)) {
        return reply.code(403).send({ error: 'agent_access_denied' });
      }
      if (!conv.closedAt) {
        const active = markConversationActive(id, cid) ?? conv;
        return { conversation: { ...active, alive: await aliveOf(id, req.user!.unixUser, active) } };
      }
      // 走 adapter:claude 输出与既有 buildClaudeCmd 一字不差;codex 拼 codex 子命令。
      const adapter = pickAdapter(conv.agentKind);
      const launchCommand = resolveLaunchCommand(conv, project);
      const hasTranscript =
        adapter.locateTranscript(conv.sessionId, req.user!.unixUser, project.path) !== null;
      // askLaunch 仅 claude 有意义(codex adapter 内部忽略);不按 capability 分支,逻辑一致。
      const askLaunch = ctx.askLaunchFor(req.user!.unixUser);
      const cmd = hasTranscript
        ? adapter.buildResumeCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort, askLaunch })
        : adapter.buildLaunchCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort, askLaunch });
      try {
        await ctx.getTmux(req.user!.unixUser).newDetached(conv.tmuxName, project.path, cmd, 120, 40);
      } catch (e) {
        return reply.code(500).send({ error: `resume failed: ${(e as Error).message}` });
      }
      const updated = markConversationActive(id, cid) ?? conv;
      return { conversation: { ...updated, alive: true } };
    },
  );

  // batch:多选批量动作单点入口。move/star/unstar/close/softDelete;
  // 任一项失败(starred 项 softDelete、folderId 不存在、id 找不到)进 failed 列表不中断整批。
  app.post(
    '/api/projects/:id/conversations/batch',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = resolveVisibleProject(ctx, req.user!, id);
      if (!project) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const parse = BatchSchema.safeParse(req.body ?? {});
      if (!parse.success) return reply.code(400).send({ error: 'bad request' });
      const { ids, action, payload } = parse.data;
      const succeeded: string[] = [];
      const failed: { id: string; reason: string }[] = [];
      for (const cid of ids) {
        const conv = ctx.conversations.getInProject(id, cid);
        // 垃圾箱里的会话对批量动作视同不存在,不能被 move/star/close 悄悄改动。
        if (!conv || conv.deletedAt) {
          failed.push({ id: cid, reason: 'not_found' });
          continue;
        }
        const runtimeKey = conversationRuntimeKey(id, cid);
        try {
          if (action === 'move') {
            const folderId = payload?.folderId ?? null;
            if (folderId !== null) {
              const f = ctx.folders.get(folderId);
              if (!f || f.projectId !== id) {
                failed.push({ id: cid, reason: 'folder_not_found' });
                continue;
              }
            }
            ctx.conversations.updateInProject(id, cid, { folderId });
          } else if (action === 'star') {
            ctx.conversations.updateInProject(id, cid, { starred: true });
          } else if (action === 'unstar') {
            ctx.conversations.updateInProject(id, cid, { starred: false });
          } else if (action === 'close') {
            if (!conv.closedAt) {
              await ctx.getTmux(req.user!.unixUser).killSession(conv.tmuxName);
              ctx.chatRegistry.forceClose(runtimeKey);
              ctx.conversations.updateInProject(id, cid, { closedAt: new Date().toISOString() });
            }
          } else if (action === 'softDelete') {
            if (conv.starred) {
              failed.push({ id: cid, reason: 'starred_locked' });
              continue;
            }
            await ctx.getTmux(req.user!.unixUser).killSession(conv.tmuxName);
            ctx.chatRegistry.forceClose(runtimeKey);
            ctx.conversations.softDeleteInProject(id, cid);
          }
          succeeded.push(cid);
        } catch (e) {
          failed.push({ id: cid, reason: (e as Error).message });
        }
      }
      return { succeeded, failed };
    },
  );

  // ---- 终端历史阅读层（只读 HTTP，独立于 WS 字节流） ----
  // 用 capture-pane -J 抓真实屏字符(已合并折行)，按窗口懒加载；与实时终端零共享可变状态。
  app.get(
    '/api/projects/:id/conversations/:cid/scrollback',
    { preHandler: requireAuth },
    async (req, reply): Promise<ScrollbackChunk> => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' }) as unknown as ScrollbackChunk;
      }
      const conv = scope.conversation;
      const q = req.query as { before?: string; limit?: string };
      const before = q.before && /^\d+$/.test(q.before) ? parseInt(q.before, 10) : null;
      const limit = Math.min(Math.max(parseInt(q.limit ?? '800', 10) || 800, 1), 5000);

      const info = await ctx.getTmux(req.user!.unixUser).historyInfo(conv.tmuxName);
      if (!info) return { lines: [], nextBefore: 0, atTop: true };

      const w = computeWindow({
        historySize: info.historySize,
        paneHeight: info.paneHeight,
        before,
        limit,
      });
      if (w.empty) return { lines: [], nextBefore: w.nextBefore, atTop: w.atTop };

      const raw = await ctx.getTmux(req.user!.unixUser).captureRange(conv.tmuxName, w.startLine, w.endLine);
      // 空窗(空白屏/抓取失败)直接给空数组，避免 ''.split 产生一个伪空行。
      const lines = raw === '' ? [] : raw.replace(/\n$/, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
      return { lines, nextBefore: w.nextBefore, atTop: w.atTop };
    },
  );

  // ---- 「重排」HTTP:杀 tmux + 用传入 cols/rows 新建 + claude --resume。
  //   尝试过两种轻量方案都不行:SIGSTOP/CONT 不触发 claude 重打 transcript(信号层无钩子);
  //   clear-history 删了旧内容用户没法往上滚看历史。最后还是回到"重启 claude"——新 tmux pane
  //   按指定宽度起,claude --resume 接续对话,渲染整段历史到 alt screen,完成回合时按新宽度
  //   进 scrollback。旧 scrollback 一起没了,但 transcript 文件没动,resume 之后历史照样可见。
  //   代价:必然中断当前 claude 任务(工具调用、思考、AskUserQuestion 全保不住)——前端按钮按下时
  //   必须 confirm 警告用户。query: cols/rows = 新 pane 初始尺寸(终端模式传 xterm 实际尺寸)。 ----
  app.post(
    '/api/projects/:id/conversations/:cid/reflow',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const { project, conversation: conv } = scope;
      if (!ctx.agentAccess.canUse(req.user!, conv.agentKind)) {
        return reply.code(403).send({ error: 'agent_access_denied' });
      }
      // 解析 cols/rows:前端传当前视图实际尺寸,落在合理范围(2..1000)。缺省 detached 默认 120×40。
      const q = req.query as { cols?: string; rows?: string };
      const cols = Math.min(Math.max(parseInt(q.cols ?? '120', 10) || 120, 2), 1000);
      const rows = Math.min(Math.max(parseInt(q.rows ?? '40', 10) || 40, 2), 1000);

      // hook 待答 sidecar 一并清掉:杀了 claude,正在等的那个 AskUserQuestion 上下文也没了,
      // 留着文件会让重启后的 chatSession.tick 误把它当成新一轮待答。
      // 多用户隔离 2026-06-24:sidecar 实际在 <askDir>/<unixUser>/<sid>.json
      // (chatSession.ensure 走 askDir=<askDir>/<unixUser>,这里要对齐,否则删了空气、真 sidecar 还在)。
      if (conv.sessionId) {
        const userAskDir = (await import('node:path')).join(ctx.config.askDir, req.user!.unixUser);
        const pending = readPendingAsk(userAskDir, conv.sessionId);
        if (pending) {
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            fs.unlinkSync(path.join(userAskDir, `${conv.sessionId}.json`));
          } catch {
            /* 文件不在:无妨 */
          }
        }
      }

      // 杀 tmux session = 同时杀 claude(pane 主进程就是它)。等 100ms 让 tmux server 清干净 entry,
      // 否则紧接着的 new-session 同名会撞。
      try {
        await ctx.getTmux(req.user!.unixUser).killSession(conv.tmuxName);
      } catch {
        /* 已不在:正好,直接拉新的 */
      }
      // 强制清掉 chatRegistry 里这条 conv 的 entry:reflow 杀+重建后,前端 chat WS 收到 WS close
      // 触发自动重连,新一轮 subscribe 用最新的 spec(含 unixUser/cwd/sessionId),重置 ChatSession
      // 状态机(transcript tail 偏移、polling 计时、askSidecar 缓存)。
      // 没这个 forceClose:旧 entry 持有的 perUserTmux 是创建当时的 unixUser、tail.offset 也是旧 transcript
      // 的尾偏移,reflow 写完新内容前端要么看不到、要么把残屏当当前态(用户看到的"循环关闭重开"症状之一)。
      ctx.chatRegistry.forceClose(scope.runtimeKey);
      await new Promise((r) => setTimeout(r, 100));

      // 重新拉 tmux + bash + agent,走 adapter(claude 与 ChatSession.ensure 共享同一拼装,
      // env/hook/effort 一致;codex 拼 codex 子命令)。已有 transcript(几乎总是) → resume 接续;
      // 首次 → launch。
      const targetTmux = ctx.getTmux(req.user!.unixUser);
      const adapter = pickAdapter(conv.agentKind);
      const launchCommand = resolveLaunchCommand(conv, project);
      const hasTranscript =
        adapter.locateTranscript(conv.sessionId, req.user!.unixUser, project.path) !== null;
      const cmd = hasTranscript
        ? adapter.buildResumeCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort, askLaunch: ctx.askLaunchFor(req.user!.unixUser) })
        : adapter.buildLaunchCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort, askLaunch: ctx.askLaunchFor(req.user!.unixUser) });
      try {
        await targetTmux.newDetached(conv.tmuxName, project.path, cmd, cols, rows);
      } catch (e) {
        return reply.code(500).send({ error: `重启 claude 失败: ${(e as Error).message}` });
      }

      // 健壮性兜底 2026-06-24:claude --resume 可能因 transcript 留有 deferred tool 中间态而立刻退出
      // (报 "No deferred tool marker found")。tmux pane 主进程 = claude;它退则 session 关。
      // 这正是用户描述的"循环关闭重开":每次重排都瞬间死掉,看着像循环。
      //
      // 策略:newDetached 后等 1.2s 探活;死了就生成新 sessionId 写回 conv,再 newDetached 一次
      // (新 sid 必然无 transcript → 走 --session-id 路径,稳过)。代价:这次重排失去历史接续,
      // 但 conv 仍在、对话可继续——比让用户面对"死循环"好。
      // 注:--resume 在 happy path 仍走(99% 场景没问题),这里只对异常情况兜底,不影响正常流。
      let effectiveSid = conv.sessionId;
      await new Promise((r) => setTimeout(r, 1200));
      if (!(await targetTmux.hasSession(conv.tmuxName))) {
        const newSid = crypto.randomUUID();
        ctx.conversations.updateInProject(id, cid, { sessionId: newSid });
        // 新 sid 必然无 transcript → 走 buildLaunchCmd(首次启动路径)。
        const cmd2 = adapter.buildLaunchCmd({
          launchCommand,
          sessionId: newSid,
          effort: conv.effort,
          askLaunch: ctx.askLaunchFor(req.user!.unixUser),
        });
        try {
          await targetTmux.newDetached(conv.tmuxName, project.path, cmd2, cols, rows);
          effectiveSid = newSid;
        } catch (e) {
          return reply.code(500).send({ error: `重启 claude 失败(fallback): ${(e as Error).message}` });
        }
      }
      return { ok: true, cols, rows, sessionId: effectiveSid };
    },
  );

  // ---- 终端流 WebSocket ----
  app.get(
    '/api/projects/:id/conversations/:cid/stream',
    { websocket: true },
    (socket: WebSocket, req) => {
      const user = resolveUser(ctx.config.sessionSecret, ctx.users, ctx.subUsers, req.cookies?.[COOKIE_NAME]);
      if (!user) {
        socket.close(1008, 'unauthorized');
        return;
      }
      const { id, cid } = req.params as { id: string; cid: string };
      const scope = resolveSessionScope(ctx, user, id, cid);
      if (!scope) {
        // 软删除的会话当作 not found:先去垃圾箱恢复才能再连终端。
        socket.close(1011, 'not found');
        return;
      }
      const { project, conversation: conv } = scope;
      if (!ctx.agentAccess.canUse(user, conv.agentKind)) {
        socket.close(1008, 'agent_access_denied');
        return;
      }
      const q = req.query as { cols?: string; rows?: string };
      const cols = Math.max(parseInt(q.cols ?? '80', 10) || 80, 2);
      const rows = Math.max(parseInt(q.rows ?? '24', 10) || 24, 2);

      // 终端视图也带 sessionId 启动（保证切到聊天视图能定位 transcript）；走 adapter:
      // 关键：已用过(transcript 存在)必须走 resume，否则 --session-id 会因
      // "Session ID already in use" 报错退出，表现为每次重启都打开新的。
      // 终端 WS 不传 askLaunch:沿用现状(终端模式 hook 是聊天专属)。
      const adapter = pickAdapter(conv.agentKind);
      const launchCommand = resolveLaunchCommand(conv, project);
      const hasTranscript =
        adapter.locateTranscript(conv.sessionId, user.unixUser, project.path) !== null;
      const command = hasTranscript
        ? adapter.buildResumeCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort })
        : adapter.buildLaunchCmd({ launchCommand, sessionId: conv.sessionId, effort: conv.effort });
      const handle = ctx.registry.subscribe(
        scope.runtimeKey,
        // 多用户隔离 2026-06-24:必须把登录身份的 unixUser 透给 BridgeSpec,
        // 否则 ptyBridge 落到 ServiceUser(wangleyan)socket,zhangrengang 的项目里
        // claude Bash 工具看到的就是 wangleyan(实证 bug)。
        { tmuxName: conv.tmuxName, cwd: project.path, command, cols, rows, unixUser: user.unixUser },
        {
          onData: (data) => safeSend(socket, encodeServerMessage({ type: 'data', data })),
          onExit: (code) => {
            safeSend(socket, encodeServerMessage({ type: 'exit', code }));
            socket.close();
          },
        },
      );

      ctx.conversations.markActiveInProject(id, cid, new Date().toISOString());

      safeSend(socket, encodeServerMessage({ type: 'status', alive: true }));

      socket.on('message', (raw: Buffer) => {
        if (!ctx.agentAccess.canUse(user, conv.agentKind)) {
          socket.close(1008, 'agent_access_denied');
          return;
        }
        const msg = decodeClientMessage(raw.toString());
        if (!msg) return;
        if (msg.type === 'input') handle.write(msg.data);
        else if (msg.type === 'resize') handle.resize(msg.cols, msg.rows);
      });

      socket.on('close', () => handle.unsubscribe());
      socket.on('error', () => handle.unsubscribe());
    },
  );
}

function safeSend(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(data);
  }
}
