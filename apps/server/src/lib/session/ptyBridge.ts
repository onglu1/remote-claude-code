import * as pty from 'node-pty';
import type { Tmux } from './tmux';

export interface PtyBridge {
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 释放 attach 进程，但不杀 tmux 会话（claude 继续跑）。 */
  dispose(): void;
}

export interface BridgeSpec {
  tmuxName: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
}

export type BridgeFactory = (spec: BridgeSpec) => PtyBridge;

/**
 * 真实实现：node-pty spawn `tmux new-session -A ...`，把 PTY 接到 tmux 会话。
 * detach（dispose）只发送 tmux detach 并杀掉本 attach 进程，tmux 会话与 claude 不受影响。
 */
export function makeRealBridgeFactory(tmux: Tmux): BridgeFactory {
  return (spec) => {
    const args = tmux.newOrAttachArgs(spec.tmuxName, spec.cwd, spec.command, spec.cols, spec.rows);
    const proc = pty.spawn('tmux', args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: process.env as Record<string, string>,
    });

    let disposed = false;
    return {
      onData: (cb) => proc.onData(cb),
      onExit: (cb) => proc.onExit(({ exitCode }) => cb(exitCode)),
      write: (data) => proc.write(data),
      resize: (cols, rows) => {
        try {
          proc.resize(Math.max(cols, 2), Math.max(rows, 2));
        } catch {
          /* 窗口尚未就绪时忽略 */
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // 发送 tmux detach 前缀（Ctrl-b d），再兜底 kill attach 进程
        try {
          proc.write('\x02d');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        }, 50);
      },
    };
  };
}
