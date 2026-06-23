import { readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import type { Config } from './config';
import { ProjectStore } from './lib/projects';
import { UserStore } from './lib/users';
import { SubUserStore } from './lib/subUsers';
import { ConversationStore } from './lib/conversations';
import { FolderStore } from './lib/folders';
import { Tmux } from './lib/session/tmux';
import { SessionRegistry } from './lib/session/registry';
import { makeRealBridgeFactory } from './lib/session/ptyBridge';
import { ChatRegistry } from './lib/session/chat/chatRegistry';
import { ChatSession } from './lib/session/chat/chatSession';
import { scrapePane } from './lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript, projectsDirFor } from './lib/session/chat/transcript';
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
    const launch = askLaunchExtra(userAskDir, userSettingsPath);
    askLaunchCache.set(unixUser, launch);
    return launch;
  }
  const askLaunch = askLaunchFor(config.serviceUser); // deprecated 别名

  const chatRegistry = new ChatRegistry((spec, events) => {
    // 多用户:每个 spec 带 unixUser(老 spec 缺则回退 ServiceUser,过渡兼容)。
    const effectiveUnixUser = (spec as { unixUser?: string }).unixUser ?? config.serviceUser;
    const perUserTmux = getTmux(effectiveUnixUser);
    const perUserAskLaunch = askLaunchFor(effectiveUnixUser);
    const userAskDir = path.join(config.askDir, effectiveUnixUser);
    const userStatuslineDir = path.join(config.statuslineDir, effectiveUnixUser);
    // 多用户隔离:transcript 路径走目标 unix 用户 home,
    // 不走 ServiceUser home(否则 zhangrengang claude 写的 jsonl 永远找不到)。
    const projectsDir = projectsDirFor(effectiveUnixUser, config.serviceUser);
    const tail = new TranscriptTail(() => locateTranscript(spec.sessionId, projectsDir));
    return new ChatSession(
      spec,
      {
        tmux: perUserTmux,
        scrape: scrapePane,
        tail,
        hasTranscript: () => locateTranscript(spec.sessionId, projectsDir) !== null,
        statuslineDir: userStatuslineDir,
        readSidecar: (p: string) => {
          const content = readFileSync(p, 'utf8');
          const { mtimeMs } = statSync(p);
          return { content, mtimeMs };
        },
        askDir: userAskDir,
        askLaunch: perUserAskLaunch,
        readAskSidecar: readPendingAsk,
        cleanAskSidecar: (dir, sessionId) => {
          try {
            unlinkSync(askSidecarPath(dir, sessionId));
          } catch {
            /* 文件不存在是常态:不打日志 */
          }
        },
      },
      events,
    );
  });
  const research = new ResearchProviderRegistry();
  return {
    config,
    adminHash,
    projects,
    users,
    subUsers,
    conversations,
    folders,
    tmux,
    getTmux,
    registry: new SessionRegistry(makeRealBridgeFactory(tmux)),
    chatRegistry,
    research,
    askLaunch,
    askLaunchFor,
  };
}
