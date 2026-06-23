import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export type ExecFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

const realExec: ExecFn = (file, args) => pexec(file, args);

const SESSION_PREFIX = 'rcc-';

/**
 * 对 `tmux -L <socket>` 的薄封装。命令拼装是纯函数，便于测试；
 * 真正执行通过可注入的 ExecFn。
 */
export class Tmux {
  constructor(
    private readonly socket: string,
    private readonly exec: ExecFn = realExec,
  ) {}

  /** 会话名：rcc-<projectId>-<convId> */
  static sessionName(projectId: string, convId: string): string {
    return `${SESSION_PREFIX}${projectId}-${convId}`;
  }

  private base(): string[] {
    return ['-L', this.socket];
  }

  /** new-session -A：不存在则建、存在则 attach。返回 tmux 的完整 argv。 */
  newOrAttachArgs(name: string, cwd: string, command: string, cols: number, rows: number): string[] {
    return [
      ...this.base(),
      'new-session',
      '-A',
      '-s',
      name,
      '-c',
      cwd,
      '-x',
      String(cols),
      '-y',
      String(rows),
      // 用交互式 bash 启动：加载用户 .bashrc（别名/PATH/函数），
      // 这样像 `Fable-yolo` 这类 bash 别名才能展开，体验贴近真 SSH 终端。
      '--',
      'bash',
      '-ic',
      command,
    ];
  }

  /** detached 起会话（聊天模式：tmux 自身保活，无需 node-pty attach）。返回 argv。 */
  newDetachedArgs(name: string, cwd: string, command: string, cols: number, rows: number): string[] {
    return [
      ...this.base(),
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwd,
      '-x',
      String(cols),
      '-y',
      String(rows),
      '--',
      'bash',
      '-ic',
      command,
    ];
  }

  async newDetached(name: string, cwd: string, command: string, cols: number, rows: number): Promise<void> {
    await this.exec('tmux', this.newDetachedArgs(name, cwd, command, cols, rows));
  }

