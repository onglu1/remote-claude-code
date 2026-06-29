/**
 * SessionIndex 的 SQLite 连接 + schema migration。
 * 用 Node 22 内置 `node:sqlite`,零原生依赖。
 *
 * Node 22.22 时 node:sqlite 仍是 experimental(发 stderr ExperimentalWarning),
 * 功能稳定可用,FTS5 已支持。Node 23+ 转 stable 后无需任何改动。
 *
 * schema 版本号写在 meta 表;后续加表/列时:
 *   1) 在 SCHEMA_STATEMENTS 末尾加 CREATE/ALTER 语句
 *   2) MIGRATIONS 数组(暂未引入)追加一个 fn(db, from) → to 函数
 *   3) 把 SCHEMA_VERSION bump
 */
// Node 22 的 node:sqlite 是 ESM builtin,但 vitest/vite 的 module resolver 在 2.x 不识别
// `import from 'node:sqlite'`(误把 'node:sqlite' 解析成 'sqlite' 找不到)。
// 项目内 codexTranscript / metrics 已用同款 createRequire 模式 require builtin,沿用之。
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

export type Db = DatabaseSyncType;

const SCHEMA_VERSION = 1;

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS session (
     session_key            TEXT PRIMARY KEY,
     conv_id                TEXT NOT NULL,
     project_id             TEXT NOT NULL,
     namespace_id           TEXT NOT NULL,
     unix_user              TEXT NOT NULL,
     agent_kind             TEXT NOT NULL,
     session_id             TEXT NOT NULL,
     name                   TEXT NOT NULL,
     folder_id              TEXT,
     starred                INTEGER NOT NULL DEFAULT 0,
     created_at             TEXT NOT NULL,
     last_activity_at       TEXT,
     closed_at              TEXT,
     deleted_at             TEXT,
     first_user_message     TEXT,
     last_user_message      TEXT,
     last_assistant_message TEXT,
     message_count          INTEGER NOT NULL DEFAULT 0,
     transcript_path        TEXT,
     transcript_mtime_ms    INTEGER NOT NULL DEFAULT 0,
     indexed_at             INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_session_namespace ON session(namespace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_project   ON session(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_activity  ON session(last_activity_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_agent     ON session(agent_kind)`,

  `CREATE TABLE IF NOT EXISTS message (
     session_key TEXT NOT NULL,
     msg_index   INTEGER NOT NULL,
     role        TEXT NOT NULL,
     ts          TEXT NOT NULL,
     content     TEXT NOT NULL,
     PRIMARY KEY (session_key, msg_index),
     FOREIGN KEY (session_key) REFERENCES session(session_key) ON DELETE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_key)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
     content,
     session_key UNINDEXED,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,

  `CREATE TRIGGER IF NOT EXISTS message_ai AFTER INSERT ON message BEGIN
     INSERT INTO message_fts(rowid, content, session_key)
     VALUES (new.rowid, new.content, new.session_key);
   END`,
  `CREATE TRIGGER IF NOT EXISTS message_ad AFTER DELETE ON message BEGIN
     INSERT INTO message_fts(message_fts, rowid, content, session_key)
     VALUES ('delete', old.rowid, old.content, old.session_key);
   END`,
  `CREATE TRIGGER IF NOT EXISTS message_au AFTER UPDATE ON message BEGIN
     INSERT INTO message_fts(message_fts, rowid, content, session_key)
     VALUES ('delete', old.rowid, old.content, old.session_key);
     INSERT INTO message_fts(rowid, content, session_key)
     VALUES (new.rowid, new.content, new.session_key);
   END`,

  // 摘要表:本期建表不写,留给 ②(AI 摘要)
  `CREATE TABLE IF NOT EXISTS session_summary (
     session_key      TEXT PRIMARY KEY,
     summary          TEXT,
     tags             TEXT,
     suggested_title  TEXT,
     generated_at     INTEGER,
     source_mtime_ms  INTEGER,
     FOREIGN KEY (session_key) REFERENCES session(session_key) ON DELETE CASCADE
   )`,
];

export function openSessionIndexDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // WAL 提高并发读性能;主进程是唯一 writer
  if (dbPath !== ':memory:') db.exec(`PRAGMA journal_mode = WAL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
  return db;
}
