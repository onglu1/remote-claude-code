import type { ChatClientMessage, ChatServerMessage, ChatMessage, ChatHistorySnapshot, EffortLevel, Hud, RewindItem, RewindMode, AskPending } from '@rcc/shared';

export interface ChatSocket {
  send(msg: ChatClientMessage): void;
  close(): void;
}

export interface ChatHandlers {
  onHistory?: (snap: ChatHistorySnapshot) => void;
  onTurnBody?: (turnId: string, messages: ChatMessage[]) => void;
  onMessage?: (m: ChatMessage) => void;
  onPreview?: (text: string) => void;
  onTurnState?: (running: boolean) => void;
  onSession?: (info: { sessionId: string; name: string }) => void;
  onPeek?: (text: string) => void;
  onEffort?: (level: EffortLevel) => void;
  onRewindList?: (items: RewindItem[]) => void;
  onRewindDone?: (mode: RewindMode, ok: boolean) => void;
  onAskState?: (s: { toolUseId: string; status: 'driving' | 'done' | 'failed'; error?: string }) => void;
  onAskPending?: (a: AskPending) => void;
  onAskPendingClear?: () => void;
  onAskPendingFailed?: (error?: string) => void;
  onHud?: (hud: Hud) => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/** 连接聊天会话流。断线自动重连（tmux 侧会话持续存活，重连回放历史）。 */
export function connectChat(projectId: string, convId: string, handlers: ChatHandlers): ChatSocket {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const url = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/api/projects/${projectId}/conversations/${convId}/chat`;
  };

  const open = () => {
    ws = new WebSocket(url());
    ws.onopen = () => {
      retry = 0;
      handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg: ChatServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ChatServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'history':
          handlers.onHistory?.({ items: msg.items, live: msg.live });
          break;
        case 'turn_body':
          handlers.onTurnBody?.(msg.turnId, msg.messages);
          break;
        case 'message':
          handlers.onMessage?.(msg.message);
          break;
        case 'preview':
          handlers.onPreview?.(msg.text);
          break;
        case 'turn_state':
          handlers.onTurnState?.(msg.running);
          break;
        case 'session':
          handlers.onSession?.({ sessionId: msg.sessionId, name: msg.name });
          break;
        case 'peek':
          handlers.onPeek?.(msg.text);
          break;
        case 'effort':
          handlers.onEffort?.(msg.level);
          break;
        case 'rewind_list':
          handlers.onRewindList?.(msg.items);
          break;
        case 'rewind_done':
          handlers.onRewindDone?.(msg.mode, msg.ok);
          break;
        case 'ask_state':
          handlers.onAskState?.({ toolUseId: msg.toolUseId, status: msg.status, error: msg.error });
          break;
        case 'ask_pending':
          handlers.onAskPending?.({
            options: msg.options,
            multiSelect: msg.multiSelect,
            question: msg.question,
            header: msg.header,
            qIndex: msg.qIndex,
            qTotal: msg.qTotal,
          });
          break;
        case 'ask_pending_clear':
          handlers.onAskPendingClear?.();
          break;
        case 'ask_pending_failed':
          handlers.onAskPendingFailed?.(msg.error);
          break;
        case 'hud':
          handlers.onHud?.(msg.hud);
          break;
        case 'error':
          handlers.onError?.(msg.message);
          break;
      }
    };
    ws.onclose = () => {
      handlers.onClose?.();
      if (closedByUser) return;
      const delay = Math.min(1000 * 2 ** retry, 8000);
      retry += 1;
      reconnectTimer = setTimeout(open, delay);
    };
    ws.onerror = () => ws?.close();
  };

  open();

  return {
    send: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      closedByUser = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
  };
}
