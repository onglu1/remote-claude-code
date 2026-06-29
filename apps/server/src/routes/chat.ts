import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { decodeChatClient, encodeChatServer, type ChatServerMessage } from '@rcc/shared';
import type { AppContext } from '../context';
import type { ChatHandle } from '../lib/session/chat/chatRegistry';
import { COOKIE_NAME } from '../lib/auth';
import { makeRequireAuth, resolveUser } from '../plugins/requireAuth';
import { resolveLaunchCommand } from '../lib/session/chat/agent/resolveLaunchCommand';
import { resolveSessionScope } from './sessionScope';

const UPLOAD_DIR = path.join(os.tmpdir(), 'rcc-uploads');
/** 单文件上限:手机相机直出大约 5–10MB,留 30MB 余量;超出在路由层 bodyLimit 兜底拒绝。 */
const UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

/** 写入字节到 UPLOAD_DIR,返回落盘绝对路径(供 claude TUI 直接读图)。 */
function saveImageBytes(buf: Buffer, mime: string, name: string): string {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const safe = (name || '').replace(/[^a-zA-Z0-9._-]/g, '_') || `img.${ext}`;
  const file = path.join(UPLOAD_DIR, `${crypto.randomBytes(4).toString('hex')}-${safe}`);
  fs.writeFileSync(file, buf);
  return file;
}

/** 兼容旧 WS 路径(base64 字符串):仍保留,但前端已不再走这条。 */
function saveImage(dataB64: string, mime: string, name: string): string {
  return saveImageBytes(Buffer.from(dataB64, 'base64'), mime, name);
}

