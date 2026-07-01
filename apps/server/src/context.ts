import { readFileSync, statSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import argon2 from 'argon2';
import type { AgentKind } from '@rcc/shared';
import type { Config } from './config';
import type { AgentAdapter } from './lib/session/chat/agent/adapter';
import { ProjectStore } from './lib/projects';
import { UserStore } from './lib/users';
import { SubUserStore } from './lib/subUsers';
import { ConversationStore } from './lib/conversations';
import { FolderStore } from './lib/folders';
import { AgentAccessStore } from './lib/agentAccess';
import { SessionIndex } from './lib/sessionIndex';
import { makeResolveUnixUser } from './lib/resolveUnixUser';
import { Tmux } from './lib/session/tmux';
import { SessionRegistry } from './lib/session/registry';
import { makeRealBridgeFactory } from './lib/session/ptyBridge';
import { ChatRegistry } from './lib/session/chat/chatRegistry';
import { ChatSession } from './lib/session/chat/chatSession';
import { scrapePane } from './lib/session/chat/paneScraper';
import { makeClaudeAdapter } from './lib/session/chat/agent/claudeAdapter';
import { makeCodexAdapter } from './lib/session/chat/agent/codexAdapter';
import { ensureAskHookSettings, askLaunchExtra } from './lib/session/chat/askHookSettings';
import { readPendingAsk, askSidecarPath } from './lib/session/chat/askSidecar';
import { ResearchProviderRegistry } from './lib/researchProvider';

/** 运行期共享上下文，注入到各 route。 */
export interface AppContext {
  config: Config;
  adminHash: string;
  projects: ProjectStore;
  users: UserStore;
  /** 子用户存储(多用户隔离设计 2026-06-23)。 */
  subUsers: SubUserStore;
  conversations: ConversationStore;
  /** 文件夹存储:按项目+用户隔离的会话归类目录。 */
  folders: FolderStore;
  /** Claude/Codex 使用白名单(管理员配置)。 */
  agentAccess: AgentAccessStore;
  /** 跨会话索引层(SQLite)。给搜索/摘要/迁移/用量当统一中间层。 */
  sessionIndex: SessionIndex;
  /**
   * 按 agentKind 选适配器(claude/codex 各一份,进程内缓存复用)。
   * 任何要按 agent 类型分支的横切逻辑(transcript 定位、活动探测等)都该走这个入口,
   * 不要各处各写一份 `kind === 'codex' ? ... : ...` 或直接硬编码 claude 专属实现。
   */
  adapterFor: (kind: AgentKind) => AgentAdapter;
  /**
   * @deprecated 直接拿 ServiceUser 实例。新代码用 getTmux(unixUser) 按目标 unix 取实例。
   * 保留是为了渐进迁移期间下游 routes 不爆炸。
   */
  tmux: Tmux;
  /**
   * 按 unix 用户取(或新建)对应 Tmux 实例(lazy 缓存,socket 派生为 rcc-<unixUser>)。
   * 跨 unix 调用走 sudo -nH -u;同 ServiceUser 走零开销直 exec。
   */
  getTmux: (unixUser: string) => Tmux;
  registry: SessionRegistry;
  chatRegistry: ChatRegistry;
  research: ResearchProviderRegistry;
  /**
   * @deprecated ServiceUser 的 askLaunch。新代码用 askLaunchFor(unixUser) 按目标 unix 取。
   */
  askLaunch: { envExport: string; settingsArg: string };
  /** 按 unix 用户取 ask hook 注入参数(env + settings.json 路径都按子目录隔离)。 */
  askLaunchFor: (unixUser: string) => { envExport: string; settingsArg: string };
}

/**
 * ChatSession.tick() 的 running 判定给 codex(capabilities.paneRunningSignal=false)用的
 * 空闲阈值:codex 读屏 spinner/done 恒不命中,只能靠"有没有新 transcript 消息"续命,
 * 默认阈值(claude 用,8 tick≈2s)对 codex 太激进,一次思考/工具调用中间隔稍长没落盘
 * 新消息就会被误判"已完成"。放宽到 160 tick(≈40s @ 默认 250ms 轮询)。
 * claude 保持 undefined,走 ChatSession 自己的默认值(零行为变化)。
 */
export function idleLimitFor(adapter: Pick<AgentAdapter, 'capabilities'>): number | undefined {
  return adapter.capabilities.paneRunningSignal ? undefined : 160;
}

export async function buildContext(config: Config): Promise<AppContext> {
  const adminHash = config.adminPasswordHash
    ? config.adminPasswordHash
    : await argon2.hash(config.adminPassword as string);

  // 用户 + 子用户存储:相互引用做 username 全局唯一互查。
  // 因有双向引用,先建空壳,再回填(SubUserStore.users / UserStore.subUsers 都是 public 字段)。
  const subUsers = new SubUserStore(config.subUsersConfigPath);
  const users = new UserStore(config.usersConfigPath, subUsers);
  subUsers.users = users;

  if (users.count() === 0) {
    users.add({ username: config.adminUsername, passwordHash: adminHash, role: 'admin' });
  }
  // 多用户隔离:回填缺 unixUser 的存量用户为 serviceUser(默认行为零变化)。
  users.migrate(config.serviceUser);
  // 子用户存量数据可能缺 role 字段(2026-06-23 补丁前建的),回填 'user'。
  subUsers.migrate();

  // 存量项目缺 ownerId 的回填为 admin(多用户上线前的项目都归 admin)。
  const admin = users.findByUsername(config.adminUsername);
  const projects = new ProjectStore(config.projectsConfigPath);
  if (admin) projects.migrate(admin.id);

  const conversations = new ConversationStore(config.conversationsConfigPath);
  conversations.migrate();
  const folders = new FolderStore(config.foldersConfigPath, conversations);
  const agentAccess = new AgentAccessStore(config.agentAccessConfigPath);

  // 按 unix 用户的 Tmux 实例 lazy 缓存。socket 名 = config.tmuxSocket + '-' + unixUser
  // (跨用户 tmux server 各自一份,避免 socket 权限打架)。
  // ServiceUser 的实例仍用原 socket 名(向后兼容现有 tmux 会话/外部命名预期)。
  const tmuxCache = new Map<string, Tmux>();
  function getTmux(unixUser: string): Tmux {
    const cached = tmuxCache.get(unixUser);
    if (cached) return cached;
    const socket =
      unixUser === config.serviceUser ? config.tmuxSocket : `${config.tmuxSocket}-${unixUser}`;
    const t = new Tmux({ socket, unixUser, currentUser: config.serviceUser });
    tmuxCache.set(unixUser, t);
    return t;
  }
  const tmux = getTmux(config.serviceUser); // deprecated 别名,等价于 ServiceUser 实例

  // AskUserQuestion hook:按 unix 用户分子目录,每个 unixUser 一份独立 settings.json
  // (hook 进程跑在目标 uid 下,settings.json 路径必须该 uid 可读;独立子目录避免互写)。
  //
  // 多用户隔离 2026-06-24:这些子目录是 ServiceUser 进程创建的(owner=ServiceUser),
  // 但 hook 跑在目标 unixUser 下,要往里写 sidecar(<dir>/<sid>.json)——
  // 默认 755 跨用户写不进,所以 ensureWritableForAll 把目录 chmod 1777(粘 sticky bit
  // 防互删,others 可读写;sidecar 内容不敏感,可接受这个开放性)。
  // 文件本身的写入(ensureAskHookSettings 写 settings.json、hook 进程写 sidecar)
  // 各自的 owner 保持 default umask(644),互不踩。
  function ensureWritableForAll(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o1777);
    } catch {
      /* 已存在 / 已是该权限 / 其他 cluster 共享盘 noperm:忽略,真不可写时 hook 写失败由 HUD 退化 */
    }
  }

  const askHookScriptPath = path.join(config.repoRoot, 'apps/server/scripts/hooks/rcc-ask-hook.mjs');
  const askLaunchCache = new Map<string, { envExport: string; settingsArg: string }>();
  function askLaunchFor(unixUser: string) {
    const cached = askLaunchCache.get(unixUser);
    if (cached) return cached;
    const userAskDir = path.join(config.askDir, unixUser);
    const userSettingsPath = path.join(userAskDir, 'ask-hooks.settings.json');
    ensureAskHookSettings({
      askDir: userAskDir,
      hookScriptPath: askHookScriptPath,
      settingsPath: userSettingsPath,
    });
    // 子目录与父 askDir 都需要 1777:子目录用于该 unixUser 的 hook 写 sidecar;
    // 父目录给其他 unixUser 自己 mkdir 子目录用(若先用了别人的 unixUser 触发 askLaunchFor)。
    ensureWritableForAll(config.askDir);
    ensureWritableForAll(userAskDir);
    const launch = askLaunchExtra(userAskDir, userSettingsPath);
    askLaunchCache.set(unixUser, launch);
    return launch;
  }
  const askLaunch = askLaunchFor(config.serviceUser); // deprecated 别名

  // 同 ask:statuslineDir 也按 unixUser 分子目录 + 开放写权限。
  // 如果用户装了 setup-statusline,statusLine hook 跑在自己 uid 下,要往这里写 sidecar。
  // 没装也无影响(HUD 退化到 transcript 兜底)。
  const statuslineCache = new Map<string, string>();
  function statuslineDirFor(unixUser: string): string {
    const cached = statuslineCache.get(unixUser);
    if (cached) return cached;
    const dir = path.join(config.statuslineDir, unixUser);
    ensureWritableForAll(config.statuslineDir);
    ensureWritableForAll(dir);
    statuslineCache.set(unixUser, dir);
    return dir;
  }

  // 两个 agent 适配器各创建一次缓存复用(无 per-session 状态,工厂内按 agentKind 选其一)。
  // claude 全能力开、命令输出与既有 buildClaudeCmd 一字不差,故 claude 路径行为零变化;
  // codex capabilities 全 false,横切 deps(hud/askHook)都不会注入(见工厂内 capability 判定)。
  const claudeAdapter = makeClaudeAdapter(config.serviceUser);
  const codexAdapter = makeCodexAdapter({
    serviceUser: config.serviceUser,
    // 给 unix 用户名 → HOME:ServiceUser 用进程 HOME,其余按 /home/<user> 约定
    // (与 projectsDirFor 的跨用户 home 解析同源)。
    homeFor: (u: string) => (u === config.serviceUser ? os.homedir() : `/home/${u}`),
  });
  /** 单一入口:按 agentKind 选适配器。下面 SessionIndex/chatRegistry/返回值统一用它,
   * 避免 `kind === 'codex' ? ... : ...` 三处各写一份、以后加第三种 agent 容易漏改。 */
  const adapterFor = (kind: AgentKind): AgentAdapter => (kind === 'codex' ? codexAdapter : claudeAdapter);

  // SessionIndex:跨会话索引 + 全文搜索。注入 conversations/projects/adapters,
  // 启动时 sweep 所有已登记会话;chatSession 跑期间 inline 推送新消息;每 60s mtime 校对兜底。
  // 不索引"孤儿"transcript(MVP) — namespaceId 100% 由 Project.ownerId 决定。
  const resolveUnixUserForIndex = makeResolveUnixUser(users, subUsers, config.serviceUser);
  const sessionIndex = new SessionIndex({
    dbPath: config.sessionIndexDbPath,
    conversations: {
      listAll: () =>
        conversations.listAll().map((c) => ({
          id: c.id,
          projectId: c.projectId,
          name: c.name,
          sessionId: c.sessionId,
          agentKind: c.agentKind,
          starred: c.starred,
          createdAt: c.createdAt,
          lastActivityAt: c.lastActivityAt,
          closedAt: c.closedAt,
          deletedAt: c.deletedAt,
          folderId: c.folderId ?? null,
        })),
    },
    projects: {
      get: (id) => {
        const p = projects.get(id);
        return p ? { id: p.id, ownerId: p.ownerId, path: p.path } : undefined;
      },
    },
    adapterFor,
    resolveUnixUser: resolveUnixUserForIndex,
    readText: (p) => readFileSync(p, 'utf8'),
    statFile: (p) => {
      try {
        const s = statSync(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    },
  });

  const chatRegistry = new ChatRegistry((spec, events) => {
    // 多用户:每个 spec 带 unixUser(老 spec 缺则回退 ServiceUser,过渡兼容)。
    const effectiveUnixUser = spec.unixUser ?? config.serviceUser;
    const perUserTmux = getTmux(effectiveUnixUser);
    // 按会话 agentKind 选适配器:transcript 定位/tail、启动命令、capabilities 全随之而变。
    const adapter = adapterFor(spec.agentKind);
    // tail / hasTranscript 都委托给 adapter:claude 扫 ~/.claude/projects/*,
    // codex 扫 ~/.codex/sessions/YYYY/MM/DD/*,context 不再手动 new TranscriptTail。
    const tail = adapter.makeTranscriptTail(spec.sessionId, effectiveUnixUser, spec.cwd);
    return new ChatSession(
      spec,
      {
        tmux: perUserTmux,
        scrape: scrapePane,
        idleLimit: idleLimitFor(adapter),
        tail,
        adapter,
        // transcript 必须能由 adapter 在当前 cwd 下定位到。codexSessionDiscovered 只表示曾经
        // 回写过真实 UUID,不能作为 resume 充分条件,否则串过一次的 UUID 会继续读别的 cwd。
        hasTranscript: () =>
          adapter.locateTranscript(spec.sessionId, effectiveUnixUser, spec.cwd) !== null,
        // claude 专属横切:按 capability 决定是否注入。codex(capabilities 全 false)
        // 一律传 undefined,等价于既有"未配 hook/sidecar"的安全路径,chatSession 自然跳过。
        // ── HUD 用量(statusLine sidecar)──
        ...(adapter.capabilities.hud
          ? {
              // 走 statuslineDirFor 触发 ensureWritableForAll,保证子目录 1777
              // (跨 unix hook 进程能写 sidecar,后端再读出 HUD 数据)。
              statuslineDir: statuslineDirFor(effectiveUnixUser),
              readSidecar: (p: string) => {
                const content = readFileSync(p, 'utf8');
                const { mtimeMs } = statSync(p);
                return { content, mtimeMs };
              },
            }
          : {}),
        // ── AskUserQuestion hook ──
        ...(adapter.capabilities.askHook
          ? {
              askDir: path.join(config.askDir, effectiveUnixUser),
              askLaunch: askLaunchFor(effectiveUnixUser),
              readAskSidecar: readPendingAsk,
              cleanAskSidecar: (dir: string, sessionId: string) => {
                try {
                  unlinkSync(askSidecarPath(dir, sessionId));
                } catch {
                  /* 文件不存在是常态:不打日志 */
                }
              },
            }
          : {}),
        // ── SessionIndex 钩子:每条新主线消息 inline 推送到索引 db ──
        sessionIndex: { onMessage: (k, m) => sessionIndex.onMessage(k, m) },
      },
      events,
    );
  });
  const research = new ResearchProviderRegistry();

  // 启动时预热:对所有已知 unixUser(主账号 + 子用户继承的 parent unixUser)触发
  // askLaunchFor 与 statuslineDirFor,确保每条用户路径的子目录权限(1777)在启动后立刻齐备,
  // 不必等到该用户首次登录 + 用 chat 时才修复(那时反而是 zhangrengang 写 sidecar 失败、HUD 退化的窗口期)。
  const allUnixUsers = new Set<string>([config.serviceUser]);
  for (const u of users.load()) if (u.unixUser) allUnixUsers.add(u.unixUser);
  for (const s of subUsers.load()) {
    const parent = users.get(s.parentId);
    if (parent?.unixUser) allUnixUsers.add(parent.unixUser);
  }
  for (const u of allUnixUsers) {
    askLaunchFor(u);
    statuslineDirFor(u);
  }

  return {
    config,
    adminHash,
    projects,
    users,
    subUsers,
    conversations,
    folders,
    agentAccess,
    sessionIndex,
    adapterFor,
    tmux,
    getTmux,
    // 多用户隔离 2026-06-24:终端 SessionRegistry 不再 baked-in ServiceUser 的 Tmux,
    // 改成接 getTmux 工厂 + serviceUser,subscribe 时按 spec.unixUser 取对应 socket
    // (跨 user 时 pty.spawn 走 sudo 前缀;同 ServiceUser 零开销直 spawn 'tmux')。
    registry: new SessionRegistry(makeRealBridgeFactory(getTmux, config.serviceUser)),
    chatRegistry,
    research,
    askLaunch,
    askLaunchFor,
  };
}
