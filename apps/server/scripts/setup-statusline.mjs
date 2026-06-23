#!/usr/bin/env node
/**
 * 安装/卸载 remote-cc 的 statusLine 捕获器到 ~/.claude/settings.json。
 *
 * 安装（默认）：把现有 statusLine.command 原文存到 ${RCC_STATUSLINE_DIR}/downstream.sh
 * （避免内联引号地狱，下游用文件），再把 settings.statusLine 改为调用 rcc-statusline.mjs。
 * 这样 Claude Code 刷新状态栏时，stdin JSON 先经我们落 sidecar、再链式透传给原 claude-hud。
 *
 * 幂等：已指向我们的脚本则只补 downstream.sh、直接返回。
 * 首次会备份 settings.json.rcc-bak；--undo 从备份恢复。
 *
 * 用法：
 *   node setup-statusline.mjs          安装/确保（幂等）
 *   node setup-statusline.mjs --undo   还原（从 .rcc-bak 恢复）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'rcc-statusline.mjs');
const SETTINGS = join(homedir(), '.claude', 'settings.json');
const BAK = `${SETTINGS}.rcc-bak`;

function statuslineDir() {
  return process.env.RCC_STATUSLINE_DIR || join(homedir(), '.claude', 'rcc-statusline');
}

/** 我们注入的 command（绝对路径，带 RCC_STATUSLINE_DIR 前缀，保证子进程拿到同一目录）。 */
function ourCommand(dir) {
  return `RCC_STATUSLINE_DIR=${dir} node ${SCRIPT}`;
}

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    throw new Error(`无法解析 ${SETTINGS}（请检查 JSON 是否合法）：${e.message}`);
  }
}

/** 原子写 JSON（2 空格缩进），先 tmp 再 rename。 */
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 把字符串写成可执行 downstream.sh（带 shebang）。 */
function writeDownstream(dir, command) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'downstream.sh');
  // 直接 exec 用户原 command；stdin/stdout 由父进程（rcc 脚本）灌入/透传。
  writeFileSync(
    file,
    `#!/usr/bin/env bash\n# remote-cc 保存的原 statusLine 命令（由 setup-statusline.mjs 写入）。\n${command}\n`,
  );
  return file;
}

function isOurCommand(cmd) {
  return typeof cmd === 'string' && cmd.includes('rcc-statusline.mjs');
}

function install() {
  const dir = statuslineDir();
  const settings = readSettings();
  const current = settings.statusLine;
  const currentCmd = current && typeof current === 'object' ? current.command : undefined;

  // 幂等：已是我们的命令 → 只确保 downstream.sh 在（用户改过原 statusLine 时不覆盖已存的）。
  if (isOurCommand(currentCmd)) {
    if (!existsSync(join(dir, 'downstream.sh'))) {
      console.log('[setup] statusLine 已指向 rcc 脚本，但缺 downstream.sh；保持无下游（自渲染兜底）。');
    } else {
      console.log('[setup] 已安装（幂等 no-op）。');
    }
    return;
  }

  // 首次备份（仅当尚无备份）。
  if (existsSync(SETTINGS) && !existsSync(BAK)) {
    copyFileSync(SETTINGS, BAK);
    console.log(`[setup] 已备份 → ${BAK}`);
  }

  // 把现有 statusLine.command 存为下游（若有且非我们的）。
  if (typeof currentCmd === 'string' && currentCmd) {
    const f = writeDownstream(dir, currentCmd);
    console.log(`[setup] 原 statusLine 命令已存为下游 → ${f}`);
  } else {
    console.log('[setup] 未发现现有 statusLine 命令；无下游（自渲染一行兜底）。');
  }

  settings.statusLine = { type: 'command', command: ourCommand(dir) };
  writeJson(SETTINGS, settings);
  console.log(`[setup] 已写入 statusLine → ${ourCommand(dir)}`);
  console.log('[setup] 完成。重启正在运行的 claude 会话或等其下次刷新状态栏即生效。');
}

function undo() {
  if (!existsSync(BAK)) {
    console.log('[setup] 无备份可还原（未曾安装或备份已删）。');
    return;
  }
  copyFileSync(BAK, SETTINGS);
  console.log(`[setup] 已从 ${BAK} 还原 ${SETTINGS}。`);
  console.log('[setup] （downstream.sh/sidecar 目录保留，无害；如需可手动删除。）');
}

const arg = process.argv[2];
try {
  if (arg === '--undo') undo();
  else install();
} catch (e) {
  console.error(`[setup] 失败：${e.message}`);
  process.exit(1);
}
