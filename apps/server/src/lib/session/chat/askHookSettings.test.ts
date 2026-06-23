import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAskHookSettings, ensureAskHookSettings, askLaunchExtra } from './askHookSettings';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rcc-hooksettings-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('buildAskHookSettings', () => {
  it('注册 AskUserQuestion 的 Pre/PostToolUse，命令含绝对脚本路径', () => {
    const s = buildAskHookSettings('/abs/hooks/rcc-ask-hook.mjs') as any;
    expect(s.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain('/abs/hooks/rcc-ask-hook.mjs');
    expect(s.hooks.PreToolUse[0].hooks[0].command).toMatch(/ pre$/);
    expect(s.hooks.PostToolUse[0].matcher).toBe('AskUserQuestion');
    expect(s.hooks.PostToolUse[0].hooks[0].command).toMatch(/ post$/);
  });
});

describe('ensureAskHookSettings', () => {
  it('幂等写出可解析 JSON，含绝对 hook 路径，并建 askDir', () => {
    const askDir = join(base, 'ask');
    const settingsPath = join(base, 'cfg', 'ask-hooks.settings.json');
    ensureAskHookSettings({ askDir, hookScriptPath: '/abs/hook.mjs', settingsPath });
    expect(existsSync(askDir)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toContain('/abs/hook.mjs');
    // 幂等：再次调用不抛、内容不变
    const before = readFileSync(settingsPath, 'utf8');
    ensureAskHookSettings({ askDir, hookScriptPath: '/abs/hook.mjs', settingsPath });
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});

describe('askLaunchExtra', () => {
  it('拼 export RCC_ASK_DIR 与 --settings，含 shell 引号', () => {
    const { envExport, settingsArg } = askLaunchExtra('/home/u/.claude/rcc-ask', '/home/u/.claude/rcc-ask/s.json');
    expect(envExport).toBe("export RCC_ASK_DIR='/home/u/.claude/rcc-ask'; ");
    expect(settingsArg).toBe("--settings '/home/u/.claude/rcc-ask/s.json'");
  });
  it('路径含单引号也安全转义', () => {
    const { envExport } = askLaunchExtra("/tmp/it's", '/tmp/x');
    expect(envExport).toContain("'/tmp/it'\\''s'");
  });
});
