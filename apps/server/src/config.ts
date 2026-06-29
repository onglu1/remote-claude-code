import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4400),
  HOST: z.string().default('127.0.0.1'),
  /** 首次启动播种的超级管理员用户名（之后 users.json 即唯一来源）。 */
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  SESSION_SECRET: z.string().min(8, 'SESSION_SECRET 必须设置且至少 8 位'),
  TOKEN_TTL_HOURS: z.coerce.number().default(12),
  PUBLIC_ORIGIN: z.string().default(''),
  TRUST_CLOUDFLARE: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  TMUX_SOCKET: z.string().default('rcc'),
  PROJECTS_CONFIG: z.string().default('config/projects.json'),
  /** 添加项目时目录选择器的浏览根。默认用户 HOME；生产请显式设置到承载项目代码的目录。 */
  FS_BROWSE_ROOT: z.string().default(os.homedir()),
  /** statusLine 捕获器落 sidecar 的目录（聊天 HUD 独立数据源）。默认 <repoRoot>/data/rcc-statusline。 */
  RCC_STATUSLINE_DIR: z.string().default(''),
  /** AskUserQuestion hook 落 sidecar 的目录（聊天选择题真值源）。默认 <repoRoot>/data/rcc-ask。 */
  RCC_ASK_DIR: z.string().default(''),
  /** 服务运行的 unix 用户名(供 runAs 零开销判断)。默认 = os.userInfo().username。 */
  RCC_SERVICE_USER: z.string().default(''),
  /** claude 二进制路径(写进 sudoers 白名单时也用)。默认 'claude' 由 PATH 解析。 */
  RCC_CLAUDE_BINARY: z.string().default('claude'),
  /** 可选:VSCode Web iframe URL 模板。例: http://127.0.0.1:8080/?folder={path} */
  RCC_VSCODE_URL_TEMPLATE: z.string().default(''),
  /** 可选:把 /vscode/* 同源反代到这个内部 VSCode Web 地址。例: http://127.0.0.1:8080 */
  RCC_VSCODE_PROXY_TARGET: z.string().default(''),
  /** VSCode Web 同源代理挂载路径。 */
  RCC_VSCODE_PROXY_PREFIX: z.string().default('/vscode'),
  /** 可选:remote-cc 启动时顺手拉起的 VSCode Web 命令。例: code-server --auth none --bind-addr 127.0.0.1:8080 */
  RCC_VSCODE_COMMAND: z.string().default(''),
});

export type Config = {
  port: number;
  host: string;
  adminUsername: string;
  adminPassword?: string;
  adminPasswordHash?: string;
  sessionSecret: string;
  tokenTtlMs: number;
  publicOrigin: string;
  trustCloudflare: boolean;
  tmuxSocket: string;
  projectsConfigPath: string;
  conversationsConfigPath: string;
  /** 会话文件夹 JSON 存储路径(与 conversations.json 同目录)。 */
  foldersConfigPath: string;
  /** agent 使用白名单 JSON 存储路径(与 projects.json 同目录)。 */
  agentAccessConfigPath: string;
  /** SessionIndex sqlite 文件路径(与 conversations.json 同目录)。 */
  sessionIndexDbPath: string;
  usersConfigPath: string;
  fsBrowseRoot: string;
  /** statusLine sidecar 目录的绝对路径（聊天 HUD 独立数据源）。 */
  statuslineDir: string;
  /** AskUserQuestion hook sidecar 目录的绝对路径（聊天选择题真值源）。 */
  askDir: string;
  /** 子用户存储 JSON 路径(与 users.json 同目录)。多用户隔离设计 2026-06-23。 */
  subUsersConfigPath: string;
  /** 服务运行的 unix 用户名;= RCC_SERVICE_USER 或 os.userInfo().username。 */
  serviceUser: string;
  /** claude 二进制(绝对路径或 PATH 可找到);跨 unix 时配合 sudoers 白名单。 */
  claudeBinary: string;
  /** VSCode Web iframe URL 模板。支持 {path}/{pathRaw}/{id}/{name}。 */
  vscodeUrlTemplate: string;
  /** VSCode Web 内部反代目标。配置后 iframe 默认走同源 /vscode/。 */
  vscodeProxyTarget: string;
  /** VSCode Web 同源代理路径前缀。 */
  vscodeProxyPrefix: string;
  /** remote-cc 启动时可选拉起的 VSCode Web 命令。 */
  vscodeCommand: string;
  /** per-unix-user 浏览根:RCC_FS_BROWSE_ROOT_<UNIXUSER> env 解析;缺省回退 ~<user>/projects。 */
  fsBrowseRootMap: Record<string, string>;
  repoRoot: string;
  webDist: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  if (!parsed.ADMIN_PASSWORD && !parsed.ADMIN_PASSWORD_HASH) {
    throw new Error('必须设置 ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH');
  }
  // 仓库根：本文件在 apps/server/src，向上三级
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
  const projectsConfigPath = resolve(parsed.PROJECTS_CONFIG);
  const fsBrowseRootMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('RCC_FS_BROWSE_ROOT_') && typeof v === 'string' && v) {
      fsBrowseRootMap[k.slice('RCC_FS_BROWSE_ROOT_'.length)] = v;
    }
  }
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD,
    adminPasswordHash: parsed.ADMIN_PASSWORD_HASH,
    sessionSecret: parsed.SESSION_SECRET,
    tokenTtlMs: parsed.TOKEN_TTL_HOURS * 3600_000,
    publicOrigin: parsed.PUBLIC_ORIGIN,
    trustCloudflare: parsed.TRUST_CLOUDFLARE ?? false,
    tmuxSocket: parsed.TMUX_SOCKET,
    projectsConfigPath,
    conversationsConfigPath: path.join(path.dirname(projectsConfigPath), 'conversations.json'),
    foldersConfigPath: path.join(path.dirname(projectsConfigPath), 'folders.json'),
    agentAccessConfigPath: path.join(path.dirname(projectsConfigPath), 'agent-access.json'),
    sessionIndexDbPath: path.join(path.dirname(projectsConfigPath), 'sessionIndex.db'),
    usersConfigPath: path.join(path.dirname(projectsConfigPath), 'users.json'),
    fsBrowseRoot: parsed.FS_BROWSE_ROOT,
    statuslineDir: parsed.RCC_STATUSLINE_DIR
      ? resolve(parsed.RCC_STATUSLINE_DIR)
      : path.join(repoRoot, 'data', 'rcc-statusline'),
    askDir: parsed.RCC_ASK_DIR ? resolve(parsed.RCC_ASK_DIR) : path.join(repoRoot, 'data', 'rcc-ask'),
    subUsersConfigPath: path.join(path.dirname(projectsConfigPath), 'subusers.json'),
    serviceUser: parsed.RCC_SERVICE_USER || os.userInfo().username,
    claudeBinary: parsed.RCC_CLAUDE_BINARY,
    vscodeUrlTemplate: parsed.RCC_VSCODE_URL_TEMPLATE,
    vscodeProxyTarget: parsed.RCC_VSCODE_PROXY_TARGET,
    vscodeProxyPrefix: parsed.RCC_VSCODE_PROXY_PREFIX.startsWith('/')
      ? parsed.RCC_VSCODE_PROXY_PREFIX.replace(/\/+$/, '') || '/vscode'
      : `/${parsed.RCC_VSCODE_PROXY_PREFIX}`.replace(/\/+$/, ''),
    vscodeCommand: parsed.RCC_VSCODE_COMMAND,
    fsBrowseRootMap,
    repoRoot,
    webDist: path.join(repoRoot, 'apps/web/dist'),
  };
}
