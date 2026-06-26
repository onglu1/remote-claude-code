import fs from 'node:fs';
import path from 'node:path';
import {
  AgentAccessConfigSchema,
  type AgentAccessConfig,
  type AgentKind,
  type AuthUser,
} from '@rcc/shared';

export const DEFAULT_AGENT_ACCESS: AgentAccessConfig = {
  claude: { enabled: false, allowedPrincipalIds: [] },
  codex: { enabled: false, allowedPrincipalIds: [] },
};

/** 纯函数:enabled=false 不限制;enabled=true 时只允许显式列出的主账号/子用户 id。 */
export function canUseAgent(
  config: AgentAccessConfig,
  user: Pick<AuthUser, 'id'>,
  agentKind: AgentKind,
): boolean {
  const rule = config[agentKind];
  if (!rule.enabled) return true;
  return rule.allowedPrincipalIds.includes(user.id);
}

/**
 * Agent 白名单存储(config/agent-access.json)。
 * 与 users/projects 同风格:JSON 私本 + 原子写 + 写前备份。
 */
export class AgentAccessStore {
  constructor(private readonly file: string) {}

  load(): AgentAccessConfig {
    if (!fs.existsSync(this.file)) return DEFAULT_AGENT_ACCESS;
    const raw = fs.readFileSync(this.file, 'utf8').trim();
    if (!raw) return DEFAULT_AGENT_ACCESS;
    return AgentAccessConfigSchema.parse(JSON.parse(raw));
  }

  save(next: AgentAccessConfig): AgentAccessConfig {
    const parsed = AgentAccessConfigSchema.parse(next);
    this.write(parsed);
    return parsed;
  }

  canUse(user: Pick<AuthUser, 'id'>, agentKind: AgentKind): boolean {
    return canUseAgent(this.load(), user, agentKind);
  }

  private write(config: AgentAccessConfig): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }
}
