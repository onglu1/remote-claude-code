import { describe, it, expect } from 'vitest';
import type { AgentAdapter, LaunchOpts, ResumeOpts, ToolUseEvent } from './adapter';

describe('AgentAdapter 接口契约（类型层面）', () => {
  it('LaunchOpts/ResumeOpts 至少要有 launchCommand 和 sessionId', () => {
    // 这是类型层面的"契约"：能编译通过即视为 OK。
    const opts: LaunchOpts = { launchCommand: 'x', sessionId: 'y' };
    expect(opts.launchCommand).toBe('x');
    expect(opts.sessionId).toBe('y');
    const rOpts: ResumeOpts = { launchCommand: 'x', sessionId: 'y' };
    expect(rOpts.launchCommand).toBe('x');
  });

  it('ToolUseEvent 用 kind/id/sidechain 描述工具开/闭', () => {
    const ev: ToolUseEvent = { kind: 'open', id: 'tu_1', sidechain: false };
    expect(ev.kind).toBe('open');
  });

  it('AgentAdapter 必须暴露 kind 与 capabilities', () => {
    // 用一个空 stub 验证接口形状；契约靠类型 + 编译。
    const stub: Partial<AgentAdapter> = {
      kind: 'claude',
      capabilities: {
        effort: true,
        askHook: true,
        hud: true,
        rewind: true,
        presetSessionId: true,
        paneRunningSignal: true,
      },
    };
    expect(stub.kind).toBe('claude');
    expect(stub.capabilities?.askHook).toBe(true);
  });
});
