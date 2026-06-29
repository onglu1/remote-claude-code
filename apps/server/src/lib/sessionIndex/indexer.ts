/**
 * Indexer:把 ConversationStore 已登记的会话索引到 sqlite。
 *
 * 三层防线:
 *   ① startupSweep(): server boot 时全扫一遍,补齐 mtime 变化的
 *   ② onMessage(): chatSession 跑期间新消息 inline 推送
 *   ③ onTick(): 节奏顺路扫"最近 1 小时活动过的"
 *
 * 不索引孤儿 transcript(MVP);namespace 100% 由 Project.ownerId 决定。
 * 跨 unixUser 读 transcript:复用 fs.readFileSync,失败单条 skip + log。
 */
import type { Db } from './db';
import type { IndexedMessage } from './types';
import { conversationRuntimeKey } from '../conversationIdentity';
import { parseTranscriptForIndex } from './parser';
import type { AgentAdapter } from '../session/chat/agent/adapter';
import type { AgentKind } from '@rcc/shared';

const PREVIEW_MAX = 200;
const ONTICK_ACTIVE_WINDOW_MS = 60 * 60 * 1000;  // 1 小时
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;   // 50MB 上限,超过跳过

interface ConvLike {
  id: string;
  projectId: string;
  name: string;
  sessionId: string;
  agentKind: AgentKind;
  starred: boolean;
  createdAt: string;
  lastActivityAt?: string;
  closedAt?: string;
  deletedAt?: string;
  folderId?: string | null;
}

interface ProjectLike {
  id: string;
  ownerId?: string;
  path: string;
}

export interface IndexerDeps {
  db: Db;
  conversations: {
    listAll: () => ConvLike[];
  };
  projects: {
    get: (id: string) => ProjectLike | undefined;
  };
  adapterFor: (kind: AgentKind) => AgentAdapter;
  resolveUnixUser: (ownerId: string | undefined) => string;
  /** 读 transcript 文件文本;失败应抛(indexer 自己 try/catch)。 */
  readText: (path: string) => string;
  /** stat 文件;不存在返 null。 */
  statFile: (path: string) => { mtimeMs: number; size?: number } | null;
  now: () => number;
}

