/**
 * searchSessions:按 SearchOptions + namespaceId 查 sqlite,
 * 有 query 时走 FTS5;无 query 走 session 表 + last_activity_at 排序。
 *
 * **namespaceId 永远是必填**,路由层从 req.user.namespaceId 取,不接受前端传。
 */
import type { Db } from './db';
import type { IndexedSession, SearchOptions, SessionSearchResult } from './types';
import { toFtsMatchExpr, collapseCjkSpaces } from './cjkTokenize';

function rowToIndexed(row: Record<string, unknown>): IndexedSession {
  return {
    sessionKey: String(row.session_key),
    convId: String(row.conv_id),
    projectId: String(row.project_id),
    namespaceId: String(row.namespace_id),
    unixUser: String(row.unix_user),
    agentKind: row.agent_kind as IndexedSession['agentKind'],
    sessionId: String(row.session_id),
    name: String(row.name),
    folderId: row.folder_id == null ? null : String(row.folder_id),
    starred: Number(row.starred) === 1,
    createdAt: String(row.created_at),
    lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    deletedAt: row.deleted_at == null ? null : String(row.deleted_at),
    firstUserMessage: row.first_user_message == null ? null : String(row.first_user_message),
    lastUserMessage: row.last_user_message == null ? null : String(row.last_user_message),
    lastAssistantMessage: row.last_assistant_message == null ? null : String(row.last_assistant_message),
    messageCount: Number(row.message_count),
    transcriptPath: row.transcript_path == null ? null : String(row.transcript_path),
    transcriptMtimeMs: Number(row.transcript_mtime_ms),
    indexedAt: Number(row.indexed_at),
  };
}

function visibilityClause(visibility?: SearchOptions['visibility']): string {
  switch (visibility) {
    case 'starred':
      return 's.starred = 1 AND s.deleted_at IS NULL';
    case 'closed':
      return 's.closed_at IS NOT NULL AND s.deleted_at IS NULL';
    case 'deleted':
      return 's.deleted_at IS NOT NULL';
    case 'all':
      return '1=1';
    case 'default':
    default:
      return 's.deleted_at IS NULL AND s.closed_at IS NULL';
  }
}

export function searchSessions(
  db: Db,
  opts: SearchOptions,
  namespaceId: string,
): SessionSearchResult[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const filters: string[] = ['s.namespace_id = ?'];
  const args: Array<string | number | null> = [namespaceId];
  if (opts.projectId) {
    filters.push('s.project_id = ?');
    args.push(opts.projectId);
  }
  if (opts.source && opts.source !== 'all') {
    filters.push('s.agent_kind = ?');
    args.push(opts.source);
  }
  if (opts.folderId !== undefined) {
    if (opts.folderId === null) filters.push('s.folder_id IS NULL');
    else {
      filters.push('s.folder_id = ?');
      args.push(opts.folderId);
    }
  }
  filters.push(visibilityClause(opts.visibility));

  if (opts.query && opts.query.trim()) {
    // FTS5 走 message_fts;命中后回 session 做元数据 + namespace 二次过滤
    const sql = `
      SELECT s.*,
             snippet(message_fts, 0, '<mark>', '</mark>', '…', 16) AS snippet,
             bm25(message_fts) AS rank
      FROM message_fts
      JOIN session s ON s.session_key = message_fts.session_key
      WHERE message_fts MATCH ?
        AND ${filters.join(' AND ')}
      ORDER BY rank
      LIMIT ?
    `;
    // query 走 expandCjk + phrase 包裹(中文兼容);FTS5 命中后 snippet 还原 CJK 间空格。
    const ftsExpr = toFtsMatchExpr(opts.query);
    const rows = db.prepare(sql).all(ftsExpr, ...args, limit) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    const out: SessionSearchResult[] = [];
    for (const r of rows) {
      const key = String(r.session_key);
      if (seen.has(key)) continue;  // 同一会话多条消息命中,只保留 rank 最高的(SQL 已按 rank 排)
      seen.add(key);
      out.push({
        ...rowToIndexed(r),
        matchSnippet: r.snippet == null ? null : collapseCjkSpaces(String(r.snippet)),
        rank: Number(r.rank),
      });
    }
    return out;
  }

  // 无 query:按 last_activity_at DESC 排
  const sql = `
    SELECT s.*
    FROM session s
    WHERE ${filters.join(' AND ')}
    ORDER BY COALESCE(s.last_activity_at, s.created_at) DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...args, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...rowToIndexed(r), matchSnippet: null, rank: 0 }));
}
