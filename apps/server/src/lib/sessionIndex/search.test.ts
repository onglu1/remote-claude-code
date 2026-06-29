import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openSessionIndexDb, type Db } from './db';
import { searchSessions } from './search';

interface SeedOpts {
  key: string;
  ns: string;
  project: string;
  name: string;
  agent?: 'claude' | 'codex';
  activity?: string;
  closed?: boolean;
  deleted?: boolean;
  starred?: boolean;
}

function insertSession(db: Db, opts: SeedOpts) {
  db.prepare(
    `INSERT INTO session (
       session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name,
       starred, created_at, last_activity_at, closed_at, deleted_at, message_count, transcript_mtime_ms, indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
  ).run(
    opts.key,
    opts.key.split(':')[1],
    opts.project,
    opts.ns,
    'alice',
    opts.agent ?? 'claude',
    'sid-' + opts.key,
    opts.name,
    opts.starred ? 1 : 0,
    '2026-06-29T00:00:00Z',
    opts.activity ?? null,
    opts.closed ? '2026-06-29T01:00:00Z' : null,
    opts.deleted ? '2026-06-29T02:00:00Z' : null,
  );
}

function insertMessage(db: Db, key: string, idx: number, content: string, role: 'user' | 'assistant' = 'user') {
  db.prepare('INSERT INTO message (session_key, msg_index, role, ts, content) VALUES (?, ?, ?, ?, ?)').run(
    key,
    idx,
    role,
    '2026-06-29T00:00:01Z',
    content,
  );
}

function seed(db: Db) {
  insertSession(db, { key: 'p1:c1', ns: 'A', project: 'p1', name: 'one', activity: '2026-06-29T01:00:00Z' });
  insertSession(db, { key: 'p1:c2', ns: 'B', project: 'p1', name: 'two', activity: '2026-06-29T02:00:00Z' });
  insertSession(db, { key: 'p2:c1', ns: 'A', project: 'p2', name: 'three', agent: 'codex', activity: '2026-06-29T03:00:00Z' });
  insertSession(db, { key: 'p1:c3', ns: 'A', project: 'p1', name: 'closed', activity: '2026-06-29T00:30:00Z', closed: true });
  insertSession(db, { key: 'p1:c4', ns: 'A', project: 'p1', name: 'deleted', activity: '2026-06-29T00:30:00Z', deleted: true });
  insertSession(db, { key: 'p1:c5', ns: 'A', project: 'p1', name: 'starred', starred: true, activity: '2026-06-29T00:30:00Z' });
  insertMessage(db, 'p1:c1', 0, '我在搞统一字体的问题');
  insertMessage(db, 'p1:c2', 0, '这条不属于 A namespace');
  insertMessage(db, 'p2:c1', 0, '统一字体也出现在 p2');
}

describe('searchSessions', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rcc-search-'));
    db = openSessionIndexDb(join(dir, 'sessionIndex.db'));
    seed(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('严格按 namespaceId 隔离 — A 看不到 B 的 p1:c2', () => {
    const out = searchSessions(db, {}, 'A');
    const keys = out.map((r) => r.sessionKey);
    expect(keys).not.toContain('p1:c2');
    expect(keys).toContain('p1:c1');
  });

  it('无 query 默认 visibility=default,排除 closed/deleted', () => {
    const out = searchSessions(db, {}, 'A');
    const keys = out.map((r) => r.sessionKey);
    expect(keys).not.toContain('p1:c3');  // closed
    expect(keys).not.toContain('p1:c4');  // deleted
  });

  it('visibility=closed 命中 closed', () => {
    const out = searchSessions(db, { visibility: 'closed' }, 'A');
    expect(out.map((r) => r.sessionKey)).toContain('p1:c3');
  });

  it('visibility=deleted 命中 deleted', () => {
    const out = searchSessions(db, { visibility: 'deleted' }, 'A');
    expect(out.map((r) => r.sessionKey)).toContain('p1:c4');
  });

  it('visibility=starred 仅命中 starred', () => {
    const out = searchSessions(db, { visibility: 'starred' }, 'A');
    expect(out.map((r) => r.sessionKey)).toEqual(['p1:c5']);
  });

  it('projectId 缩小到指定项目', () => {
    const out = searchSessions(db, { projectId: 'p2' }, 'A');
    expect(out.map((r) => r.sessionKey)).toEqual(['p2:c1']);
  });

  it('source=codex 只命中 codex', () => {
    const out = searchSessions(db, { source: 'codex' }, 'A');
    expect(out.every((r) => r.agentKind === 'codex')).toBe(true);
  });

  it('query 走 FTS5 命中正文,带 matchSnippet', () => {
    const out = searchSessions(db, { query: '字体' }, 'A');
    const keys = out.map((r) => r.sessionKey);
    expect(keys).toContain('p1:c1');
    expect(keys).toContain('p2:c1');
    expect(keys).not.toContain('p1:c2');  // namespace 不同
    expect(out[0].matchSnippet).toContain('字');
  });

  it('无 query 按 last_activity_at DESC 排', () => {
    const out = searchSessions(db, {}, 'A');
    expect(out[0].sessionKey).toBe('p2:c1');  // 03:00 最近
    expect(out[1].sessionKey).toBe('p1:c1');  // 01:00 次之
  });

  it('limit 截断', () => {
    expect(searchSessions(db, { limit: 1 }, 'A').length).toBe(1);
  });
});
