import { readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import argon2 from 'argon2';
import type { Config } from './config';
import { ProjectStore } from './lib/projects';
import { UserStore } from './lib/users';
import { ConversationStore } from './lib/conversations';
import { FolderStore } from './lib/folders';
import { Tmux } from './lib/session/tmux';
import { SessionRegistry } from './lib/session/registry';
import { makeRealBridgeFactory } from './lib/session/ptyBridge';
import { ChatRegistry } from './lib/session/chat/chatRegistry';
import { ChatSession } from './lib/session/chat/chatSession';
import { scrapePane } from './lib/session/chat/paneScraper';
import { TranscriptTail, locateTranscript } from './lib/session/chat/transcript';
import { ensureAskHookSettings, askLaunchExtra } from './lib/session/chat/askHookSettings';
import { readPendingAsk, askSidecarPath } from './lib/session/chat/askSidecar';
import { ResearchProviderRegistry } from './lib/researchProvider';

/** 运行期共享上下文，注入到各 route。 */
export interface AppContext {
  config: Config;
  adminHash: string;
  projects: ProjectStore;
  users: UserStore;
  conversations: ConversationStore;
  /** 文件夹存储:按项目+用户隔离的会话归类目录。 */
  folders: FolderStore;
  tmux: Tmux;
  registry: SessionRegistry;
  chatRegistry: ChatRegistry;
  research: ResearchProviderRegistry;
  /** AskUserQuestion hook 注入(env 导出 RCC_ASK_DIR + --settings 叠加);reflow 路由重启 claude 也要带上。 */
  askLaunch: { envExport: string; settingsArg: string };
}

export async function buildContext(config: Config): Promise<AppContext> {
  const adminHash = config.adminPasswordHash
    ? config.adminPasswordHash
    : await argon2.hash(config.adminPassword as string);

  // 用户存储：首次启动若为空，用 env 口令播种一个超级管理员（之后 users.json 即唯一来源）。
  const users = new UserStore(config.usersConfigPath);
  if (users.count() === 0) {
    users.add({ username: config.adminUsername, passwordHash: adminHash, role: 'admin' });
  }
  // 存量项目缺 ownerId 的回填为 admin（多用户上线前的项目都归 admin）。
  const admin = users.findByUsername(config.adminUsername);
  const projects = new ProjectStore(config.projectsConfigPath);
  if (admin) projects.migrate(admin.id);

  const tmux = new Tmux(config.tmuxSocket);
  const conversations = new ConversationStore(config.conversationsConfigPath);
  conversations.migrate(); // 给旧版无 sessionId 的会话补全
  const folders = new FolderStore(config.foldersConfigPath, conversations);

  // AskUserQuestion hook（聊天选择题真值源）：幂等装配 settings（含绝对脚本路径）+ 建 askDir，
  // 启动 claude 时经 --settings 叠加注入、env 导出 RCC_ASK_DIR。仅对 remote-cc 拉起的会话生效。
  const askHookScriptPath = path.join(config.repoRoot, 'apps/server/scripts/hooks/rcc-ask-hook.mjs');
  const askSettingsPath = path.join(config.askDir, 'ask-hooks.settings.json');
  ensureAskHookSettings({ askDir: config.askDir, hookScriptPath: askHookScriptPath, settingsPath: askSettingsPath });
  const askLaunch = askLaunchExtra(config.askDir, askSettingsPath);

  const chatRegistry = new ChatRegistry((spec, events) => {
    const tail = new TranscriptTail(() => locateTranscript(spec.sessionId));
    return new ChatSession(
      spec,
      {
        tmux,
        scrape: scrapePane,
        tail,
        hasTranscript: () => locateTranscript(spec.sessionId) !== null,
        // 聊天 HUD 独立数据源：从 statusLine 捕获器落的 sidecar 读完整 HUD（含 5h/周用量）。
        statuslineDir: config.statuslineDir,
        readSidecar: (path: string) => {
          const content = readFileSync(path, 'utf8');
          const { mtimeMs } = statSync(path);
          return { content, mtimeMs };
        },
        // 选择题 hook 真值路径：检测/取选项/作答全走 hook，读屏降级兜底。
        askDir: config.askDir,
        askLaunch,
        readAskSidecar: readPendingAsk,
        // ensure 时清掉残留 sidecar(上次崩溃/中断的 PreToolUse 没被 PostToolUse 配对清掉)。
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
    conversations,
    folders,
    tmux,
    registry: new SessionRegistry(makeRealBridgeFactory(tmux)),
    chatRegistry,
    research,
    askLaunch,
  };
}