function truncate(s: string | null | undefined, max = PREVIEW_MAX): string | null {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

export class Indexer {
  constructor(private readonly deps: IndexerDeps) {}

  /** 启动全扫:对所有 ConversationStore 登记会话调 reindexOne。单条失败不影响其他。 */
  startupSweep(): void {
    for (const c of this.deps.conversations.listAll()) {
      try {
        this.reindexOne(c.projectId, c.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sessionIndex] reindexOne 失败 ${c.projectId}:${c.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  /**
   * 增量校对:对 last_activity_at > now - 1h 的行 stat 一遍,mtime 变了重 parse。
   * IdleSweeper 节奏(每 60s)调用一次,扫的行数始终很小。
   */
  onTick(): void {
    const cutoff = new Date(this.deps.now() - ONTICK_ACTIVE_WINDOW_MS).toISOString();
    const rows = this.deps.db
      .prepare(
        `SELECT project_id, conv_id, transcript_path, transcript_mtime_ms
         FROM session
         WHERE last_activity_at IS NOT NULL AND last_activity_at > ?`,
      )
      .all(cutoff) as Array<{
        project_id: string;
        conv_id: string;
        transcript_path: string | null;
        transcript_mtime_ms: number;
      }>;
    for (const r of rows) {
      if (!r.transcript_path) continue;
      const st = this.deps.statFile(r.transcript_path);
      if (!st) continue;
      if (st.mtimeMs > r.transcript_mtime_ms) {
        try {
          this.reindexOne(r.project_id, r.conv_id);
        } catch {
          /* skip */
        }
      }
    }
  }

  /**
   * ChatSession inline 推送:对单条新主线消息 upsert 到 message 表 + bump session 元数据。
   * 会话还没被启动 sweep(空表) → 跳过(下次 sweep 全量补,避免 message 表悬空)。
   */
  onMessage(sessionKey: string, msg: IndexedMessage): void {
    const row = this.deps.db
      .prepare('SELECT message_count FROM session WHERE session_key=?')
      .get(sessionKey) as { message_count: number } | undefined;
    if (!row) return;
    const nextIdx = row.message_count;
    this.deps.db
      .prepare(
        `INSERT INTO message (session_key, msg_index, role, ts, content) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_key, msg_index) DO UPDATE SET role=excluded.role, ts=excluded.ts, content=excluded.content`,
      )
      .run(sessionKey, nextIdx, msg.role, msg.ts, msg.content);
    if (msg.role === 'user') {
      this.deps.db
        .prepare(
          `UPDATE session SET last_user_message=?, message_count=message_count+1, indexed_at=? WHERE session_key=?`,
        )
        .run(truncate(msg.content), this.deps.now(), sessionKey);
    } else {
      this.deps.db
        .prepare(
          `UPDATE session SET last_assistant_message=?, message_count=message_count+1, indexed_at=? WHERE session_key=?`,
        )
        .run(truncate(msg.content), this.deps.now(), sessionKey);
    }
  }

  /**
   * 重建单条会话索引(元数据 + 消息表)。事务保证原子。
   * mtime 未变 → 只更可变元数据(name/starred/closed/deleted/folder);不重 parse 消息。
   * transcript 文件缺/超大 → 写一行元数据 + 0 消息,不抛。
   */
  reindexOne(projectId: string, convId: string): void {
    const sessionKey = conversationRuntimeKey(projectId, convId);
    const conv = this.deps.conversations
      .listAll()
      .find((c) => c.projectId === projectId && c.id === convId);
    if (!conv) return;
    const project = this.deps.projects.get(projectId);
    const namespaceId = project?.ownerId ?? 'orphan';
    const unixUser = this.deps.resolveUnixUser(project?.ownerId);
    const adapter = this.deps.adapterFor(conv.agentKind);
    const cwd = project?.path ?? '';
    const transcriptPath = adapter.locateTranscript(conv.sessionId, unixUser, cwd);
    const st = transcriptPath ? this.deps.statFile(transcriptPath) : null;

    const existing = this.deps.db
      .prepare('SELECT transcript_mtime_ms FROM session WHERE session_key=?')
      .get(sessionKey) as { transcript_mtime_ms: number } | undefined;
    const mtimeChanged = !existing || (!!st && st.mtimeMs > existing.transcript_mtime_ms);

    let messages: IndexedMessage[] = [];
    let firstUser: string | null = null;
    let lastUser: string | null = null;
    let lastAssistant: string | null = null;
    let messageCount = 0;
    if (transcriptPath && st && mtimeChanged) {
      if (st.size !== undefined && st.size > MAX_TRANSCRIPT_BYTES) {
        // eslint-disable-next-line no-console
        console.warn(`[sessionIndex] transcript 过大跳过 ${transcriptPath} (${st.size} bytes)`);
      } else {
        try {
          const text = this.deps.readText(transcriptPath);
          messages = parseTranscriptForIndex(sessionKey, adapter, conv.sessionId, text);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(
            `[sessionIndex] readText 失败 ${transcriptPath}:`,
            e instanceof Error ? e.message : e,
          );
        }
        messageCount = messages.length;
        for (const m of messages) {
          if (m.role === 'user') {
            if (firstUser === null) firstUser = truncate(m.content);
            lastUser = truncate(m.content);
          } else {
            lastAssistant = truncate(m.content);
          }
        }
      }
    }

    const now = this.deps.now();
    const db = this.deps.db;
    db.exec('BEGIN');
    try {
      // 顺序:先 upsert session(保证 message.session_key FK 永远指向已存在 session 行),
      // 再 DELETE/INSERT message。若 session 是新建的,反过来 INSERT message 会 FK fail。
      if (existing) {
        if (mtimeChanged && transcriptPath && st) {
          db.prepare(
            `UPDATE session SET
               name=?, folder_id=?, starred=?, created_at=?, last_activity_at=?, closed_at=?, deleted_at=?,
               first_user_message=?, last_user_message=?, last_assistant_message=?, message_count=?,
               transcript_path=?, transcript_mtime_ms=?, indexed_at=?
             WHERE session_key=?`,
          ).run(
            conv.name,
            conv.folderId ?? null,
            conv.starred ? 1 : 0,
            conv.createdAt,
            conv.lastActivityAt ?? null,
            conv.closedAt ?? null,
            conv.deletedAt ?? null,
            firstUser,
            lastUser,
            lastAssistant,
            messageCount,
            transcriptPath,
            st.mtimeMs,
            now,
            sessionKey,
          );
        } else {
          // mtime 未变只更可变元数据(name/starred/closed/deleted/folder/activity)
          db.prepare(
            `UPDATE session SET
               name=?, folder_id=?, starred=?, last_activity_at=?, closed_at=?, deleted_at=?, indexed_at=?
             WHERE session_key=?`,
          ).run(
            conv.name,
            conv.folderId ?? null,
            conv.starred ? 1 : 0,
            conv.lastActivityAt ?? null,
            conv.closedAt ?? null,
            conv.deletedAt ?? null,
            now,
            sessionKey,
          );
        }
      } else {
        db.prepare(
          `INSERT INTO session (
             session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name,
             folder_id, starred, created_at, last_activity_at, closed_at, deleted_at,
             first_user_message, last_user_message, last_assistant_message, message_count,
             transcript_path, transcript_mtime_ms, indexed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sessionKey,
          conv.id,
          conv.projectId,
          namespaceId,
          unixUser,
          conv.agentKind,
          conv.sessionId,
          conv.name,
          conv.folderId ?? null,
          conv.starred ? 1 : 0,
          conv.createdAt,
          conv.lastActivityAt ?? null,
          conv.closedAt ?? null,
          conv.deletedAt ?? null,
          firstUser,
          lastUser,
          lastAssistant,
          messageCount,
          transcriptPath,
          st?.mtimeMs ?? 0,
          now,
        );
      }
      // 现在 session 行肯定存在了,可以安全 DELETE/INSERT message。
      // mtime 未变或无 transcript 时跳过(message 表不动)。
      if (mtimeChanged && transcriptPath && st) {
        db.prepare('DELETE FROM message WHERE session_key=?').run(sessionKey);
        const insertMsg = db.prepare(
          'INSERT INTO message (session_key, msg_index, role, ts, content) VALUES (?, ?, ?, ?, ?)',
        );
        for (const m of messages) {
          insertMsg.run(m.sessionKey, m.msgIndex, m.role, m.ts, m.content);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
