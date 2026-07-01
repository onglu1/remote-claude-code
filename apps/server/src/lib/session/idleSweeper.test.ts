import { describe, it, expect, vi } from 'vitest';
import { IdleSweeper, type SweeperDeps } from './idleSweeper';

function makeDeps(): SweeperDeps & { _calls: { killed: string[]; closedConvs: string[] } } {
  const _calls = { killed: [] as string[], closedConvs: [] as string[] };
  const fakeConvs = {
    listAllAlive: () => [
      { id: 'c1', projectId: 'p', tmuxName: 't1', sessionId: 's1', ownerId: 'u1' },
      { id: 'c2', projectId: 'p', tmuxName: 't2', sessionId: 's2', ownerId: 'u2' },
    ],
    update: vi.fn((_projectId: string, id: string, _patch: { closedAt?: string }) => {
      _calls.closedConvs.push(id);
      return undefined;
    }),
  };
  const fakeUsers = {
    getSettings: (uid: string) => ({ idleCloseHours: uid === 'u1' ? 3 : 0 }),
  };
  const fakeTmux = {
    killSession: vi.fn(async (n: string) => { _calls.killed.push(n); }),
  };
  const fakeRegistry = {
    isActive: () => false,
    forceClose: vi.fn(),
  };
  return {
    conversations: fakeConvs,
    users: fakeUsers,
    tmux: fakeTmux,
    registry: fakeRegistry,
    measureIdle: vi.fn((conv: { id: string }) => ({
      busy: false,
      idleForMs: conv.id === 'c1' ? 4 * 3600_000 : 1000,  // c1 超 3h,c2 才 1s
      reasons: [],
    })),
    now: () => Date.parse('2026-06-23T10:00:00Z'),
    _calls,
  };
}

describe('IdleSweeper', () => {
  it('单次 sweep:超阈值 → kill tmux + 写 closedAt', async () => {
    const deps = makeDeps();
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual(['t1']);
    expect(deps._calls.closedConvs).toEqual(['c1']);
  });

  it('idleCloseHours=0 的用户:跳过', async () => {
    const deps = makeDeps();
    // c2 owner=u2,idleCloseHours=0 → 不关
    // 但 c2 也没超 3h,我们把它改成超 3h
    deps.measureIdle = vi.fn(() => ({ busy: false, idleForMs: 10 * 3600_000, reasons: [] }));
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual(['t1']);  // u1 的关
    expect(deps._calls.killed).not.toContain('t2');  // u2 (idleCloseHours=0) 不关
  });

  it('busy=true 的会话:不关', async () => {
    const deps = makeDeps();
    deps.measureIdle = vi.fn(() => ({ busy: true, idleForMs: 100 * 3600_000, reasons: ['open_tool_use'] }));
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000, defaultThresholdHours: 3 });
    await sweeper.sweepOnce();
    expect(deps._calls.killed).toEqual([]);
  });

  it('start/stop:不报错', () => {
    const deps = makeDeps();
    const sweeper = new IdleSweeper(deps, { intervalMs: 60_000 });
    sweeper.start();
    sweeper.stop();
  });
});