export async function registerChatRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const requireAuth = makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers);

  // 图片以 raw octet-stream 上传(无需 multipart 依赖):前端 fetch POST 整段 ArrayBuffer,
  // 后端这条解析器把 body 收成 Buffer。仅这条路由生效,不污染 JSON 默认解析。
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLOAD_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  /**
   * 图片上传(HTTP):前端把整段二进制 POST 上来,后端落盘并返回路径。
   * 路径作为普通文本经 WS 发给 claude,避免「大 base64 全塞 JSON 走 WS」在手机端崩。
   * 走会话 scope 校验权限与项目归属,防越权占盘。
   */
  app.post<{
    Params: { id: string; cid: string };
    Querystring: { name?: string; mime?: string };
  }>(
    '/api/projects/:id/conversations/:cid/uploads',
    { preHandler: requireAuth, bodyLimit: UPLOAD_MAX_BYTES },
    async (req, reply) => {
      const { id, cid } = req.params;
      const scope = resolveSessionScope(ctx, req.user!, id, cid);
      if (!scope) {
        return reply.code(404).send({ error: 'conversation not found' });
      }
      const conv = scope.conversation;
      if (!ctx.agentAccess.canUse(req.user!, conv.agentKind)) {
        return reply.code(403).send({ error: 'agent_access_denied' });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: 'empty body' });
      }
      const mime = (req.query.mime || (req.headers['content-type'] as string) || 'image/png').split(';')[0];
      const name = req.query.name || `img.${mime.split('/')[1] || 'png'}`;
      try {
        const file = saveImageBytes(body, mime, name);
        return { path: file };
      } catch {
        return reply.code(500).send({ error: 'save failed' });
      }
    },
  );

  app.get(
    '/api/projects/:id/conversations/:cid/chat',
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
        // 软删除的会话当作 not found:URL 偷进也不行,先去垃圾箱恢复。
        socket.close(1011, 'not found');
        return;
      }
      const { project, conversation: conv } = scope;
      if (!ctx.agentAccess.canUse(user, conv.agentKind)) {
        socket.close(1008, 'agent_access_denied');
        return;
      }
      if (!conv.sessionId) {
        socket.close(1011, 'missing sessionId');
        return;
      }

      const send = (m: ChatServerMessage) => safeSend(socket, encodeChatServer(m));
      const spec = {
        tmuxName: conv.tmuxName,
        cwd: project.path,
        // sessionIndex 推送用:chatSession 把 `${projectId}:${convId}` 当 sessionKey
        projectId: id,
        convId: cid,
        // 会话级 launchCommand 覆盖优先,缺省回退 agent 默认(codex 用 CODEX_DEFAULT_LAUNCH、
        // claude 用 project.launchCommand);二级回退逻辑收敛在 resolveLaunchCommand,各启动路径共用。
        launchCommand: resolveLaunchCommand(conv, project),
        sessionId: conv.sessionId,
        effort: conv.effort,
        cols: 120,
        rows: 40,
        // 多用户隔离:tmux/claude 以登录身份的 unix 用户跑(默认主账号 unixUser;子用户继承父)。
        unixUser: user.unixUser,
        // agent 类型(老数据缺 → schema 回填 'claude')。
        agentKind: conv.agentKind,
        // codex 显式 discovered(用户传入续接的真实 UUID,或首次扫到回写过):
        // 仅作为元数据传入;是否 resume 仍由 adapter 在当前项目 cwd 下定位 transcript 决定。
        codexSessionDiscovered: conv.codexSessionDiscovered === true,
        excludeSessionIds: ctx.conversations
          .listAll()
          .filter((c) => !(c.projectId === id && c.id === cid))
          .map((c) => c.sessionId),
        // codex 首次启动后 ChatSession 异步扫到真实 UUID 时回写(claude 路径 presetSessionId=true,
        // 永不触发,行为零变化):落盘 sessionId + 置 codexSessionDiscovered=true。后续是否 resume
        // 仍由 adapter 在当前 cwd 下定位 transcript 决定。
        onSessionIdResolved: (real: string) => {
          ctx.conversations.updateInProject(id, conv.id, {
            sessionId: real,
            codexSessionDiscovered: true,
          });
        },
      };

      let handle: ChatHandle | null = null;
      ctx.chatRegistry
        .subscribe(scope.runtimeKey, spec, {
          onHistory: (snap) => send({ type: 'history', items: snap.items, live: snap.live }),
          onMessage: (message) => send({ type: 'message', message }),
          onPreview: (text) => send({ type: 'preview', text }),
          onTurnState: (running) => send({ type: 'turn_state', running }),
          onAskState: (s) => send({ type: 'ask_state', toolUseId: s.toolUseId, status: s.status, error: s.error }),
          onAskPending: (a) =>
            send({
              type: 'ask_pending',
              options: a.options,
              multiSelect: a.multiSelect,
              question: a.question,
              header: a.header,
              qIndex: a.qIndex,
              qTotal: a.qTotal,
            }),
          onAskPendingClear: () => send({ type: 'ask_pending_clear' }),
          onAskPendingFailed: (error) => send({ type: 'ask_pending_failed', error }),
          onHud: (hud) => send({ type: 'hud', hud }),
        })
        .then((h) => {
          handle = h;
          ctx.conversations.markActiveInProject(id, cid, new Date().toISOString());
          send({ type: 'session', sessionId: conv.sessionId, name: conv.name });
          send({ type: 'effort', level: conv.effort ?? 'max' });
        })
        .catch((e: unknown) => {
          send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
          socket.close();
        });

      socket.on('message', (raw: Buffer) => {
        if (!ctx.agentAccess.canUse(user, conv.agentKind)) {
          socket.close(1008, 'agent_access_denied');
          return;
        }
        const msg = decodeChatClient(raw.toString());
        if (!msg || !handle) return;
        switch (msg.type) {
          case 'user_text':
            void handle.sendText(msg.text);
            break;
          case 'key':
            void handle.sendKey(msg.key);
            break;
          case 'interrupt':
            void handle.interrupt();
            break;
          case 'image': {
            try {
              const file = saveImage(msg.dataB64, msg.mime, msg.name);
              void handle.sendText(file);
            } catch {
              send({ type: 'error', message: '图片保存失败' });
            }
            break;
          }
          case 'peek':
            void handle.peek().then((text) => send({ type: 'peek', text }));
            break;
          case 'refresh':
            // 不中断对话:发 Ctrl-L 给 TUI + resize-window 触发 SIGWINCH;无回包,下次 tick 自然抓新内容。
            void handle.refresh().catch(() => {/* 旧 tmux/会话已关:忽略 */});
            break;
          case 'set_effort':
            ctx.conversations.updateInProject(id, cid, { effort: msg.level });
            void handle.setEffort(msg.level);
            send({ type: 'effort', level: msg.level });
            break;
          case 'rewind_open':
            void handle
              .rewindOpen()
              .then((items) => send({ type: 'rewind_list', items }))
              .catch((e: unknown) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
            break;
          case 'rewind_execute':
            void handle
              .rewindExecute(msg.index, msg.mode)
              .then((r) => send({ type: 'rewind_done', mode: msg.mode, ok: r.ok }))
              .catch((e: unknown) => send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
            break;
          case 'rewind_cancel':
            void handle.rewindCancel();
            break;
          case 'ask_answer':
            void handle.answerAsk(msg.toolUseId, msg.picks);
            break;
          case 'ask_pending_answer':
            void handle.answerPendingAsk(msg.optionIndices);
            break;
          case 'load_turn': {
            const body = handle.loadTurn(msg.turnId);
            if (body) send({ type: 'turn_body', turnId: msg.turnId, messages: body });
            break;
          }
          case 'resync':
            handle.resync();
            break;
        }
      });

      socket.on('close', () => handle?.unsubscribe());
      socket.on('error', () => handle?.unsubscribe());
    },
  );
}

function safeSend(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) socket.send(data);
}
