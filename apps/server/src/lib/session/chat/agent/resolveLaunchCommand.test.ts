import { describe, it, expect } from 'vitest';
import { resolveLaunchCommand, CODEX_DEFAULT_LAUNCH } from './resolveLaunchCommand';

describe('resolveLaunchCommand', () => {
  it('会话级 launchCommand 优先', () => {
    expect(resolveLaunchCommand(
      { agentKind: 'claude', launchCommand: 'custom-claude' },
      { launchCommand: 'Fable-yolo' },
    )).toBe('custom-claude');
    expect(resolveLaunchCommand(
      { agentKind: 'codex', launchCommand: 'codex --yolo --model gpt-5.4' },
      { launchCommand: 'Fable-yolo' },
    )).toBe('codex --yolo --model gpt-5.4');
  });

  it('claude 缺会话级 → 用项目级', () => {
    expect(resolveLaunchCommand(
      { agentKind: 'claude' },
      { launchCommand: 'Fable-yolo' },
    )).toBe('Fable-yolo');
  });

  it('codex 缺会话级 → 用全局常量', () => {
    expect(resolveLaunchCommand(
      { agentKind: 'codex' },
      { launchCommand: 'Fable-yolo' },
    )).toBe(CODEX_DEFAULT_LAUNCH);
    expect(CODEX_DEFAULT_LAUNCH).toBe('codex --yolo');
  });
});
