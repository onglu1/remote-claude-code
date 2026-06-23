/**
 * 验证 hook 脚本 rcc-ask-hook.mjs：pre 写 sidecar、post 删 sidecar、RCC_ASK_DIR 未设则空操作。
 * 直接以子进程跑真实脚本（喂 stdin、设 env），断言落盘行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/hooks/rcc-ask-hook.mjs', import.meta.url));

const PAYLOAD = {
  session_id: 'sess-1',
  tool_use_id: 'toolu_1',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      { question: 'Pick a fruit', header: 'Fruit', options: [{ label: 'Apple', description: '苹果' }], multiSelect: false },
    ],
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rcc-askhook-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(phase: 'pre' | 'post', payload: unknown, withDir = true): void {
  const env = { ...process.env } as Record<string, string>;
  if (withDir) env.RCC_ASK_DIR = dir;
  else delete env.RCC_ASK_DIR;
  execFileSync('node', [SCRIPT, phase], { input: JSON.stringify(payload), env });
}

describe('rcc-ask-hook.mjs', () => {
  it('pre 写 sidecar：含 toolUseId/questions/ts', () => {
    run('pre', PAYLOAD);
    const file = join(dir, 'sess-1.json');
    expect(existsSync(file)).toBe(true);
    const got = JSON.parse(readFileSync(file, 'utf8'));
    expect(got.toolUseId).toBe('toolu_1');
    expect(got.questions).toEqual(PAYLOAD.tool_input.questions);
    expect(typeof got.ts).toBe('number');
  });

  it('post 删 sidecar', () => {
    run('pre', PAYLOAD);
    expect(existsSync(join(dir, 'sess-1.json'))).toBe(true);
    run('post', { session_id: 'sess-1' });
    expect(existsSync(join(dir, 'sess-1.json'))).toBe(false);
  });

  it('RCC_ASK_DIR 未设：不抛、不落盘', () => {
    expect(() => run('pre', PAYLOAD, false)).not.toThrow();
    expect(existsSync(join(dir, 'sess-1.json'))).toBe(false);
  });

  it('post 删不存在的文件也不抛', () => {
    expect(() => run('post', { session_id: 'ghost' })).not.toThrow();
  });

  it('pre 缺 questions（空题）→ 不落盘无意义 sidecar', () => {
    run('pre', { session_id: 'sess-1', tool_use_id: 't', tool_input: {} });
    expect(existsSync(join(dir, 'sess-1.json'))).toBe(false);
  });

  it('坏 stdin 不抛（吞掉异常 exit 0）', () => {
    const env = { ...process.env, RCC_ASK_DIR: dir } as Record<string, string>;
    expect(() => execFileSync('node', [SCRIPT, 'pre'], { input: 'not json', env })).not.toThrow();
  });
});
