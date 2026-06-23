import type { BridgeFactory, BridgeSpec, PtyBridge } from './ptyBridge';

export interface Subscriber {
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
}

export interface SessionHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  unsubscribe(): void;
}

interface Entry {
  bridge: PtyBridge;
  subscribers: Set<Subscriber>;
}

/**
 * 活动会话注册表：每个会话（tmux session）最多一个 pty bridge，
 * 多个 WS 客户端共享同一 bridge；最后一个客户端离开时 detach（不杀 tmux）。
 */
export class SessionRegistry {
  private entries = new Map<string, Entry>();

  constructor(private readonly factory: BridgeFactory) {}

  /** 订阅一个会话；首个订阅者触发 bridge 创建（= tmux new-session -A）。 */
  subscribe(convId: string, spec: BridgeSpec, sub: Subscriber): SessionHandle {
    let entry = this.entries.get(convId);
    if (!entry) {
      const bridge = this.factory(spec);
      entry = { bridge, subscribers: new Set() };
      this.entries.set(convId, entry);
      bridge.onData((data) => {
        for (const s of entry!.subscribers) s.onData(data);
      });
      bridge.onExit((code) => {
        for (const s of entry!.subscribers) s.onExit(code);
        this.entries.delete(convId);
      });
    }
    entry.subscribers.add(sub);

    return {
      write: (data) => entry!.bridge.write(data),
      resize: (cols, rows) => entry!.bridge.resize(cols, rows),
      unsubscribe: () => {
        entry!.subscribers.delete(sub);
        if (entry!.subscribers.size === 0) {
          entry!.bridge.dispose();
          this.entries.delete(convId);
        }
      },
    };
  }

  isActive(convId: string): boolean {
    return this.entries.has(convId);
  }

  activeCount(): number {
    return this.entries.size;
  }
}
