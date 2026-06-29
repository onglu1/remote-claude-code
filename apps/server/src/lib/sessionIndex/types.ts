/**
 * SessionIndex 公共类型。db.ts/parser.ts/indexer.ts/search.ts 共用。
 * 字段命名:TS 驼峰、SQLite 下划线,转换集中在 search.ts(rowToIndexed)。
 */
import type { AgentKind } from '@rcc/shared';

export interface IndexedSession {
  sessionKey: string;            // = `${projectId}:${convId}`(与 conversationRuntimeKey 同形)
  convId: string;
  projectId: string;
  namespaceId: string;            // = Project.ownerId(隔离根据)
  unixUser: string;
  agentKind: AgentKind;
  sessionId: string;              // agent 的 session UUID
  name: string;                   // Conversation.name
  folderId: string | null;
  starred: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  closedAt: string | null;
  deletedAt: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastAssistantMessage: string | null;
  messageCount: number;
  transcriptPath: string | null;
  transcriptMtimeMs: number;
  indexedAt: number;
}

export interface IndexedMessage {
  sessionKey: string;
  msgIndex: number;
  role: 'user' | 'assistant';
  ts: string;
  content: string;
}

export interface SearchOptions {
  query?: string;
  projectId?: string;
  source?: 'all' | 'claude' | 'codex';
  visibility?: 'default' | 'starred' | 'closed' | 'deleted';
  folderId?: string | null;
  limit?: number;
}

export interface SessionSearchResult extends IndexedSession {
  matchSnippet: string | null;
  rank: number;
}
