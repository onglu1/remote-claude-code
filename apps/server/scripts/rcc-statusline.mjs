#!/usr/bin/env node
/**
 * remote-cc statusLine 捕获器。Claude Code 每次刷新状态栏时，把一份 JSON 经 stdin 喂给
 * statusLine 命令（claude-hud 只是个把它格式化成一行字的下游）。本脚本做两件事：
 *
 *   1. 把这份 raw JSON 按 sessionId 原子写到 sidecar 文件，供 remote-cc 聊天会话读取完整 HUD
 *      数据（含 5h/周用量、原生 context%——磁盘/transcript 都没有）。
 *   2. 链式调用下游：若存在 ${RCC_STATUSLINE_DIR}/downstream.sh（保存的原 statusLine 命令，
 *      通常是 claude-hud），用 bash 执行它、把 raw 灌它 stdin、stdout/退出码透传——终端状态栏
 *      原样不变。无下游则自渲染一行兜底（让没装 claude-hud 的终端也有 HUD）。
 *
 * 纯 Node builtin、极度防御：任何异常都吞掉，绝不能让用户所有 claude 会话的状态栏报错。
 * 写文件失败也要尽量执行下游；全失败就打印空行 exit 0。
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function defaultDir() {
  return join(homedir(), '.claude', 'rcc-statusline');
}

/** 读全部 stdin 为字符串（同步，statusLine 输入很小）。失败 → 空串。 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** 从 raw JSON 取 sessionId：优先 transcript_path 的 basename 去 .jsonl，否则 session_id 字段。 */
function extractSessionId(raw) {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      if (typeof o.transcript_path === 'string' && o.transcript_path) {
        const b = basename(o.transcript_path);
        if (b.endsWith('.jsonl')) return b.slice(0, -'.jsonl'.length);
      }
      if (typeof o.session_id === 'string' && o.session_id) return o.session_id;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 原子写 sidecar：mkdir -p → 写 .<rand>.tmp → rename。任何失败吞掉返回 false。 */
function writeSidecar(dir, sessionId, raw) {
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${sessionId}.json`);
    const tmp = join(dir, `.${sessionId}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, raw);
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** 链式执行下游 downstream.sh（灌 raw 到 stdin，stdout/退出码透传）。无下游 → false。 */
function runDownstream(dir, raw) {
  const downstream = join(dir, 'downstream.sh');
  if (!existsSync(downstream)) return false;
  try {
    const r = spawnSync('bash', [downstream], { input: raw, encoding: 'utf8' });
    if (typeof r.stdout === 'string') process.stdout.write(r.stdout);
    if (typeof r.stderr === 'string' && r.stderr) process.stderr.write(r.stderr);
    process.exit(typeof r.status === 'number' ? r.status : 0);
  } catch {
    /* 下游失败也不能崩；落到自渲染兜底 */
    return false;
  }
  return true;
}

/** 自渲染一行兜底（无下游时）：[model:win] ctx N% | 5h N% | wk N%。 */
function renderFallback(raw) {
  try {
    const o = JSON.parse(raw);
    const parts = [];
    const model = o?.model?.display_name || o?.model?.id;
    const cw = o?.context_window;
    const win = cw?.context_window_size >= 1_000_000 ? '1m' : cw?.context_window_size === 200_000 ? '200k' : null;
    if (model) parts.push(`[${model}${win ? `:${win}` : ''}]`);
    if (typeof cw?.used_percentage === 'number') parts.push(`ctx ${Math.round(cw.used_percentage)}%`);
    const f = o?.rate_limits?.five_hour?.used_percentage;
    if (typeof f === 'number') parts.push(`5h ${Math.round(f)}%`);
    const w = o?.rate_limits?.seven_day?.used_percentage;
    if (typeof w === 'number') parts.push(`wk ${Math.round(w)}%`);
    return parts.join(' | ');
  } catch {
    return '';
  }
}

function main() {
  const dir = process.env.RCC_STATUSLINE_DIR || defaultDir();
  const raw = readStdin();

  // 1) 落 sidecar（失败也继续，不影响下游/终端）。
  const sessionId = extractSessionId(raw);
  if (sessionId) writeSidecar(dir, sessionId, raw);

  // 2) 下游链式（claude-hud 原样）；无下游则自渲染兜底。
  if (runDownstream(dir, raw)) return; // runDownstream 成功会 process.exit
  process.stdout.write(`${renderFallback(raw)}\n`);
  process.exit(0);
}

try {
  main();
} catch {
  // 兜底中的兜底：绝不抛错破坏 TUI。
  try {
    process.stdout.write('\n');
  } catch {
    /* ignore */
  }
  process.exit(0);
}
