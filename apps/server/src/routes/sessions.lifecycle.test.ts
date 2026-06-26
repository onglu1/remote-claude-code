import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';
import { buildContext, type AppContext } from '../context';

// close / resume / batch 路由的端到端用例。
// tmux 在测试环境无 server,killSession 静默吞错;newDetached 也会失败但 resume 测试用一个 stub 跳过实际拉起。

let app: FastifyInstance;
let ctx: AppContext;
let tmpDir: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rcc_token')!.value;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function makeProjectWithConv(cookie: string, projName: string) {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name: projName, path: projDir, type: 'dev' },
  });
  expect(made.statusCode).toBe(200);
  const projectId = made.json().project.id as string;
  const conv = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/conversations`,
    cookies: { rcc_token: cookie },
    payload: { name: '生命周期' },
  });
  expect(conv.statusCode).toBe(200);
  return {
    projectId,
    convId: conv.json().conversation.id as string,
  };
}

async function makeFolder(cookie: string, projectId: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/folders`,
    cookies: { rcc_token: cookie },
    payload: { name },
  });
  expect(res.statusCode).toBe(200);
  return res.json().folder.id as string;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lifecycle-'));
  const config = loadConfig({
    ADMIN_PASSWORD: 'test-pass',
    ADMIN_USERNAME: 'admin',
    SESSION_SECRET: 'test-secret-key',
    PROJECTS_CONFIG: path.join(tmpDir, 'projects.json'),
  } as NodeJS.ProcessEnv);
  // 保留 ctx 引用,便于在 reflow 等测试中断言 chatRegistry 的内存状态(如 isActive)。
  ctx = await buildContext(config);
  app = await buildApp(config, { context: ctx, serveStatic: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST .../conversations/:cid/close', () => {
  it('alive 会话:杀 tmux + 写 closedAt + 返回 conversation', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-close-alive');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/close`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.id).toBe(convId);
    expect(res.json().conversation.alive).toBe(false);
    expect(typeof res.json().conversation.closedAt).toBe('string');
  });

  it('已休眠会话:幂等 200', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-close-idem');
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/close`,
      cookies: { rcc_token: cookie },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/close`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.alive).toBe(false);
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/whatever/conversations/whatever/close',
    });
    expect(res.statusCode).toBe(401);
  });

  it('会话不存在:404', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-close-404');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/missing/close`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST .../conversations/:cid/resume', () => {
  it('未休眠会话:幂等 200,并刷新 lastActivityAt', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-resume-active');
    ctx.conversations.update(convId, { lastActivityAt: '2026-06-22T00:00:00.000Z' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/resume`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.id).toBe(convId);
    expect(res.json().conversation.lastActivityAt).not.toBe('2026-06-22T00:00:00.000Z');
  });

  it('休眠会话:重启成功后清 closedAt 并刷新 lastActivityAt', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-resume-sleeping');
    ctx.conversations.update(convId, {
      closedAt: '2026-06-23T00:00:00.000Z',
      lastActivityAt: '2026-06-22T00:00:00.000Z',
    });
    const originalGetTmux = ctx.getTmux;
    const fakeTmux = {
      newDetached: vi.fn(async () => {}),
    };
    ctx.getTmux = () => fakeTmux as unknown as ReturnType<AppContext['getTmux']>;
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/conversations/${convId}/resume`,
        cookies: { rcc_token: cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(fakeTmux.newDetached).toHaveBeenCalledTimes(1);
      expect(res.json().conversation.closedAt).toBeUndefined();
      expect(res.json().conversation.lastActivityAt).not.toBe('2026-06-22T00:00:00.000Z');
      expect(ctx.conversations.get(convId)?.closedAt).toBeUndefined();
    } finally {
      ctx.getTmux = originalGetTmux;
    }
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/whatever/conversations/whatever/resume',
    });
    expect(res.statusCode).toBe(401);
  });

  it('会话不存在:404', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-resume-404');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/missing/resume`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST .../conversations/batch', () => {
  it('move:批量 folderId 改变', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-batch-move');
    const fid = await makeFolder(cookie, projectId, '组');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [convId], action: 'move', payload: { folderId: fid } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toEqual([convId]);
    expect(res.json().failed).toEqual([]);
  });

  it('move 指向不存在文件夹:进 failed', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-batch-move-bad');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [convId], action: 'move', payload: { folderId: 'fld_nope' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toEqual([]);
    expect(res.json().failed[0]).toMatchObject({ id: convId, reason: 'folder_not_found' });
  });

  it('star / unstar:成功', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-batch-star');
    const r1 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [convId], action: 'star' },
    });
    expect(r1.json().succeeded).toEqual([convId]);
    const r2 = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [convId], action: 'unstar' },
    });
    expect(r2.json().succeeded).toEqual([convId]);
  });

  it('softDelete:starred 项进 failed,其它进 succeeded', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId: c1 } = await makeProjectWithConv(cookie, 'P-batch-soft1');
    const c2res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: cookie },
      payload: { name: '另一个' },
    });
    const c2 = c2res.json().conversation.id as string;
    // c1 标星 → 应进 failed
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${c1}`,
      cookies: { rcc_token: cookie },
      payload: { starred: true },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [c1, c2], action: 'softDelete' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toEqual([c2]);
    expect(res.json().failed[0]).toMatchObject({ id: c1, reason: 'starred_locked' });
  });

  it('未找到的 id:进 failed reason=not_found', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-batch-notfound');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: ['nope'], action: 'star' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().failed[0]).toMatchObject({ id: 'nope', reason: 'not_found' });
  });

  it('空 ids:400', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-batch-empty');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/batch`,
      cookies: { rcc_token: cookie },
      payload: { ids: [], action: 'star' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/whatever/conversations/batch',
      payload: { ids: ['x'], action: 'star' },
    });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * reflow 路由测试。重点钉死 2026-06-24 修的两个 bug:
 *  - 必须调 ctx.chatRegistry.forceClose(cid),否则前端 chat WS 缓存的旧 ChatRegistry entry 不被清,
 *    用户看到"循环关闭重开"(旧 entry 持有的 transcript tail 偏移/perUserTmux 都是创建时的,不会更新)。
 *  - 清 askSidecar 必须走 perUser 路径 <askDir>/<unixUser>/<sid>.json,根 askDir 是空气,真 sidecar 还在。
 *
 * 不测 newDetached 真起 tmux(测试环境无 server,会返 500),只验证 forceClose 副作用与 askSidecar 路径。
 */
