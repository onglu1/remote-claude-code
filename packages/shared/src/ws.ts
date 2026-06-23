/** 终端会话 WebSocket 协议。 */

/** 浏览器 → 服务器 */
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/** 服务器 → 浏览器 */
export type ServerMessage =
  | { type: 'data'; data: string }
  | { type: 'status'; alive: boolean }
  | { type: 'exit'; code: number | null };

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClientMessage(raw: string): ClientMessage | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj.type === 'input' && typeof obj.data === 'string') {
      return { type: 'input', data: obj.data };
    }
    if (
      obj.type === 'resize' &&
      typeof obj.cols === 'number' &&
      typeof obj.rows === 'number'
    ) {
      return { type: 'resize', cols: obj.cols, rows: obj.rows };
    }
    return null;
  } catch {
    return null;
  }
}
