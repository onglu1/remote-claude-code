/**
 * 真机冒烟:验证 SessionIndex 端到端可用 + namespace 严格隔离。
 * 不依赖前端;直接用 SessionIndex.search,手塞两条不同 namespace 的会话/消息,
 * 跑 query/隔离/snippet 三档检验。
 *
 * 跑:`npx tsx apps/server/scripts/smoke-search.ts`
 */
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionIndex } from '../src/lib/sessionIndex';
import { openSessionIndexDb } from '../src/lib/sessionIndex/db';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'rcc-smoke-search-'));
  const dbPath = join(dir, 'sessionIndex.db');

  // 用 SessionIndex 持有连接(tickIntervalMs 给个大值避免后台 setInterval 跑)
  const index = new SessionIndex({
    dbPath,
    conversations: { listAll: () => [] },
    projects: { get: () => undefined },
    adapterFor: () =>
      ({
        kind: 'claude',
        capabilities: { effort: true, askHook: true, hud: true, rewind: true, presetSessionId: true },
        buildLaunchCmd: () => '',
        buildResumeCmd: () => '',
        locateTranscript: () => null,
        makeTranscriptTail: () => ({ activeChain: () => [], reset: () => {} }),
        discoverSessionId: async () => null,
        parseToolUseEvents: () => [],
        parseTranscriptText: () => [],
      }) as never,
    resolveUnixUser: () => 'svc',
    readText: () => '',
    statFile: () => null,
    tickIntervalMs: 1_000_000,
  });

  // 直接往 db 塞测试数据(走 SessionIndex 持有的连接);
  // 真实场景下这步由 Indexer.reindexOne 完成。
  const db = openSessionIndexDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO session (session_key, conv_id, project_id, namespace_id, unix_user, agent_kind, session_id, name, starred, created_at, last_activity_at, transcript_mtime_ms, indexed_at)
       VALUES ('p1:c1','c1','p1','ns-A','svc','claude','sid-A','调字体',0,'2026-06-29T00:00:00Z','2026-06-29T01:00:00Z',0,0)`,
    ).run();
    db.prepare(
      `INSERT INTO message (session_key, msg_index, role, ts, content) VALUES ('p1:c1', 0, 'user', '2026-06-29T00:00:01Z', '帮我把这个 docx 的字体统一改成黑体')`,
    ).run();
    db.prepare(
      `INSERT INTO message (session_key, msg_index, role, ts, content) VALUES ('p1:c1', 1, 'assistant', '2026-06-29T00:00:02Z', '好的,可以用 docx-editing skill 批量替换')`,
    ).run();
  } finally {
    db.close();
  }

  // 命中检验
  const hits = index.search({ query: '字体' }, 'ns-A');
  if (hits.length === 0) {
    console.error('[smoke-search] FAIL: 中文 query 无结果');
    process.exit(1);
  }
  if (!hits[0].matchSnippet || !hits[0].matchSnippet.includes('字')) {
    console.error('[smoke-search] FAIL: snippet 不含命中字符', hits[0]);
    process.exit(1);
  }
  console.log('[smoke-search] OK 中文查询命中:', {
    hit: hits[0].sessionKey,
    snippet: hits[0].matchSnippet,
  });

  // 隔离验证
  const wrongNs = index.search({ query: '字体' }, 'ns-B');
  if (wrongNs.length !== 0) {
    console.error('[smoke-search] FAIL: 跨 namespace 没隔离', wrongNs);
    process.exit(1);
  }
  console.log('[smoke-search] OK 跨 namespace 严格隔离');

  // 无 query 也走得通
  const all = index.search({}, 'ns-A');
  if (all.length !== 1) {
    console.error('[smoke-search] FAIL: 无 query 应返 1 条', all);
    process.exit(1);
  }
  console.log('[smoke-search] OK 无 query 走 last_activity_at 排序');

  // 英文也可用
  const en = index.search({ query: 'docx' }, 'ns-A');
  if (en.length !== 1) {
    console.error('[smoke-search] FAIL: 英文 query 应命中', en);
    process.exit(1);
  }
  console.log('[smoke-search] OK 英文查询命中');

  index.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('[smoke-search] ALL OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
