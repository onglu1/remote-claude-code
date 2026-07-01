import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { makeClaudeAdapter } from './claudeAdapter';

/** 测试用 adapter:serviceUser 绑当前进程用户;真实用法见 context 组装。 */
const claudeAdapter = makeClaudeAdapter(os.userInfo().username);

describe('claudeAdapter', () => {
  it('kind 是 claude', () => {
    expect(claudeAdapter.kind).toBe('claude');
  });

  it('capabilities 全开', () => {
    expect(claudeAdapter.capabilities).toEqual({
      effort: true,
      askHook: true,
      hud: true,
      rewind: true,
      presetSessionId: true,
      paneRunningSignal: true,
    });
  });

  it('buildLaunchCmd 与 buildResumeCmd 输出和既有 buildClaudeCmd 一致', () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    const launch = claudeAdapter.buildLaunchCmd({
      launchCommand: 'Fable-yolo',
      sessionId: sid,
      effort: 'max',
    });
    // 既有 buildClaudeCmd: `<envExport><launchCommand> <effortFlag> --session-id <UUID>`
    expect(launch).toContain('Fable-yolo');
    expect(launch).toContain(`--session-id ${sid}`);
    expect(launch).toContain('--effort');

    const resume = claudeAdapter.buildResumeCmd({
      launchCommand: 'Fable-yolo',
      sessionId: sid,
      effort: 'max',
    });
    expect(resume).toContain(`--resume ${sid}`);
    expect(resume).not.toContain(`--session-id ${sid}`);
  });

  it('discoverSessionId 直接回 tentative(claude 是预指定的)', async () => {
    const got = await claudeAdapter.discoverSessionId({
      tentativeSessionId: 'abc',
      unixUser: 'u',
      cwd: '/tmp',
      timeoutMs: 100,
      startedAt: Date.now(),
    });
    expect(got).toBe('abc');
  });

  it('parseToolUseEvents 转调既有解析:见 tool_use → open', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      message: { content: [{ type: 'tool_use', id: 'tu_x' }] },
    }) + '\n';
    const events = claudeAdapter.parseToolUseEvents(jsonl);
    expect(events).toContainEqual({ kind: 'open', id: 'tu_x', sidechain: false });
  });
});
