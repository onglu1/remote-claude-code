import type { ExecFn } from './tmux';

export interface RunAsDeps {
  exec: ExecFn;
  /** 服务进程的 unix 用户名(通常 = os.userInfo().username 或 config.serviceUser)。 */
  currentUser: string;
}

export type RunAsFn = (unixUser: string, file: string, args: string[]) => ReturnType<ExecFn>;

/**
 * 命令包装单注入点。所有引起 unix 副作用(tmux/claude/stat/cat/cp/mkdir/...)的调用统一过它。
 *
 * - 目标 unix === currentUser → 直 exec,零 sudo 开销,行为等同当前单用户路径。
 * - 跨 unix → 前缀 `sudo -n -H -u <user> --`:
 *     -n 非交互(配错 sudoers 立刻报错而非挂起),
 *     -H 强制 HOME=/home/<user>(claude 解析 ~/.claude 必须对),
 *     -- 终结 sudo flag 解析。
 *
 * 二进制路径由调用方传入绝对路径(配合 sudoers 命令白名单);本工具不解析 PATH,
 * 也不做命令字符串拼装(args 数组直透,无 shell 注入面)。
 */
export function makeRunAs(deps: RunAsDeps): RunAsFn {
  return function runAs(unixUser, file, args) {
    if (unixUser === deps.currentUser) {
      return deps.exec(file, args);
    }
    return deps.exec('sudo', ['-n', '-H', '-u', unixUser, '--', file, ...args]);
  };
}
