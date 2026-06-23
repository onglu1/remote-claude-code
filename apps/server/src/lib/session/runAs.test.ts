import { describe, it, expect, vi } from 'vitest';
import { makeRunAs } from './runAs';

describe('runAs', () => {
  it('零开销路径:同 user → 直 exec,argv 一致', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await runAs('wangleyan', 'tmux', ['list-sessions']);
    expect(exec).toHaveBeenCalledWith('tmux', ['list-sessions']);
  });

  it('跨 unix:前缀 `sudo -n -H -u <user> --` 并透传 argv', async () => {
    const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '' }));
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await runAs('zhangsan', 'tmux', ['kill-session', '-t', 'foo']);
    expect(exec).toHaveBeenCalledWith('sudo', [
      '-n',
      '-H',
      '-u',
      'zhangsan',
      '--',
      'tmux',
      'kill-session',
      '-t',
      'foo',
    ]);
  });

  it('exec 错误透传', async () => {
    const exec = vi.fn(async () => {
      throw new Error('sudo: a password is required');
    });
    const runAs = makeRunAs({ exec, currentUser: 'wangleyan' });
    await expect(runAs('zhangsan', 'tmux', [])).rejects.toThrow(/password is required/);
  });
});
