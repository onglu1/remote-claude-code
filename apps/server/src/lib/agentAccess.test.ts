import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentAccessStore, canUseAgent } from './agentAccess';

describe('canUseAgent', () => {
  it('未启用白名单时允许所有用户', () => {
    expect(
      canUseAgent(
        {
          claude: { enabled: false, allowedPrincipalIds: [] },
          codex: { enabled: false, allowedPrincipalIds: [] },
        },
        { id: 'u1' },
        'claude',
      ),
    ).toBe(true);
  });

  it('启用后只允许指定主体 id', () => {
    const cfg = {
      claude: { enabled: true, allowedPrincipalIds: ['u1'] },
      codex: { enabled: true, allowedPrincipalIds: [] },
    };
    expect(canUseAgent(cfg, { id: 'u1' }, 'claude')).toBe(true);
    expect(canUseAgent(cfg, { id: 'u2' }, 'claude')).toBe(false);
    expect(canUseAgent(cfg, { id: 'u1' }, 'codex')).toBe(false);
  });
});

describe('AgentAccessStore', () => {
  it('无文件时默认两个 agent 都不限制', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcc-agent-access-'));
    const store = new AgentAccessStore(join(dir, 'agent-access.json'));
    expect(store.load()).toEqual({
      claude: { enabled: false, allowedPrincipalIds: [] },
      codex: { enabled: false, allowedPrincipalIds: [] },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('save 后能持久化读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcc-agent-access-'));
    mkdirSync(dir, { recursive: true });
    const store = new AgentAccessStore(join(dir, 'agent-access.json'));
    store.save({
      claude: { enabled: true, allowedPrincipalIds: ['u1', 's1'] },
      codex: { enabled: false, allowedPrincipalIds: [] },
    });
    expect(store.load().claude.allowedPrincipalIds).toEqual(['u1', 's1']);
    expect(store.canUse({ id: 's1' }, 'claude')).toBe(true);
    expect(store.canUse({ id: 's2' }, 'claude')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
