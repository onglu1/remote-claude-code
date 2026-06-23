import { describe, it, expect, vi } from 'vitest';
import { SessionRegistry } from './registry';
import type { BridgeFactory, PtyBridge } from './ptyBridge';

function fakeBridge() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (c: number | null) => void = () => {};
  const bridge: PtyBridge = {
    onData: (cb) => (dataCb = cb),
    onExit: (cb) => (exitCb = cb),
    write: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  return { bridge, emit: (d: string) => dataCb(d), exit: (c: number | null) => exitCb(c) };
}

const spec = { tmuxName: 'rcc-p-c', cwd: '/tmp', command: 'claude', cols: 80, rows: 24 };

describe('SessionRegistry', () => {
  it('首个订阅创建 bridge，第二个复用', () => {
    const fb = fakeBridge();
    const factory: BridgeFactory = vi.fn(() => fb.bridge);
    const reg = new SessionRegistry(factory);

    reg.subscribe('c', spec, { onData: () => {}, onExit: () => {} });
    reg.subscribe('c', spec, { onData: () => {}, onExit: () => {} });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(reg.activeCount()).toBe(1);
  });

  it('数据广播给所有订阅者', () => {
    const fb = fakeBridge();
    const reg = new SessionRegistry(() => fb.bridge);
    const a = vi.fn();
    const b = vi.fn();
    reg.subscribe('c', spec, { onData: a, onExit: () => {} });
    reg.subscribe('c', spec, { onData: b, onExit: () => {} });
    fb.emit('hello');
    expect(a).toHaveBeenCalledWith('hello');
    expect(b).toHaveBeenCalledWith('hello');
  });

  it('最后一个订阅者离开时 dispose（不杀 tmux）', () => {
    const fb = fakeBridge();
    const reg = new SessionRegistry(() => fb.bridge);
    const h1 = reg.subscribe('c', spec, { onData: () => {}, onExit: () => {} });
    const h2 = reg.subscribe('c', spec, { onData: () => {}, onExit: () => {} });
    h1.unsubscribe();
    expect(fb.bridge.dispose).not.toHaveBeenCalled();
    h2.unsubscribe();
    expect(fb.bridge.dispose).toHaveBeenCalledTimes(1);
    expect(reg.isActive('c')).toBe(false);
  });

  it('write/resize 路由到 bridge', () => {
    const fb = fakeBridge();
    const reg = new SessionRegistry(() => fb.bridge);
    const h = reg.subscribe('c', spec, { onData: () => {}, onExit: () => {} });
    h.write('ls\r');
    h.resize(100, 40);
    expect(fb.bridge.write).toHaveBeenCalledWith('ls\r');
    expect(fb.bridge.resize).toHaveBeenCalledWith(100, 40);
  });
});
