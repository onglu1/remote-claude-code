import { describe, it, expect, vi } from 'vitest';
import { Tmux, type ExecFn } from './tmux';

describe('Tmux', () => {
  it('sessionName 规则', () => {
    expect(Tmux.sessionName('htransformer', 'abc')).toBe('rcc-htransformer-abc');
  });

  it('newOrAttachArgs 拼装正确', () => {
    const t = new Tmux('rcc');
    const args = t.newOrAttachArgs('rcc-p-c', '/tmp/p', 'claude', 80, 24);
    expect(args).toEqual([
      '-L', 'rcc', 'new-session', '-A', '-s', 'rcc-p-c',
      '-c', '/tmp/p', '-x', '80', '-y', '24',
      '--', 'bash', '-ic', 'claude',
    ]);
  });

  it('listSessions 过滤 rcc- 前缀', async () => {
    const exec: ExecFn = vi.fn(async () => ({
      stdout: 'rcc-p-1\nother\nrcc-p-2\n',
      stderr: '',
    }));
    const t = new Tmux('rcc', exec);
    expect(await t.listSessions()).toEqual(['rcc-p-1', 'rcc-p-2']);
  });

  it('listSessions 在 tmux 报错时返回空', async () => {
    const exec: ExecFn = vi.fn(async () => {
      throw new Error('no server running');
    });
    const t = new Tmux('rcc', exec);
    expect(await t.listSessions()).toEqual([]);
  });

  it('sendLiteralKeys 用 send-keys -l 发字面量', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const t = new Tmux('rcc', exec as ExecFn);
    await t.sendLiteralKeys('rcc-p-1', '3');
    expect(exec).toHaveBeenCalledWith('tmux', ['-L', 'rcc', 'send-keys', '-t', 'rcc-p-1', '-l', '3']);
  });

  it('killSession 调用正确参数', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const t = new Tmux('rcc', exec as ExecFn);
    await t.killSession('rcc-p-1');
    expect(exec).toHaveBeenCalledWith('tmux', ['-L', 'rcc', 'kill-session', '-t', 'rcc-p-1']);
  });

  it('newDetachedArgs 构造 detached 会话', () => {
    const t = new Tmux('rcc');
    expect(t.newDetachedArgs('rcc-p-c', '/proj', 'Fable-yolo --session-id u1', 120, 40)).toEqual([
      '-L', 'rcc', 'new-session', '-d', '-s', 'rcc-p-c',
      '-c', '/proj', '-x', '120', '-y', '40',
      '--', 'bash', '-ic', 'Fable-yolo --session-id u1',
    ]);
  });

  it('sendKeys 发送命名键', async () => {
    const calls: string[][] = [];
    const t = new Tmux('rcc', async (_f, a) => {
      calls.push(a);
      return { stdout: '', stderr: '' };
    });
    await t.sendKeys('rcc-p-c', ['Escape']);
    expect(calls[0]).toEqual(['-L', 'rcc', 'send-keys', '-t', 'rcc-p-c', 'Escape']);
  });

  it('capturePaneVisible 抓可见屏（不带 -S）', async () => {
    const calls: string[][] = [];
    const t = new Tmux('rcc', async (_f, a) => {
      calls.push(a);
      return { stdout: 'screen', stderr: '' };
    });
    expect(await t.capturePaneVisible('rcc-p-c')).toBe('screen');
    expect(calls[0]).toEqual(['-L', 'rcc', 'capture-pane', '-p', '-t', 'rcc-p-c']);
  });

  it('pasteText 用命名缓冲粘贴多行', async () => {
    const calls: string[][] = [];
    const t = new Tmux('rcc', async (_f, a) => {
      calls.push(a);
      return { stdout: '', stderr: '' };
    });
    await t.pasteText('rcc-p-c', 'line1\nline2');
    expect(calls[0]).toEqual(['-L', 'rcc', 'set-buffer', '-b', 'rcc-paste', '--', 'line1\nline2']);
    expect(calls[1]).toEqual(['-L', 'rcc', 'paste-buffer', '-d', '-b', 'rcc-paste', '-t', 'rcc-p-c']);
  });

  it('historyInfoArgs 拼装 display-message', () => {
    const t = new Tmux('rcc');
    expect(t.historyInfoArgs('rcc-p-c')).toEqual([
      '-L', 'rcc', 'display-message', '-p', '-t', 'rcc-p-c', '#{history_size} #{pane_height}',
    ]);
  });

  it('historyInfo 解析两个整数', async () => {
    const t = new Tmux('rcc', async () => ({ stdout: '61 10\n', stderr: '' }));
    expect(await t.historyInfo('rcc-p-c')).toEqual({ historySize: 61, paneHeight: 10 });
  });

  it('historyInfo 出错返回 null', async () => {
    const t = new Tmux('rcc', async () => {
      throw new Error('no session');
    });
    expect(await t.historyInfo('rcc-p-c')).toBeNull();
  });

  it('captureRangeArgs 带 -e/-J 与 -S/-E', () => {
    const t = new Tmux('rcc');
    expect(t.captureRangeArgs('rcc-p-c', -40, 9)).toEqual([
      '-L', 'rcc', 'capture-pane', '-e', '-p', '-J', '-t', 'rcc-p-c', '-S', '-40', '-E', '9',
    ]);
  });

  it('captureRange 返回 stdout，出错返回空串', async () => {
    const ok = new Tmux('rcc', async () => ({ stdout: 'a\nb\n', stderr: '' }));
    expect(await ok.captureRange('rcc-p-c', -40, 9)).toBe('a\nb\n');
    const bad = new Tmux('rcc', async () => {
      throw new Error('boom');
    });
    expect(await bad.captureRange('rcc-p-c', -40, 9)).toBe('');
  });

  it('resizeWindowArgs 拼装 resize-window -x -y', () => {
    const t = new Tmux('rcc');
    expect(t.resizeWindowArgs('rcc-p-c', 120, 40)).toEqual([
      '-L', 'rcc', 'resize-window', '-t', 'rcc-p-c', '-x', '120', '-y', '40',
    ]);
  });

  it('resizeWindow 旧版 tmux 报错时静默吞掉(不抛)', async () => {
    const t = new Tmux('rcc', async () => {
      throw new Error('unknown command: resize-window');
    });
    await expect(t.resizeWindow('rcc-p-c', 120, 40)).resolves.toBeUndefined();
  });

  it('clearHistoryArgs 拼装 clear-history -t', () => {
    const t = new Tmux('rcc');
    expect(t.clearHistoryArgs('rcc-p-c')).toEqual([
      '-L', 'rcc', 'clear-history', '-t', 'rcc-p-c',
    ]);
  });

  it('clearHistory 会话不在时不抛', async () => {
    const t = new Tmux('rcc', async () => {
      throw new Error("can't find session");
    });
    await expect(t.clearHistory('rcc-p-c')).resolves.toBeUndefined();
  });

  it('pasteText bracketed=true 时 paste-buffer 带 -p 标志', async () => {
    const calls: string[][] = [];
    const t = new Tmux('rcc', async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await t.pasteText('rcc-p-c', 'line1\nline2', true);
    // 第二个调用是 paste-buffer,要含 -p。
    expect(calls[1]).toContain('-p');
  });

  it('pasteText bracketed=false(默认) 时 paste-buffer 不带 -p', async () => {
    const calls: string[][] = [];
    const t = new Tmux('rcc', async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await t.pasteText('rcc-p-c', 'hello');
    expect(calls[1]).not.toContain('-p');
  });
});
