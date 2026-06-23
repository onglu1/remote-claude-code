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
  /** statusLine 捕获器落 sidecar 的目录（聊天 HUD 独立数据源）。默认 ~/.claude/rcc-statusline。 */
  RCC_STATUSLINE_DIR: z.string().default(''),
  /** AskUserQuestion hook 落 sidecar 的目录（聊天选择题真值源）。默认 ~/.claude/rcc-ask。 */
  RCC_ASK_DIR: z.string().default(''),
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
  usersConfigPath: string;
  fsBrowseRoot: string;
  /** statusLine sidecar 目录的绝对路径（聊天 HUD 独立数据源）。 */
  statuslineDir: string;
  /** AskUserQuestion hook sidecar 目录的绝对路径（聊天选择题真值源）。 */
  askDir: string;
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
    usersConfigPath: path.join(path.dirname(projectsConfigPath), 'users.json'),
    fsBrowseRoot: parsed.FS_BROWSE_ROOT,
    statuslineDir: parsed.RCC_STATUSLINE_DIR
      ? resolve(parsed.RCC_STATUSLINE_DIR)
      : path.join(os.homedir(), '.claude', 'rcc-statusline'),
    askDir: parsed.RCC_ASK_DIR ? resolve(parsed.RCC_ASK_DIR) : path.join(os.homedir(), '.claude', 'rcc-ask'),
    repoRoot,
    webDist: path.join(repoRoot, 'apps/web/dist'),
  };
}
