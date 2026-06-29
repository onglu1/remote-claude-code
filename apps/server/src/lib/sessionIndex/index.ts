/**
 * SessionIndex facade:外部调用入口,内部聚合 db + Indexer + search。
 * 持有 sqlite 连接的生命周期(open/close),并暴露三层防线方法 + 搜索接口。
 *
 * 注入 AppContext 后:
 *   - 启动:app.ts 调 ctx.sessionIndex.start()(startupSweep + setInterval onTick)
 *   - 聊天:chatSession.deps 经 SessionIndexHook 调 onMessage 推送新主线消息
 *   - 搜索:routes/sessionSearch.ts 调 ctx.sessionIndex.search(opts, namespaceId)
 *   - 关闭:app.ts onClose hook 调 ctx.sessionIndex.close()
 */
import type { Db } from './db';
import { openSessionIndexDb } from './db';
import { Indexer, type IndexerDeps } from './indexer';
import { searchSessions } from './search';
import type { SearchOptions, SessionSearchResult, IndexedMessage } from './types';
import type { SessionIndexHook } from './chatHook';

export interface SessionIndexOpts {
  dbPath: string;
  conversations: IndexerDeps['conversations'];
  projects: IndexerDeps['projects'];
  adapterFor: IndexerDeps['adapterFor'];
  resolveUnixUser: IndexerDeps['resolveUnixUser'];
  readText: IndexerDeps['readText'];
  statFile: IndexerDeps['statFile'];
  now?: () => number;
  tickIntervalMs?: number;
}

export class SessionIndex implements SessionIndexHook {
  private readonly db: Db;
  private readonly indexer: Indexer;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SessionIndexOpts) {
    this.db = openSessionIndexDb(opts.dbPath);
    this.indexer = new Indexer({
      db: this.db,
      conversations: opts.conversations,
      projects: opts.projects,
      adapterFor: opts.adapterFor,
      resolveUnixUser: opts.resolveUnixUser,
      readText: opts.readText,
      statFile: opts.statFile,
      now: opts.now ?? Date.now,
    });
  }

  start(): void {
    try {
      this.indexer.startupSweep();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[sessionIndex] startupSweep 失败:', e instanceof Error ? e.message : e);
    }
    const interval = this.opts.tickIntervalMs ?? 60_000;
    this.timer = setInterval(() => {
      try {
        this.indexer.onTick();
      } catch {
        /* skip,下 tick 再试 */
      }
    }, interval);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  onMessage(sessionKey: string, msg: IndexedMessage): void {
    try {
      this.indexer.onMessage(sessionKey, msg);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[sessionIndex] onMessage 失败:', e instanceof Error ? e.message : e);
    }
  }

  reindexOne(projectId: string, convId: string): void {
    this.indexer.reindexOne(projectId, convId);
  }

  search(opts: SearchOptions, namespaceId: string): SessionSearchResult[] {
    return searchSessions(this.db, opts, namespaceId);
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.db.close();
  }
}

export type { SessionIndexHook } from './chatHook';
export type { IndexedMessage, IndexedSession, SearchOptions, SessionSearchResult } from './types';
