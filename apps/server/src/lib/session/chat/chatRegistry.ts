/**
 * 活动聊天会话注册表：每会话最多一个 ChatSession，多个 WS 客户端共享；
 * 最后一个客户端离开时停轮询（不杀 tmux，会话后台续跑）。与终端侧 registry 同构。
 */
import type { AskPending, AskPick, ChatKey, ChatHistorySnapshot, ChatMessage, EffortLevel, Hud, RewindItem, RewindMode } from '@rcc/shared';
import type { ChatSpec, ChatSessionEvents, AskStateEvent } from './chatSession';
import type { RewindResult } from './rewind';

/** 注册表只依赖会话的这组能力（便于测试注入假会话）。 */
export interface ChatSessionLike {
  ensure(): Promise<void>;
  getSkeleton(): ChatHistorySnapshot;
  getTurnBody(turnId: string): ChatMessage[] | null;
  sendText(text: string): Promise<void>;
  sendKey(key: ChatKey): Promise<void>;
  interrupt(): Promise<void>;
  refresh(): Promise<void>;
  capturePeek(): Promise<string>;
  setEffort(level: EffortLevel): Promise<void>;
  rewindOpen(): Promise<RewindItem[]>;
  rewindExecute(index: number, mode: RewindMode): Promise<RewindResult>;
  rewindCancel(): Promise<void>;
  answerAsk(toolUseId: string, picks: AskPick[]): Promise<void>;
  answerPendingAsk(optionIndices: number[]): Promise<void>;
  getLiveAsk(): AskPending | null;
  getLiveHud(): Hud | null;
  startPolling(): void;
  stopPolling(): void;
}

export type ChatSessionFactory = (spec: ChatSpec, events: ChatSessionEvents) => ChatSessionLike;

export interface ChatSubscriber {
  onHistory: (snapshot: ChatHistorySnapshot) => void;
  onMessage: (m: ChatMessage) => void;
  onPreview: (text: string) => void;
  onTurnState: (running: boolean) => void;
  onAskState: (s: AskStateEvent) => void;
  onAskPending: (a: AskPending) => void;
  onAskPendingClear: () => void;
  onAskPendingFailed: (error?: string) => void;
  onHud: (h: Hud) => void;
}

export interface ChatHandle {
  sendText(text: string): Promise<void>;
  sendKey(key: ChatKey): Promise<void>;
  interrupt(): Promise<void>;
  refresh(): Promise<void>;
  peek(): Promise<string>;
  setEffort(level: EffortLevel): Promise<void>;
  rewindOpen(): Promise<RewindItem[]>;
  rewindExecute(index: number, mode: RewindMode): Promise<RewindResult>;
  rewindCancel(): Promise<void>;
  answerAsk(toolUseId: string, picks: AskPick[]): Promise<void>;
  answerPendingAsk(optionIndices: number[]): Promise<void>;
  getLiveAsk(): AskPending | null;
  getLiveHud(): Hud | null;
  /** 按需取某折叠助手回合的完整正文(load_turn);未命中 null。 */
  loadTurn(turnId: string): ChatMessage[] | null;
  resync(): void;
  unsubscribe(): void;
}

interface Entry {
  session: ChatSessionLike;
  subscribers: Set<ChatSubscriber>;
}

export class ChatRegistry {
  private entries = new Map<string, Entry>();

  constructor(private readonly factory: ChatSessionFactory) {}

  async subscribe(convId: string, spec: ChatSpec, sub: ChatSubscriber): Promise<ChatHandle> {
    let entry = this.entries.get(convId);
    if (!entry) {
      const subscribers = new Set<ChatSubscriber>();
      const session = this.factory(spec, {
        onMessage: (m) => subscribers.forEach((s) => s.onMessage(m)),
        onHistory: (msgs) => subscribers.forEach((s) => s.onHistory(msgs)),
        onPreview: (t) => subscribers.forEach((s) => s.onPreview(t)),
        onTurnState: (r) => subscribers.forEach((s) => s.onTurnState(r)),
        onAskState: (a) => subscribers.forEach((s) => s.onAskState(a)),
        onAskPending: (a) => subscribers.forEach((s) => s.onAskPending(a)),
        onAskPendingClear: () => subscribers.forEach((s) => s.onAskPendingClear()),
        onAskPendingFailed: (e) => subscribers.forEach((s) => s.onAskPendingFailed(e)),
        onHud: (h) => subscribers.forEach((s) => s.onHud(h)),
      });
      entry = { session, subscribers };
      this.entries.set(convId, entry);
      await session.ensure();
      session.startPolling();
    }
    const e = entry;
    e.subscribers.add(sub);
    sub.onHistory(e.session.getSkeleton());
    // 待答态不在 transcript 历史里:新订阅者/重连需补发当前待答选择题。
    const live = e.session.getLiveAsk();
    if (live) sub.onAskPending(live);
    // HUD 是当前态、不在 transcript 里:新订阅者立即补发一次。
    const liveHud = e.session.getLiveHud();
    if (liveHud) sub.onHud(liveHud);

    return {
      sendText: (t) => e.session.sendText(t),
      sendKey: (k) => e.session.sendKey(k),
      interrupt: () => e.session.interrupt(),
      refresh: () => e.session.refresh(),
      peek: () => e.session.capturePeek(),
      setEffort: (l) => e.session.setEffort(l),
      rewindOpen: () => e.session.rewindOpen(),
      rewindExecute: (i, m) => e.session.rewindExecute(i, m),
      rewindCancel: () => e.session.rewindCancel(),
      answerAsk: (id, picks) => e.session.answerAsk(id, picks),
      answerPendingAsk: (idx) => e.session.answerPendingAsk(idx),
      getLiveAsk: () => e.session.getLiveAsk(),
      getLiveHud: () => e.session.getLiveHud(),
      loadTurn: (turnId) => e.session.getTurnBody(turnId),
      resync: () => {
        sub.onHistory(e.session.getSkeleton());
        const la = e.session.getLiveAsk();
        if (la) sub.onAskPending(la);
        else sub.onAskPendingClear();
        const lh = e.session.getLiveHud();
        if (lh) sub.onHud(lh);
      },
      unsubscribe: () => {
        e.subscribers.delete(sub);
        if (e.subscribers.size === 0) {
          e.session.stopPolling();
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