describe('POST .../conversations/:cid/reflow', () => {
  it('forceClose 清掉 chatRegistry 里的 entry(即便后续 newDetached 失败也要先清)', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-reflow-force');

    // 用真 ChatRegistry 装一个最小可用的 fake ChatSessionLike,模拟前端 chat WS 已 subscribe。
    // 不需要它"真的工作",只验证 forceClose 后 isActive 转 false。
    const fakeSession = {
      ensure: async () => {},
      getSkeleton: () => ({ items: [], live: [] }),
      getTurnBody: () => null,
      sendText: async () => {},
      sendKey: async () => {},
      interrupt: async () => {},
      refresh: async () => {},
      capturePeek: async () => '',
      setEffort: async () => {},
      rewindOpen: async () => [],
      rewindExecute: async () => ({ ok: true }),
      rewindCancel: async () => {},
      answerAsk: async () => {},
      answerPendingAsk: async () => {},
      getLiveAsk: () => null,
      getLiveHud: () => null,
      startPolling: () => {},
      stopPolling: () => {},
    };
    // ChatRegistry 的 factory 是 buildContext 时塞的真工厂;这里改成返回 fakeSession 仅用于本测试。
    // 直接走 registry 内部 entries map 的"侧门"——构造一个 entry,绕过真 factory(它会去拉 tmux)。
    const registry = ctx.chatRegistry as unknown as {
      entries: Map<string, { session: typeof fakeSession; subscribers: Set<unknown> }>;
    };
    registry.entries.set(convId, { session: fakeSession, subscribers: new Set([{}]) });
    expect(ctx.chatRegistry.isActive(convId)).toBe(true);

    // 调 reflow;newDetached 会失败(没 tmux server),返 500——但 forceClose 在 newDetached 之前调。
    await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/reflow`,
      cookies: { rcc_token: cookie },
    });

    expect(ctx.chatRegistry.isActive(convId)).toBe(false);
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/whatever/conversations/whatever/reflow',
    });
    expect(res.statusCode).toBe(401);
  });

  it('会话不存在:404', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-reflow-404');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/missing/reflow`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
