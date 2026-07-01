import { describe, it, expect } from 'vitest';
import { idleLimitFor } from './context';

const baseCapabilities = { effort: false, askHook: false, hud: false, rewind: false, presetSessionId: false };

describe('idleLimitFor', () => {
  it('paneRunningSignal=true(claude)不覆盖,走 ChatSession 自己的默认值', () => {
    const adapter = { capabilities: { ...baseCapabilities, paneRunningSignal: true } };
    expect(idleLimitFor(adapter)).toBeUndefined();
  });

  it('paneRunningSignal=false(codex)放宽到 160 tick,避免读屏兜底缺失导致误判"已完成"', () => {
    const adapter = { capabilities: { ...baseCapabilities, paneRunningSignal: false } };
    expect(idleLimitFor(adapter)).toBe(160);
  });
});
