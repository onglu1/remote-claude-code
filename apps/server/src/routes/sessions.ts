import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Conversation, ScrollbackChunk } from '@rcc/shared';
import { decodeClientMessage, encodeServerMessage } from '@rcc/shared';
import type { AppContext } from '../context';
import { makeRequireAuth, resolveUser } from '../plugins/requireAuth';
import { COOKIE_NAME } from '../lib/auth';
import { canSeeProject } from '../lib/authz';
import { launchFlag, locateTranscript } from '../lib/session/chat/transcript';
import { effortFlag } from '../lib/session/effort';
import { computeWindow } from '../lib/session/scrollback';
import { readPendingAsk } from '../lib/session/chat/askSidecar';
import { buildClaudeCmd } from '../lib/session/chat/launch';

const CreateConvSchema = z.object({
  name: z.string().optional(),
  /** 可选:用一个已存在的 claude sessionId 新建会话,首次拉起会以 --resume 接续。 */
  sessionId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '需要标准 UUID 格式')
    .optional(),
});
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

export async function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users);

  // 会话存活判定：tmux 命中其 tmuxName，或注册表里仍活跃。
  async function aliveOf(conv: { id: string; tmuxName: string }): Promise<boolean> {
    const alive = new Set(await ctx.tmux.listSessions());
    return alive.has(conv.tmuxName) || ctx.registry.isActive(conv.id);
  }

  async function withAlive(projectId: string): Promise<Conversation[]> {
    const alive = new Set(await ctx.tmux.listSessions());
    return ctx.conversations.listByProject(projectId).map((c) => ({
      ...c,
      alive: alive.has(c.tmuxName) || ctx.registry.isActive(c.id),
    }));
  }

  // ---- 会话元数据 REST ----
  app.get(
    '/api/projects/:id/conversations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return { conversations: await withAlive(id) };
    },
  );

  app.post(
    '/api/projects/:id/conversations',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const parse = CreateConvSchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0]?.message ?? 'bad request' });
      }
      // 显式指定 sessionId 时:首次拉起 ensure() 会检测 transcript 已存在 → --resume,接续旧对话。
      const conv = ctx.conversations.create(id, parse.data.name ?? '', parse.data.sessionId);
      return { conversation: { ...conv, alive: false } };
    },
  );

  // 列垃圾箱:已软删除的会话,按删除时间倒序(最近删的最上)。
  app.get(
    '/api/projects/:id/conversations/trash',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
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
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const restored = ctx.conversations.restore(cid);
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
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const hard = (req.query as { hard?: string }).hard === '1';
      // 标星会话拒软删(避免误丢进垃圾箱);硬删 hard=1 是显式动作,不拦。
      if (!hard && conv.starred) {
        return reply.code(409).send({ error: 'starred_locked' });
      }
      // tmux 一定杀(无论软/硬):软删时如果 TUI 还活着,留着也没意义且占资源。
      await ctx.tmux.killSession(conv.tmuxName);
      if (hard) {
        ctx.conversations.hardDelete(cid);
      } else {
        ctx.conversations.softDelete(cid);
      }
      return { ok: true, hard };
    },
  );

  // 局部更新：name / folderId / starred。folderId 必须指向本项目存在文件夹;null 显式清除归属。
  // 复用 ConversationStore.update;与其它会话路由同样的可见性过滤。
  app.patch(
    '/api/projects/:id/conversations/:cid',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, cid } = req.params as { id: string; cid: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const parse = PatchConvSchema.safeParse(req.body ?? {});
      if (!parse.success) {
        return reply.code(400).send({ error: parse.error.issues[0]?.message ?? 'bad request' });
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      // folderId 非空时校验存在且属于本项目;null 表示显式清除归属(允许)。
      if (parse.data.folderId !== undefined && parse.data.folderId !== null) {
        const f = ctx.folders?.get?.(parse.data.folderId);
        if (!f || f.projectId !== id) {
          return reply.code(400).send({ error: 'folder not found' });
        }
      }
      const updated = ctx.conversations.update(cid, parse.data);
      if (!updated) return reply.code(404).send({ error: 'conversation not found' });
      return { conversation: { ...updated, alive: await aliveOf(updated) } };
    },
  );

  // ---- 终端历史阅读层（只读 HTTP，独立于 WS 字节流） ----
  // 用 capture-pane -J 抓真实屏字符(已合并折行)，按窗口懒加载；与实时终端零共享可变状态。
  app.get(
    '/api/projects/:id/conversations/:cid/scrollback',
    { preHandler: requireAuth },
    async (req, reply): Promise<ScrollbackChunk> => {
      const { id, cid } = req.params as { id: string; cid: string };
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' }) as unknown as ScrollbackChunk;
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id || conv.deletedAt) {
        return reply.code(404).send({ error: 'conversation not found' }) as unknown as ScrollbackChunk;
      }
      const q = req.query as { before?: string; limit?: string };
      const before = q.before && /^\d+$/.test(q.before) ? parseInt(q.before, 10) : null;
      const limit = Math.min(Math.max(parseInt(q.limit ?? '800', 10) || 800, 1), 5000);

      const info = await ctx.tmux.historyInfo(conv.tmuxName);
      if (!info) return { lines: [], nextBefore: 0, atTop: true };

      const w = computeWindow({
        historySize: info.historySize,
        paneHeight: info.paneHeight,
        before,
        limit,
      });
      if (w.empty) return { lines: [], nextBefore: w.nextBefore, atTop: w.atTop };

      const raw = await ctx.tmux.captureRange(conv.tmuxName, w.startLine, w.endLine);
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
      const project = ctx.projects.get(id);
      if (!project || !canSeeProject(req.user!, project)) {
        return reply.code(404).send({ error: 'project not found' });
      }
      const conv = ctx.conversations.get(cid);
      if (!conv || conv.projectId !== id || conv.deletedAt) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      // 解析 cols/rows:前端传当前视图实际尺寸,落在合理范围(2..1000)。缺省 detached 默认 120×40。
      const q = req.query as { cols?: string; rows?: string };
      const cols = Math.min(Math.max(parseInt(q.cols ?? '120', 10) || 120, 2), 1000);
      const rows = Math.min(Math.max(parseInt(q.rows ?? '40', 10) || 40, 2), 1000);

      // hook 待答 sidecar 一并清掉:杀了 claude,正在等的那个 AskUserQuestion 上下文也没了,
      // 留着文件会让重启后的 chatSession.tick 误把它当成新一轮待答。
      if (conv.sessionId) {
        const pending = readPendingAsk(ctx.config.askDir, conv.sessionId);
        if (pending) {
          // 复用 ChatSession 那条清理路径:cleanAskSidecar 是 fs.unlinkSync,这里也可以直接调,
          // 但避免依赖私有注入,简单 try 删。
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            fs.unlinkSync(path.join(ctx.config.askDir, `${conv.sessionId}.json`));
          } catch {
            /* 文件不在:无妨 */
          }
        }
      }

      // 杀 tmux session = 同时杀 claude(pane 主进程就是它)。等 100ms 让 tmux server 清干净 entry,
      // 否则紧接着的 new-session 同名会撞。
      try {
        await ctx.tmux.killSession(conv.tmuxName);
      } catch {
        /* 已不在:正好,直接拉新的 */
      }
      await new Promise((r) => setTimeout(r, 100));

      // 重新拉 tmux + bash + claude,与 ChatSession.ensure 共享 buildClaudeCmd(env/hook/effort 一致)。
      // 已有 transcript(几乎总是) → --resume 接续;首次 → --session-id。
      const cmd = buildClaudeCmd({
        launchCommand: project.launchCommand,
        sessionId: conv.sessionId,
        effort: conv.effort,
        hasTranscript: locateTranscript(conv.sessionId) !== null,
        askLaunch: ctx.askLaunch,
      });
      try {
        await ctx.tmux.newDetached(conv.tmuxName, project.path, cmd, cols, rows);
      } catch (e) {
        return reply.code(500).send({ error: `重启 claude 失败: ${(e as Error).message}` });
      }
      return { ok: true, cols, rows };
    },
  );

  // ---- 终端流 WebSocket ----
  app.get(
    '/api/projects/:id/conversations/:cid/stream',
    { websocket: true },
    (socket: WebSocket, req) => {
      const user = resolveUser(ctx.config.sessionSecret, ctx.users, req.cookies?.[COOKIE_NAME]);
      if (!user) {
        socket.close(1008, 'unauthorized');
        return;
      }
      const { id, cid } = req.params as { id: string; cid: string };
      const project = ctx.projects.get(id);
      const conv = ctx.conversations.get(cid);
      if (!project || !conv || !canSeeProject(user, project) || conv.deletedAt) {
        // 软删除的会话当作 not found:先去垃圾箱恢复才能再连终端。
        socket.close(1011, 'not found');
        return;
      }
      const q = req.query as { cols?: string; rows?: string };
      const cols = Math.max(parseInt(q.cols ?? '80', 10) || 80, 2);
      const rows = Math.max(parseInt(q.rows ?? '24', 10) || 24, 2);

      // 终端视图也带 sessionId 启动（保证切到聊天视图能定位 transcript）；
      // 关键：已用过(transcript 存在)必须 --resume，否则 --session-id 会因
      // "Session ID already in use" 报错退出，表现为每次重启都打开新的。
      const command = `${project.launchCommand} ${effortFlag(conv.effort)} ${launchFlag(conv.sessionId)}`;
      const handle = ctx.registry.subscribe(
        cid,
        { tmuxName: conv.tmuxName, cwd: project.path, command, cols, rows },
        {
          onData: (data) => safeSend(socket, encodeServerMessage({ type: 'data', data })),
          onExit: (code) => {
            safeSend(socket, encodeServerMessage({ type: 'exit', code }));
            socket.close();
          },
        },
      );

      safeSend(socket, encodeServerMessage({ type: 'status', alive: true }));

      socket.on('message', (raw: Buffer) => {
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
