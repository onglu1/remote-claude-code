import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSessionIndexDb, type Db } from './db';
import { Indexer } from './indexer';
import type { AgentAdapter } from '../session/chat/agent/adapter';

function fakeAdapter(
  parsedFor: Record<string, Array<{ role: 'user' | 'assistant'; ts: string; content: string }>>,
  locateOverride?: (sid: string) => string | null,
): AgentAdapter {
  return {
    kind: 'claude',
    capabilities: { effort: true, askHook: true, hud: true, rewind: true, presetSessionId: true, paneRunningSignal: true },
    buildLaunchCmd: () => 'noop',
    buildResumeCmd: () => 'noop',
    locateTranscript: (sid: string) =>
      locateOverride ? locateOverride(sid) : (parsedFor[sid] ? `/fake/${sid}.jsonl` : null),
    makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {} }),
    discoverSessionId: async () => null,
    parseToolUseEvents: () => [],
    parseTranscriptText: (_text, sid) => parsedFor[sid] ?? [],
  };
}

interface FakeCtx {
  dir: string;
  db: Db;
  cleanup: () => void;
}

function makeCtx(): FakeCtx {
  const dir = mkdtempSync(join(tmpdir(), 'rcc-idx-'));
  const dbPath = join(dir, 'sessionIndex.db');
  const db = openSessionIndexDb(dbPath);
  return {
    dir,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('Indexer.reindexOne', () => {
  it('从 adapter.parseTranscriptText 拿消息 → 写 session + message 行', () => {
    const { dir, db, cleanup } = makeCtx();
    try {
      const jsonlPath = join(dir, 'sid-1.jsonl');
      writeFileSync(jsonlPath, 'fake content');
      const adapter = fakeAdapter(
        {
          'sid-1': [
            { role: 'user', ts: '2026-06-29T00:00:01Z', content: '帮我修个 bug' },
            { role: 'assistant', ts: '2026-06-29T00:00:02Z', content: '请描述一下' },
          ],
        },
        () => jsonlPath,
      );
      const indexer = new Indexer({
        db,
        conversations: {
          listAll: () => [
            {
              id: 'c1',
              projectId: 'p1',
              name: 'Session 1',
              sessionId: 'sid-1',
              agentKind: 'claude',
              starred: false,
              createdAt: '2026-06-29T00:00:00Z',
              lastActivityAt: '2026-06-29T00:01:00Z',
            },
          ],
        },
        projects: {
          get: (id) => (id === 'p1' ? { id: 'p1', ownerId: 'ns-A', path: '/tmp' } : undefined),
        },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'alice',
        readText: () => 'fake content',
        statFile: () => ({ mtimeMs: 1000 }),
        now: () => 5000,
      });
      indexer.reindexOne('p1', 'c1');

      const sessionRow = db
        .prepare('SELECT * FROM session WHERE session_key=?')
        .get('p1:c1') as Record<string, unknown>;
      expect(sessionRow).toMatchObject({
        session_key: 'p1:c1',
        conv_id: 'c1',
        project_id: 'p1',
        namespace_id: 'ns-A',
        unix_user: 'alice',
        agent_kind: 'claude',
        name: 'Session 1',
        message_count: 2,
        first_user_message: '帮我修个 bug',
        last_assistant_message: '请描述一下',
        transcript_mtime_ms: 1000,
      });

      const messages = db
        .prepare('SELECT role, content FROM message WHERE session_key=? ORDER BY msg_index')
        .all('p1:c1') as Array<Record<string, unknown>>;
      expect(messages.length).toBe(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: '帮我修个 bug' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: '请描述一下' });
    } finally {
      cleanup();
    }
  });

  it('mtime 未变 → 只更新元数据(name/starred),不重 parse', () => {
    const { db, cleanup } = makeCtx();
    try {
      const adapter = fakeAdapter(
        { 'sid-1': [{ role: 'user', ts: 't', content: 'one' }] },
        () => '/fake/sid-1.jsonl',
      );
      let parseCalls = 0;
      const origParse = adapter.parseTranscriptText;
      adapter.parseTranscriptText = (...a) => {
        parseCalls += 1;
        return origParse(...a);
      };

      let convName = 'old';
      let convStarred = false;
      const indexer = new Indexer({
        db,
        conversations: {
          listAll: () => [
            {
              id: 'c1',
              projectId: 'p1',
              name: convName,
              sessionId: 'sid-1',
              agentKind: 'claude',
              starred: convStarred,
              createdAt: '2026-06-29T00:00:00Z',
            },
          ],
        },
        projects: { get: () => ({ id: 'p1', ownerId: 'ns-A', path: '/tmp' }) },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'alice',
        readText: () => 'text',
        statFile: () => ({ mtimeMs: 1000 }),
        now: () => 5000,
      });
      indexer.reindexOne('p1', 'c1');
      convName = 'new';
      convStarred = true;
      indexer.reindexOne('p1', 'c1');
      expect(parseCalls).toBe(1);  // 第二次 mtime 一样,没再 parse
      const row = db.prepare('SELECT name, starred FROM session WHERE session_key=?').get('p1:c1') as { name: string; starred: number };
      expect(row.name).toBe('new');  // 元数据更新生效
      expect(row.starred).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('transcript 不存在(locateTranscript 返 null) → 写元数据 + 0 消息,不报错', () => {
    const { db, cleanup } = makeCtx();
    try {
      const adapter = fakeAdapter({}, () => null);
      const indexer = new Indexer({
        db,
        conversations: {
          listAll: () => [
            {
              id: 'c1',
              projectId: 'p1',
              name: 'one',
              sessionId: 'sid-1',
              agentKind: 'claude',
              starred: false,
              createdAt: '2026-06-29T00:00:00Z',
            },
          ],
        },
        projects: { get: () => ({ id: 'p1', ownerId: 'ns-A', path: '/tmp' }) },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'alice',
        readText: () => '',
        statFile: () => null,
        now: () => 5000,
      });
      indexer.reindexOne('p1', 'c1');
      const row = db
        .prepare('SELECT message_count, transcript_path FROM session WHERE session_key=?')
        .get('p1:c1') as { message_count: number; transcript_path: string | null };
      expect(row.message_count).toBe(0);
      expect(row.transcript_path).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('readText 抛错 → log + 0 消息;不破坏 db', () => {
    const { db, cleanup } = makeCtx();
    try {
      const adapter = fakeAdapter({}, () => '/fake/sid-1.jsonl');
      const indexer = new Indexer({
        db,
        conversations: {
          listAll: () => [
            { id: 'c1', projectId: 'p1', name: 'one', sessionId: 'sid-1', agentKind: 'claude', starred: false, createdAt: '2026-06-29T00:00:00Z' },
          ],
        },
        projects: { get: () => ({ id: 'p1', ownerId: 'ns-A', path: '/tmp' }) },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'alice',
        readText: () => {
          throw new Error('EACCES');
        },
        statFile: () => ({ mtimeMs: 1000 }),
        now: () => 5000,
      });
      indexer.reindexOne('p1', 'c1');  // 不抛
      const row = db
        .prepare('SELECT message_count FROM session WHERE session_key=?')
        .get('p1:c1') as { message_count: number };
      expect(row.message_count).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('Indexer.startupSweep', () => {
  it('遍历 conversations.listAll 调 reindexOne', () => {
    const { db, cleanup } = makeCtx();
    try {
      const adapter = fakeAdapter({}, () => null);
      const indexer = new Indexer({
        db,
        conversations: {
          listAll: () => [
            { id: 'c1', projectId: 'p1', name: 'one', sessionId: 'sid-1', agentKind: 'claude', starred: false, createdAt: '2026-06-29T00:00:00Z' },
            { id: 'c2', projectId: 'p1', name: 'two', sessionId: 'sid-2', agentKind: 'codex', starred: false, createdAt: '2026-06-29T00:00:00Z' },
          ],
        },
        projects: { get: () => ({ id: 'p1', ownerId: 'ns-A', path: '/tmp' }) },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'alice',
        readText: () => '',
        statFile: () => null,
        now: () => 5000,
      });
      indexer.startupSweep();
      const rows = db
        .prepare('SELECT session_key FROM session ORDER BY session_key')
        .all() as Array<{ session_key: string }>;
      expect(rows.map((r) => r.session_key)).toEqual(['p1:c1', 'p1:c2']);
    } finally {
      cleanup();
    }
  });
});

describe('Indexer.onMessage', () => {
  it('inline 推送 → 写 message + 累加 message_count', () => {
    const { db, cleanup } = makeCtx();
    try {
      // 先建一条空 session 行
      db.prepare(
        `INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, transcript_mtime_ms, indexed_at)
         VALUES ('p1:c1','c1','p1','ns-A','alice','claude','sid','Sess',0,'2026-06-29T00:00:00Z',0,0)`,
      ).run();
      const adapter = fakeAdapter({}, () => null);
      const indexer = new Indexer({
        db,
        conversations: { listAll: () => [] },
        projects: { get: () => undefined },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'svc',
        readText: () => '',
        statFile: () => null,
        now: () => 10_000,
      });
      indexer.onMessage('p1:c1', { sessionKey: 'p1:c1', msgIndex: 0, role: 'user', ts: 't1', content: '你好' });
      indexer.onMessage('p1:c1', { sessionKey: 'p1:c1', msgIndex: 1, role: 'assistant', ts: 't2', content: '在' });
      const session = db.prepare('SELECT message_count, last_user_message, last_assistant_message FROM session WHERE session_key=?').get('p1:c1') as Record<string, unknown>;
      expect(session.message_count).toBe(2);
      expect(session.last_user_message).toBe('你好');
      expect(session.last_assistant_message).toBe('在');
      const msgs = db.prepare('SELECT role, content FROM message WHERE session_key=? ORDER BY msg_index').all('p1:c1') as Array<Record<string, unknown>>;
      expect(msgs).toEqual([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在' },
      ]);
    } finally {
      cleanup();
    }
  });

  it('session 不存在 → 静默跳过(不写 message 表)', () => {
    const { db, cleanup } = makeCtx();
    try {
      const adapter = fakeAdapter({}, () => null);
      const indexer = new Indexer({
        db,
        conversations: { listAll: () => [] },
        projects: { get: () => undefined },
        adapterFor: () => adapter,
        resolveUnixUser: () => 'svc',
        readText: () => '',
        statFile: () => null,
        now: () => 10_000,
      });
      indexer.onMessage('nope:c1', { sessionKey: 'nope:c1', msgIndex: 0, role: 'user', ts: 't', content: 'x' });
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number };
      expect(cnt.n).toBe(0);
    } finally {
      cleanup();
    }
  });
});
