import type { ServerMessage, ClientMessage } from '@rcc/shared';

export interface TerminalSocket {
  send(msg: ClientMessage): void;
  close(): void;
}

export interface TerminalHandlers {
  onData: (data: string) => void;
  onStatus?: (alive: boolean) => void;
  onExit?: (code: number | null) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * 连接会话终端流。断线后自动重连（tmux 侧会话持续存活，重连即恢复）。
 */
export function connectTerminal(
  projectId: string,
  convId: string,
  size: { cols: number; rows: number },
  handlers: TerminalHandlers,
): TerminalSocket {
  let ws: WebSocket | null = null;
  let closedByUser = false;
  let retry = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const url = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return (
      `${proto}://${location.host}/api/projects/${projectId}/conversations/${convId}/stream` +
      `?cols=${size.cols}&rows=${size.rows}`
    );
  };

  const open = () => {
    ws = new WebSocket(url());
    ws.onopen = () => {
      retry = 0;
      handlers.onOpen?.();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'data') handlers.onData(msg.data);
      else if (msg.type === 'status') handlers.onStatus?.(msg.alive);
      else if (msg.type === 'exit') handlers.onExit?.(msg.code);
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
