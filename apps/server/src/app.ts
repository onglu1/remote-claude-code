import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { execSync } from 'node:child_process';
import { statSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config';
import { buildContext, type AppContext } from './context';
import security from './plugins/security';
import { registerStaticSite } from './plugins/staticSite';
import { registerAuthRoutes } from './routes/auth';
import { registerAdminRoutes } from './routes/admin';
import { registerProjectRoutes } from './routes/projects';
import { registerFileRoutes } from './routes/files';
import { registerFsRoutes } from './routes/fs';
import { registerTaskEvidenceRoutes } from './routes/taskEvidence';
import { registerResearchRoutes } from './routes/research';
import { registerSessionRoutes } from './routes/sessions';
import { registerFolderRoutes } from './routes/folders';
import { registerChatRoutes } from './routes/chat';
import { registerMetricsRoutes } from './routes/metrics';
import { registerMeRoutes } from './routes/me';
import { IdleSweeper } from './lib/session/idleSweeper';
import { createActivityState, tickActivity, type ActivityIO, type ActivityState } from './lib/session/activity';
import { locateTranscript } from './lib/session/chat/transcript';

export interface BuildAppOptions {
  /** 测试时可注入已构建好的 context（跳过 argon2 等）。 */
  context?: AppContext;
  serveStatic?: boolean;
}

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const ctx = opts.context ?? (await buildContext(config));

  await app.register(cookie);
  await app.register(security, { trustCloudflare: config.trustCloudflare });
  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true }));

  await registerAuthRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerProjectRoutes(app, ctx);
  await registerFileRoutes(app, ctx);
  await registerFsRoutes(app, ctx);
  await registerTaskEvidenceRoutes(app, ctx);
  await registerResearchRoutes(app, ctx);
  await registerSessionRoutes(app, ctx);
  await registerFolderRoutes(app, ctx);
  await registerChatRoutes(app, ctx);
  await registerMetricsRoutes(app, ctx);
  await registerMeRoutes(app, ctx);

  // ---- IdleSweeper:每 60s 扫一次非休眠会话,超阈值就杀 tmux + 写 closedAt + 清 chatRegistry。
  // 活动探测器五信号:transcript jsonl 增量 tool_use、ask sidecar、transcript mtime、
  // statusline sidecar mtime、tmux pane hash 滑窗;任一为真即 busy。
  // 阈值取用户 idleCloseHours(默认 3,0=关闭功能)。
  // 这里的 ActivityIO 接上真实 fs / tmux,以便 sweeper 与生产环境一致。 ----
  const activityIO: ActivityIO = {
    transcriptStat: (p) => {
      try { const s = statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
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
      } finally { closeSync(fd); }
    },
    sidecarStat: (dir, sid) => {
      try { const s = statSync(join(dir, `${sid}.json`)); return { mtimeMs: s.mtimeMs }; } catch { return null; }
    },
    askSidecarExists: (dir, sid) => existsSync(join(dir, `${sid}.json`)),
    paneHash: (name) => {
      try {
        const out = execSync(`tmux -L ${ctx.config.tmuxSocket} capture-pane -p -t ${name}`, { encoding: 'utf8' });
        return crypto.createHash('sha1').update(out).digest('hex').slice(0, 16);
      } catch { return null; }
    },
    now: () => Date.now(),
  };

  // 每会话一份 state;sweeper 自己持有 map(进程级,与会话生命周期等长)。
  const activityStates = new Map<string, ActivityState>();
  // markActivity 节流:同一会话最多 60s 一次写盘,避免高频活动把 lastActivityAt 写飞。
  const lastActivityWriteTimes = new Map<string, number>();

  const sweeper = new IdleSweeper(
    {
      conversations: {
        listAllAlive: () => {
          // 把 projectId → ownerId 映射建好,sweeper 才能拿用户偏好(idleCloseHours)。
          const owners = new Map<string, string | undefined>();
          for (const p of ctx.projects.load()) owners.set(p.id, p.ownerId);
          return ctx.conversations.listAllAlive().map((c) => ({
            id: c.id,
            projectId: c.projectId,
            tmuxName: c.tmuxName,
            sessionId: c.sessionId,
            ownerId: owners.get(c.projectId),
          }));
        },
        update: (id, patch) => ctx.conversations.update(id, patch),
      },
      users: {
        getSettings: (uid) => ctx.users.get(uid)?.settings ?? { idleCloseHours: 3 },
      },
      tmux: { killSession: (n) => ctx.tmux.killSession(n) },
      registry: {
        isActive: (id) => ctx.chatRegistry.isActive(id),
        forceClose: (id) => ctx.chatRegistry.forceClose(id),
      },
      measureIdle: (c) => {
        let state = activityStates.get(c.id);
        if (!state) {
          state = createActivityState(Date.now());
          activityStates.set(c.id, state);
        }
        const r = tickActivity(
          state,
          {
            transcriptPath: locateTranscript(c.sessionId),
            tmuxName: c.tmuxName,
            sessionId: c.sessionId,
            statuslineDir: ctx.config.statuslineDir,
            askDir: ctx.config.askDir,
          },
          activityIO,
          90_000,
        );
        // busy 时顺便维护 lastActivityAt(供前端列表"最近活跃"排序);
        // 节流 60s 防过度写盘。fire-and-forget,失败不影响 sweep。
        if (r.busy) {
          const lastWrote = lastActivityWriteTimes.get(c.id) ?? 0;
          if (Date.now() - lastWrote > 60_000) {
            ctx.conversations.markActivity(c.id, new Date(Date.now()).toISOString());
            lastActivityWriteTimes.set(c.id, Date.now());
          }
        }
        return r;
      },
      now: () => Date.now(),
    },
    { intervalMs: 60_000, defaultThresholdHours: 3 },
  );

  sweeper.start();
  app.addHook('onClose', async () => { sweeper.stop(); });

  if (opts.serveStatic ?? true) {
    await registerStaticSite(app, config.webDist);
  }

  return app;
}
