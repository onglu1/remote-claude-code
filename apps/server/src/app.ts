import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import httpProxy from '@fastify/http-proxy';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { statSync, openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import type { Config } from './config';
import { buildContext, type AppContext } from './context';
import security from './plugins/security';
import { makeRequireAuth } from './plugins/requireAuth';
import { registerStaticSite } from './plugins/staticSite';
import { registerAuthRoutes } from './routes/auth';
import { registerAdminRoutes } from './routes/admin';
import { registerProjectRoutes } from './routes/projects';
import { registerFileRoutes } from './routes/files';
import { registerFsRoutes } from './routes/fs';
import { registerTaskEvidenceRoutes } from './routes/taskEvidence';
import { registerResearchRoutes } from './routes/research';
import { registerSessionRoutes } from './routes/sessions';
import { registerSessionSearchRoutes } from './routes/sessionSearch';
import { registerFolderRoutes } from './routes/folders';
import { registerChatRoutes } from './routes/chat';
import { registerMetricsRoutes } from './routes/metrics';
import { registerMeRoutes } from './routes/me';
import { registerVscodeRoutes } from './routes/vscode';
import { IdleSweeper } from './lib/session/idleSweeper';
import { createActivityState, tickActivity, type ActivityIO, type ActivityState } from './lib/session/activity';
import { conversationRuntimeKey } from './lib/conversationIdentity';
import { makeResolveUnixUser } from './lib/resolveUnixUser';

export interface BuildAppOptions {
  /** 测试时可注入已构建好的 context（跳过 argon2 等）。 */
  context?: AppContext;
  serveStatic?: boolean;
}

export async function buildApp(config: Config, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const ctx = opts.context ?? (await buildContext(config));
  let vscodeProc: ChildProcess | null = null;

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
  await registerSessionSearchRoutes(app, ctx);
  await registerFolderRoutes(app, ctx);
  await registerChatRoutes(app, ctx);
  await registerMetricsRoutes(app, ctx);
  await registerMeRoutes(app, ctx);
  await registerVscodeRoutes(app, ctx);

  if (config.vscodeProxyTarget.trim()) {
    await app.register(httpProxy, {
      upstream: config.vscodeProxyTarget,
      prefix: config.vscodeProxyPrefix,
      rewritePrefix: '/',
      websocket: true,
      preHandler: makeRequireAuth(ctx.config.sessionSecret, ctx.users, ctx.subUsers),
      replyOptions: {
        rewriteHeaders(headers) {
          const next = { ...headers };
          delete next['x-frame-options'];
          delete next['content-security-policy'];
          return next;
        },
      },
    });
  }

  if (config.vscodeCommand.trim()) {
    vscodeProc = spawn(config.vscodeCommand, {
      cwd: config.repoRoot,
      shell: true,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      detached: false,
    });
    vscodeProc.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.error(`[remote-cc] VSCode Web 进程退出: code=${code} signal=${signal ?? ''}`);
      }
      vscodeProc = null;
    });
  }

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

  // 多用户隔离:按 ownerId(可能是 user.id 或 subUser.id) 查到对应 unixUser。
  // 用于 sweeper / measureIdle 决定:tmux 在哪个 socket 杀、transcript 在哪个家找。
  // 抽到 lib/resolveUnixUser 给 SessionIndex 也复用,避免双实现漂移。
  const resolveUnixUser = makeResolveUnixUser(ctx.users, ctx.subUsers, ctx.config.serviceUser);

  const sweeper = new IdleSweeper(
    {
      conversations: {
        listAllAlive: () => {
          // 把 projectId → ownerId/path 映射建好:owner 给 sweeper 拿用户偏好(idleCloseHours),
          // path 是 codex adapter.locateTranscript 按 cwd 过滤 rollout 文件的必需参数。
          const owners = new Map<string, string | undefined>();
          const paths = new Map<string, string>();
          for (const p of ctx.projects.load()) {
            owners.set(p.id, p.ownerId);
            paths.set(p.id, p.path);
          }
          return ctx.conversations.listAllAlive().map((c) => ({
            id: c.id,
            projectId: c.projectId,
            tmuxName: c.tmuxName,
            sessionId: c.sessionId,
            agentKind: c.agentKind,
            cwd: paths.get(c.projectId) ?? '',
            ownerId: owners.get(c.projectId),
          }));
        },
        update: (projectId, id, patch) => ctx.conversations.updateInProject(projectId, id, patch),
      },
      users: {
        getSettings: (uid) => ctx.users.get(uid)?.settings ?? { idleCloseHours: 3 },
      },
      // 多用户隔离设计:按 conversation owner 解析 unixUser,
      // 否则跨 unix 用户的 idle kill 永远落在 ServiceUser socket 上,杀不到。
      tmux: {
        killSession: (n, ownerId) => {
          const unixUser = resolveUnixUser(ownerId);
          return ctx.getTmux(unixUser).killSession(n);
        },
      },
      registry: {
        isActive: (projectId, id) => ctx.chatRegistry.isActive(conversationRuntimeKey(projectId, id)),
        forceClose: (projectId, id) => ctx.chatRegistry.forceClose(conversationRuntimeKey(projectId, id)),
      },
      measureIdle: (c) => {
        const key = conversationRuntimeKey(c.projectId, c.id);
        let state = activityStates.get(key);
        if (!state) {
          state = createActivityState(Date.now());
          activityStates.set(key, state);
        }
        // 多用户隔离:transcript / sidecar 路径按 conversation owner 的 unixUser 解析。
        const unixUser = resolveUnixUser(c.ownerId);
        // 按 agentKind 走对应 adapter 定位 transcript——之前这里硬编码 claude 专属的
        // locateTranscript(~/.claude/projects/*),codex 会话传进来恒定 null:①③两个信号
        // (未配对 tool_use / transcript mtime 滑窗)对 codex 全程失效,只剩⑤pane hash 一个信号,
        // 空闲误杀概率明显偏高。
        const r = tickActivity(
          state,
          {
            transcriptPath: ctx.adapterFor(c.agentKind).locateTranscript(c.sessionId, unixUser, c.cwd),
            tmuxName: c.tmuxName,
            sessionId: c.sessionId,
            statuslineDir: `${ctx.config.statuslineDir}/${unixUser}`,
            askDir: `${ctx.config.askDir}/${unixUser}`,
          },
          activityIO,
          90_000,
        );
        // busy 时顺便维护 lastActivityAt(供前端列表"最近活跃"排序);
        // 节流 60s 防过度写盘。fire-and-forget,失败不影响 sweep。
        if (r.busy) {
          const lastWrote = lastActivityWriteTimes.get(key) ?? 0;
          if (Date.now() - lastWrote > 60_000) {
            ctx.conversations.markActivityInProject(c.projectId, c.id, new Date(Date.now()).toISOString());
            lastActivityWriteTimes.set(key, Date.now());
          }
        }
        return r;
      },
      now: () => Date.now(),
    },
    { intervalMs: 60_000, defaultThresholdHours: 3 },
  );

  // SessionIndex 启动顺序:在 sweeper 前先 start(startupSweep 同步扫一遍所有已登记会话)。
  // 60s 自有 timer + 主进程唯一 writer,与 IdleSweeper 节奏相同但独立 ref。
  ctx.sessionIndex.start();
  sweeper.start();
  app.addHook('onClose', async () => {
    sweeper.stop();
    ctx.sessionIndex.close();
    if (vscodeProc && !vscodeProc.killed) {
      vscodeProc.kill('SIGTERM');
    }
  });

  if (opts.serveStatic ?? true) {
    await registerStaticSite(app, config.webDist);
  }

  return app;
}
