#!/usr/bin/env node
/**
 * remote-cc 的 AskUserQuestion 捕获 hook。由 claude 经 --settings 注册：
 *   PreToolUse(matcher=AskUserQuestion)  → `node rcc-ask-hook.mjs pre`
 *   PostToolUse(matcher=AskUserQuestion) → `node rcc-ask-hook.mjs post`
 *
 * pre：把工具输入(questions)原子写到 $RCC_ASK_DIR/<session_id>.json，
 *      供服务端聊天会话实时检测待答选择题并渲染富卡片（真值，免读屏）。
 * post：作答完成（任意来源），删除该 sidecar，服务端据此清卡。
 *
 * 约束：脚本会短暂阻塞工具执行，故必须极快、且**绝不抛出**（任何异常吞掉 exit 0）；
 * RCC_ASK_DIR 未设时空操作——即便被非 remote-cc 会话误触发也无害。
 */
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const phase = process.argv[2];
const dir = process.env.RCC_ASK_DIR;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  // 先把 stdin 读干净，避免子进程提前退出导致父进程写管道 EPIPE。
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    /* ignore */
  }
  try {
    if (!dir) return; // 未配置目录 → 空操作
    const payload = JSON.parse(raw);
    const sid = payload?.session_id;
    if (!sid || typeof sid !== 'string') return;
    const file = join(dir, `${sid}.json`);
    if (phase === 'post') {
      rmSync(file, { force: true });
      return;
    }
    // pre：空题不落盘（无意义）；否则原子写（tmp + rename），避免服务端读到半截。
    const questions = payload?.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return;
    mkdirSync(dir, { recursive: true });
    const out = JSON.stringify({ toolUseId: payload?.tool_use_id ?? '', questions, ts: Date.now() });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch {
    /* 绝不阻断工具：吞掉一切 */
  } finally {
    process.exit(0);
  }
})();
