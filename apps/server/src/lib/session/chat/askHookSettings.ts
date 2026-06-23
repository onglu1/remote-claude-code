/**
 * 装配「注入给 claude 的 ask hook」：生成只含 AskUserQuestion Pre/PostToolUse 的 settings，
 * 经 `--settings <文件>` 叠加注入（不污染用户全局 ~/.claude/settings.json），并拼 launch 注入串。
 * matcher 精确匹配 → 对其它工具零开销、对 rewind/slash/权限菜单零误判。
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 构造 settings JSON 对象（命令用绝对脚本路径）。 */
export function buildAskHookSettings(hookScriptAbsPath: string): {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
} {
  const cmd = (phase: 'pre' | 'post') => `node "${hookScriptAbsPath}" ${phase}`;
  const entry = (phase: 'pre' | 'post') => [
    { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: cmd(phase) }] },
  ];
  return { hooks: { PreToolUse: entry('pre'), PostToolUse: entry('post') } };
}

/** 幂等：确保 askDir 与 settings 文件存在（内容相同则跳过写）。 */
export function ensureAskHookSettings(opts: {
  askDir: string;
  hookScriptPath: string;
  settingsPath: string;
}): void {
  mkdirSync(opts.askDir, { recursive: true });
  mkdirSync(dirname(opts.settingsPath), { recursive: true });
  const content = JSON.stringify(buildAskHookSettings(opts.hookScriptPath), null, 2);
  try {
    if (readFileSync(opts.settingsPath, 'utf8') === content) return;
  } catch {
    /* 文件不存在 → 继续写 */
  }
  writeFileSync(opts.settingsPath, content);
}

/** shell 单引号安全包裹。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 拼 launch 注入串：env 导出 + --settings 参数。 */
export function askLaunchExtra(askDir: string, settingsPath: string): { envExport: string; settingsArg: string } {
  return {
    envExport: `export RCC_ASK_DIR=${shQuote(askDir)}; `,
    settingsArg: `--settings ${shQuote(settingsPath)}`,
  };
}
