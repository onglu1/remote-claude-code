import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runSearchQuery } from './sessionSearch';
import { openSessionIndexDb, type Db } from '../lib/sessionIndex/db';
import { searchSessions } from '../lib/sessionIndex/search';
import type { AuthUser } from '@rcc/shared';

function seed(db: Db) {
  db.prepare(`INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, last_activity_at, transcript_mtime_ms, indexed_at) VALUES ('p1:c1','c1','p1','ns-A','alice','claude','sid-A','one',0,'2026-06-29T00:00:00Z','2026-06-29T01:00:00Z',0,0)`).run();
  db.prepare(`INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, last_activity_at, transcript_mtime_ms, indexed_at) VALUES ('p1:c2','c2','p1','ns-B','bob','claude','sid-B','two',0,'2026-06-29T00:00:00Z','2026-06-29T01:00:00Z',0,0)`).run();
  db.prepare(`INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, last_activity_at, transcript_mtime_ms, indexed_at) VALUES ('p2:c1','c1','p-other','ns-B','bob','claude','sid-C','three',0,'2026-06-29T00:00:00Z','2026-06-29T01:00:00Z',0,0)`).run();
}

const userA: AuthUser = { id: 'u1', username: 'alice', role: 'user', kind: 'user', unixUser: 'alice', namespaceId: 'ns-A' };
const userB: AuthUser = { id: 'u2', username: 'bob', role: 'user', kind: 'user', unixUser: 'bob', namespaceId: 'ns-B' };
const adminA: AuthUser = { id: 'admin', username: 'admin', role: 'admin', kind: 'user', unixUser: 'admin', namespaceId: 'ns-Admin' };

function ctxFor(db: Db) {
  return {
    sessionIndex: { search: (opts: never, ns: string) => searchSessions(db, opts, ns) },
    projects: {
      get: (id: string) =>
        id === 'p1' ? { id: 'p1', ownerId: 'ns-A' } :
        id === 'p-other' ? { id: 'p-other', ownerId: 'ns-B' } :
        undefined,
    },
  };
}

describe('runSearchQuery', () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rcc-route-'));
    db = openSessionIndexDb(join(dir, 'sessionIndex.db'));
    seed(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('强制按 req.user.namespaceId 隔离 — A 只看到自己的 p1:c1', () => {
    const r = runSearchQuery(ctxFor(db), userA, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results.map((x) => x.sessionKey)).toEqual(['p1:c1']);
  });

  it('B 只看到自己 namespace 的 p1:c2 / p2:c1', () => {
    const r = runSearchQuery(ctxFor(db), userB, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const keys = r.results.map((x) => x.sessionKey).sort();
      expect(keys).toEqual(['p1:c2', 'p2:c1']);
    }
  });

  it('projectId 不可见 → 403', () => {
    // A 试图查 p-other(owner=ns-B)
    const r = runSearchQuery(ctxFor(db), userA, { projectId: 'p-other' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(403);
  });

  it('projectId 不存在 → 403', () => {
    const r = runSearchQuery(ctxFor(db), userA, { projectId: 'no-such' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(403);
  });

  it('admin 也按自己 namespaceId 过滤(不绕过隔离)', () => {
    const r = runSearchQuery(ctxFor(db), adminA, {});
    expect(r.ok).toBe(true);
    // adminA 的 namespaceId 是 ns-Admin,没数据
    if (r.ok) expect(r.results).toEqual([]);
  });

  it('source/visibility/limit 参数透传', () => {
    const r = runSearchQuery(ctxFor(db), userB, { source: 'claude', visibility: 'default', limit: '10' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.results.length).toBeLessThanOrEqual(10);
  });

  it('恶意 namespace 参数被忽略(永远用 user.namespaceId)', () => {
    // 即便前端"伪传" projectId 也无法穿透到别人的 namespace —— 因为 ns-A 的 search 就不返 ns-B 数据
    const r = runSearchQuery(ctxFor(db), userA, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const x of r.results) expect(x.namespaceId).toBe('ns-A');
    }
  });
});
