/**
 * SessionIndexHook:给 ChatSession 看到的最小接口,只有 onMessage 一个方法。
 * ChatSession 不直接依赖 SessionIndex 类,测试时注入 fake hook 即可。
 */
import type { IndexedMessage } from './types';

export interface SessionIndexHook {
  onMessage(sessionKey: string, msg: IndexedMessage): void;
}
