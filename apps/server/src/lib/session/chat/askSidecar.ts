/**
 * 读取 hook 脚本(rcc-ask-hook.mjs)落的待答 sidecar，并映射成协议 AskPending。
 * 纯函数 + 一次性同步 IO，便于临时目录单测。待答期 transcript 拿不到 tool_use，
 * 故 sidecar 是聊天会话检测「选择题待答」的真值源（免读屏）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AskPending } from '@rcc/shared';

/** hook 负载里的一个选项（label + 可选说明）。 */
export interface AskHookOption {
  label: string;
  description?: string;
}
/** hook 负载里的一题。 */
export interface AskHookQuestion {
  question: string;
  header?: string;
  options: AskHookOption[];
  multiSelect: boolean;
}
/** sidecar 文件内容（rcc-ask-hook.mjs pre 写）。 */
export interface AskHookPending {
  toolUseId: string;
  questions: AskHookQuestion[];
  ts: number;
}

/** sidecar 路径：<dir>/<sessionId>.json。 */
export function askSidecarPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.json`);
}

/** 读 sidecar；缺失/坏 JSON/结构非法 → null。 */
export function readPendingAsk(dir: string, sessionId: string): AskHookPending | null {
  let raw: string;
  try {
    raw = readFileSync(askSidecarPath(dir, sessionId), 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as AskHookPending;
    if (!o || !Array.isArray(o.questions)) return null;
    return o;
  } catch {
    return null;
  }
}

/** 把 hook 负载的第 qIndex 题映射为协议 AskPending（含 description/question/header/多问题进度）。 */
export function toAskPending(p: AskHookPending, qIndex: number): AskPending {
  const q = p.questions[qIndex];
  const out: AskPending = {
    options: q.options.map((o, i) => ({
      index: i,
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
    })),
    multiSelect: q.multiSelect,
    question: q.question,
    qIndex,
    qTotal: p.questions.length,
  };
  if (q.header !== undefined) out.header = q.header;
  return out;
}
