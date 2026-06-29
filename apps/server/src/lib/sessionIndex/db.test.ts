import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openSessionIndexDb } from './db';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rcc-sessionidx-'));
}

describe('openSessionIndexDb', () => {
  it('在新路径上创建 sqlite + 建好所有表', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'sessionIndex.db');
    const db = openSessionIndexDb(dbPath);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('session');
      expect(names).toContain('message');
      expect(names).toContain('session_summary');
      expect(names).toContain('meta');
      // FTS5 虚表也算 table
      expect(names).toContain('message_fts');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重复 open 不报错(幂等);schema_version 写入 meta', () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'sessionIndex.db');
    openSessionIndexDb(dbPath).close();
    const db = openSessionIndexDb(dbPath);
    try {
      const row = db
        .prepare("SELECT value FROM meta WHERE key='schema_version'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe('1');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('namespace_id 列存在;按 namespace 过滤可用', () => {
    const dir = tmpDir();
    const db = openSessionIndexDb(join(dir, 'sessionIndex.db'));
    try {
      db.prepare(
        `INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, transcript_mtime_ms, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
      ).run('p1:c1', 'c1', 'p1', 'ns-A', 'alice', 'claude', 'uuid-1', 'one', '2026-06-29T00:00:00Z', Date.now());
      db.prepare(
        `INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, transcript_mtime_ms, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
      ).run('p1:c2', 'c2', 'p1', 'ns-B', 'bob', 'claude', 'uuid-2', 'two', '2026-06-29T00:00:00Z', Date.now());
      const rows = db.prepare('SELECT name FROM session WHERE namespace_id=? ORDER BY name').all('ns-A') as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(['one']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FTS5 触发器:INSERT message 自动同步到 message_fts(中文兼容)', () => {
    const dir = tmpDir();
    const db = openSessionIndexDb(join(dir, 'sessionIndex.db'));
    try {
      db.prepare(
        `INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, transcript_mtime_ms, indexed_at)
         VALUES ('k','c','p','ns','u','claude','sid','n',0,'2026-06-29T00:00:00Z',0,0)`,
      ).run();
      db.prepare(
        `INSERT INTO message (session_key, msg_index, role, ts, content) VALUES ('k', 0, 'user', '2026-06-29T00:00:01Z', '帮我修一个字体问题')`,
      ).run();
      // FTS5 用 expand_cjk 把中文每字加空格存进去;搜索时 query 也走 phrase 包裹
      const rows = db
        .prepare("SELECT session_key FROM message_fts WHERE message_fts MATCH ?")
        .all('"字 体"') as Array<{ session_key: string }>;
      expect(rows.map((r) => r.session_key)).toEqual(['k']);
      // 单字也能命中
      const rows2 = db
        .prepare("SELECT session_key FROM message_fts WHERE message_fts MATCH ?")
        .all('"字"') as Array<{ session_key: string }>;
      expect(rows2.map((r) => r.session_key)).toEqual(['k']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