  /** 发送命名键（如 ['Enter']、['Escape']、['C-c']、['Up']）到会话当前 pane。 */
  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.exec('tmux', [...this.base(), 'send-keys', '-t', name, ...keys]);
  }

  /**
   * 发送字面量字符（send-keys -l）：用于 AskUserQuestion 绝对数字键作答。
   * 区别于 sendKeys 的「按键名」语义——`-l` 确保 "3" 被当作字符 3、而非键名查找。
   */
  async sendLiteralKeys(name: string, text: string): Promise<void> {
    await this.exec('tmux', [...this.base(), 'send-keys', '-t', name, '-l', text]);
  }

  /**
   * 把任意（含多行/特殊字符）文本经命名缓冲粘贴进 pane，避免 send-keys 的转义问题。
   * @param bracketed true 时用 paste-buffer -p(bracketed paste mode):内容被 \x1b[200~..\x1b[201~ 包起来,
   *   ink/claude code 等现代 TUI 会识别这个边界,把里面的 \n 当字符不当提交。
   *   适合发"多行用户消息"(文本+图片路径)——否则每个 \n 就是一次 Enter,被拆成 N 条消息。
   */
  async pasteText(name: string, text: string, bracketed = false): Promise<void> {
    await this.exec('tmux', [...this.base(), 'set-buffer', '-b', 'rcc-paste', '--', text]);
    const pasteArgs = bracketed
      ? [...this.base(), 'paste-buffer', '-d', '-p', '-b', 'rcc-paste', '-t', name]
      : [...this.base(), 'paste-buffer', '-d', '-b', 'rcc-paste', '-t', name];
    await this.exec('tmux', pasteArgs);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.exec('tmux', ['-V']);
      return true;
    } catch {
      return false;
    }
  }

  /** 列出本 socket 下以 rcc- 开头的会话名。 */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await this.exec('tmux', [
        ...this.base(),
        'list-sessions',
        '-F',
        '#{session_name}',
      ]);
      return stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.startsWith(SESSION_PREFIX));
    } catch {
      // 没有 server / 没有会话时 tmux 返回非零
      return [];
    }
  }

  async hasSession(name: string): Promise<boolean> {
    return (await this.listSessions()).includes(name);
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.exec('tmux', [...this.base(), 'kill-session', '-t', name]);
    } catch {
      /* 已不存在则忽略 */
    }
  }

  /** resize-window argv 拼装（便于单测）。 */
  resizeWindowArgs(name: string, cols: number, rows: number): string[] {
    return [...this.base(), 'resize-window', '-t', name, '-x', String(cols), '-y', String(rows)];
  }

  /** clear-history argv 拼装(便于单测)。 */
  clearHistoryArgs(name: string): string[] {
    return [...this.base(), 'clear-history', '-t', name];
  }

  /**
   * 清掉 tmux pane 的 scrollback 主 buffer。不动 alt screen,不动 pane 主进程(claude 继续跑),
   * 也不影响当前可见屏——仅是把往上能翻到的历史抹掉。「重排」靠这个不打断 claude 任务地解决
   * 窄物理行残留;claude 后续完成回合时输出的新内容会按当前 pane 宽度 wrap 进 scrollback。
   */
  async clearHistory(name: string): Promise<void> {
    try {
      await this.exec('tmux', this.clearHistoryArgs(name));
    } catch {
      /* 会话不存在/无 pane:忽略 */
    }
  }

  /**
   * 强制 tmux 会话窗口归位到给定尺寸。聊天模式没 client attach,被终端 attach
   * 缩列后没人帮忙撑回来,得这里主动 resize-window 把 pane 拉回基准（同时给 TUI
   * 触发 SIGWINCH 让它重绘）。tmux 2.9 引入,旧版静默失败。
   */
  async resizeWindow(name: string, cols: number, rows: number): Promise<void> {
    try {
      await this.exec('tmux', this.resizeWindowArgs(name, cols, rows));
    } catch {
      /* 旧版无此命令;调用方可发 Ctrl-L 兜底 */
    }
  }

  /** 抓取当前可见屏（不含滚动历史），用于聊天模式的流式预览读屏。 */
  async capturePaneVisible(name: string): Promise<string> {
    try {
      const { stdout } = await this.exec('tmux', [
        ...this.base(),
        'capture-pane',
        '-p',
        '-t',
        name,
      ]);
      return stdout;
    } catch {
      return '';
    }
  }

  /** 抓取窗格最近 N 行（含历史），用于重连时回放。 */
  async capturePane(name: string, lines = 2000): Promise<string> {
    try {
      const { stdout } = await this.exec('tmux', [
        ...this.base(),
        'capture-pane',
        '-p',
        '-t',
        name,
        '-S',
        `-${lines}`,
      ]);
      return stdout;
    } catch {
      return '';
    }
  }

  /** display-message 取历史行数与窗格高（阅读层窗口换算用）。argv 纯拼装便于单测。 */
  historyInfoArgs(name: string): string[] {
    return [...this.base(), 'display-message', '-p', '-t', name, '#{history_size} #{pane_height}'];
  }

  /** 取 pane 主进程 PID（bash -ic 模式下被 exec 成 claude,即 claude 自己的 pid）。 */
  panePidArgs(name: string): string[] {
    return [...this.base(), 'display-message', '-p', '-t', name, '#{pane_pid}'];
  }

  async panePid(name: string): Promise<number | null> {
    try {
      const { stdout } = await this.exec('tmux', this.panePidArgs(name));
      const pid = parseInt(stdout.trim(), 10);
      return Number.isFinite(pid) && pid > 1 ? pid : null;
    } catch {
      return null;
    }
  }

  async historyInfo(name: string): Promise<{ historySize: number; paneHeight: number } | null> {
    try {
      const { stdout } = await this.exec('tmux', this.historyInfoArgs(name));
      const [h, p] = stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      if (!Number.isFinite(h) || !Number.isFinite(p)) return null;
      return { historySize: h, paneHeight: p };
    } catch {
      return null;
    }
  }

  /** 抓指定行号区间（含历史），-e 保留颜色转义、-J 合并折行。供阅读层按窗口取数并着色。 */
  captureRangeArgs(name: string, start: number, end: number): string[] {
    return [...this.base(), 'capture-pane', '-e', '-p', '-J', '-t', name, '-S', String(start), '-E', String(end)];
  }

  async captureRange(name: string, start: number, end: number): Promise<string> {
    try {
      const { stdout } = await this.exec('tmux', this.captureRangeArgs(name, start, end));
      return stdout;
    } catch {
      return '';
    }
  }
}
