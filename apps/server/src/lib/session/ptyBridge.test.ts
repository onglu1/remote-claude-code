/**
 * buildBridgeSpawn 纯函数测试:决定 pty.spawn 用 'tmux' 还是 'sudo -nH -u' 前缀。
 * pty.spawn 本身不测(node-pty 真起进程,见 smoke-multiuser.ts 集成)。
 */
import { describe, it, expect } from 'vitest';
import { buildBridgeSpawn } from './ptyBridge';

describe('buildBridgeSpawn', () => {
  const tmuxArgs = ['-L', 'rcc', 'new-session', '-A', '-s', 'rcc-p-c'];

  it('同 ServiceUser:零开销直 spawn tmux,无 sudo 前缀', () => {
    const r = buildBridgeSpawn(tmuxArgs, 'wangleyan', 'wangleyan');
    expect(r.file).toBe('tmux');
    expect(r.args).toEqual(tmuxArgs);
  });

  it('跨 unix 用户:spawn sudo,前缀 -n -H -u <user> -- tmux <args>', () => {
    const crossArgs = ['-L', 'rcc-zhangrengang', 'new-session', '-A', '-s', 'rcc-p-c'];
    const r = buildBridgeSpawn(crossArgs, 'zhangrengang', 'wangleyan');
    expect(r.file).toBe('sudo');
    // 顺序很关键:-n 非交互 → -H 切 HOME → -u 目标用户 → -- 终结 flag → tmux + 透传 args
    expect(r.args).toEqual([
      '-n',
      '-H',
      '-u',
      'zhangrengang',
      '--',
      'tmux',
      ...crossArgs,
    ]);
  });

  it('参数顺序固定:不在 sudoers 白名单匹配前破窗', () => {
    // sudoers 白名单是按 binary 绝对路径授权,sudo 命令的 flag 顺序错了会被 sudo 拒收。
    // 本测试钉住 `-n -H -u <user> --` 的顺序,防后续重构调换。
    const r = buildBridgeSpawn(['x'], 'bob', 'alice');
    expect(r.args.slice(0, 5)).toEqual(['-n', '-H', '-u', 'bob', '--']);
    expect(r.args[5]).toBe('tmux');
    expect(r.args[6]).toBe('x');
  });
});
