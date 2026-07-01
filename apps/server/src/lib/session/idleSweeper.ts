import type { AgentKind } from '@rcc/shared';
import type { TickResult } from './activity';

/** measureIdle 需要按 agentKind 选对应 adapter 定位 transcript,cwd 是 codex 定位 rollout 文件必需的过滤条件。 */
export interface SweeperConv {
  id: string;
  projectId: string;
  tmuxName: string;
  sessionId: string;
  agentKind: AgentKind;
  cwd: string;
  ownerId?: string;
}

/**
 * IdleSweeper 不依赖具体 ConversationStore/UserStore/Tmux/Registry 类,
 * 只声明它需要的最小能力;app.ts 接好真实实例后注入即可。
 */
export interface SweeperDeps {
  conversations: {
    listAllAlive: () => SweeperConv[];
    update: (projectId: string, id: string, patch: { closedAt?: string }) => unknown;
  };
  users: {
    getSettings: (ownerId: string) => { idleCloseHours: number };
  };
  tmux: {
    /** ownerId 用于多用户隔离时按 conv 解析目标 unix 用户;不传则用 ServiceUser 路径(兼容老调用)。 */
    killSession: (name: string, ownerId?: string) => Promise<void>;
  };
  registry: {
    isActive: (projectId: string, id: string) => boolean;
    forceClose: (projectId: string, id: string) => void;
  };
  measureIdle: (conv: SweeperConv) => TickResult;
  now: () => number;
}

export interface SweeperOpts {
  intervalMs?: number;
  defaultThresholdHours?: number;
}

/**
 * 周期扫所有未休眠/未删除的 conversations:
 *  - busy=true → 跳过
 *  - idleCloseHours=0 → 跳过(用户关了自动关闭功能)
 *  - idleForMs ≥ 阈值 → killSession + 写 closedAt + registry.forceClose
 *
 * 写 closedAt 的副作用走 deps.conversations.update,
 * 由 sessions.ts 路由层包一层后再广播 convClosed WS 事件。
 */
export class IdleSweeper {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly deps: SweeperDeps,
    private readonly opts: SweeperOpts = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.sweepOnce().catch(() => { /* 静默,下一 tick 再试 */ });
    }, interval);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweepOnce(): Promise<void> {
    const now = this.deps.now();
    const defaultHours = this.opts.defaultThresholdHours ?? 3;
    for (const c of this.deps.conversations.listAllAlive()) {
      const ownerId = c.ownerId;
      const thresholdHours = ownerId
        ? this.deps.users.getSettings(ownerId).idleCloseHours
        : defaultHours;
      if (thresholdHours <= 0) continue;  // 用户关了自动关闭
      const r = this.deps.measureIdle(c);
      if (r.busy) continue;
      if (r.idleForMs < thresholdHours * 3600_000) continue;

      await this.deps.tmux.killSession(c.tmuxName, c.ownerId);
      this.deps.conversations.update(c.projectId, c.id, { closedAt: new Date(now).toISOString() });
      this.deps.registry.forceClose(c.projectId, c.id);
    }
  }
}
