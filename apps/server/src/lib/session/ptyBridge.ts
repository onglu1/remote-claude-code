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
  /**
   * 多用户隔离 2026-06-24:终端视图也要按 unix 用户分,否则 SessionRegistry 用 baked-in 的
   * ServiceUser Tmux,所有终端会话都落在 wangleyan socket 上、pty.spawn 也以 wangleyan uid 跑,
   * 导致 zhangrengang 项目里 claude 的 Bash 工具 `stat -c '%U'` 永远返 wangleyan。
   *
   * 可选(老 spec 不带):缺省按 ServiceUser 跑,等同迁移前行为(零回归)。
   */
  unixUser?: string;
}

export type BridgeFactory = (spec: BridgeSpec) => PtyBridge;

/**
 * 把"按 unixUser 决定 binary 与 argv 前缀"这一段抽成纯函数,便于单测。
 *  - 同 ServiceUser → 直 spawn 'tmux'(零开销路径,等同老行为)。
 *  - 跨 unix → spawn 'sudo' 前缀 `-n -H -u <user> --`:
 *      -n 非交互(配错 sudoers 立刻报错而非挂起 PTY),
 *      -H 强制 HOME=/home/<user>(claude 解析 ~/.claude 必须对),
 *      -- 终结 sudo flag 解析。
 *
 * tmuxArgs 已含 `-L <socket>`(由 Tmux.newOrAttachArgs 拼装,socket 名按 unixUser 派生),
 * 所以本函数不再拼 socket,只决定外层 binary。
 */
export function buildBridgeSpawn(
  tmuxArgs: string[],
  unixUser: string,
  currentUser: string,
): { file: string; args: string[] } {
  if (unixUser === currentUser) {
    return { file: 'tmux', args: tmuxArgs };
  }
  return { file: 'sudo', args: ['-n', '-H', '-u', unixUser, '--', 'tmux', ...tmuxArgs] };
}

/**
 * 真实实现：node-pty spawn `tmux new-session -A ...`，把 PTY 接到 tmux 会话。
 * detach（dispose）只发送 tmux detach 并杀掉本 attach 进程，tmux 会话与 claude 不受影响。
 *
 * 多用户隔离 2026-06-24:不再 baked-in 单个 Tmux 实例,而是接 `getTmux(unixUser)` 工厂
 * 与 currentUser(= ServiceUser)。每次 subscribe 按 spec.unixUser 取对应 socket 的 Tmux
 * (跨 user 时 pty.spawn 走 sudo 前缀)。spec.unixUser 缺省 = currentUser(向后兼容)。
 */
export function makeRealBridgeFactory(
  getTmux: (unixUser: string) => Tmux,
  currentUser: string,
): BridgeFactory {
  return (spec) => {
    const unixUser = spec.unixUser ?? currentUser;
    const tmux = getTmux(unixUser);
    const tmuxArgs = tmux.newOrAttachArgs(spec.tmuxName, spec.cwd, spec.command, spec.cols, spec.rows);
    const { file, args } = buildBridgeSpawn(tmuxArgs, unixUser, currentUser);
    const proc = pty.spawn(file, args, {
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
