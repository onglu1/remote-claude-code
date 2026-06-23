import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';
import { buildContext } from '../context';
import { Tmux, type ExecFn } from '../lib/session/tmux';

// GET /api/projects/:id/conversations/:cid/scrollback 的端到端用例。
// 用注入的 fake ExecFn 驱动 tmux：display-message → history_size/pane_height，capture-pane → 屏字符。
// 这样既能测正常分窗 + trimEnd，也能测会话不在(historyInfo=null)的容错。

let app: FastifyInstance;
let tmpDir: string;
// 可变 fake：各用例按需改写它来模拟不同 tmux 响应。
let fakeExec: ExecFn = async () => ({ stdout: '', stderr: '' });

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rcc_token')!.value;

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
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
    payload: { name: 'C' },
  });
  expect(conv.statusCode).toBe(200);
  return { projectId, convId: conv.json().conversation.id as string };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sb-'));
  const config = loadConfig({
    ADMIN_PASSWORD: 'test-pass',
    ADMIN_USERNAME: 'admin',
    SESSION_SECRET: 'test-secret-key',
    PROJECTS_CONFIG: path.join(tmpDir, 'projects.json'),
  } as NodeJS.ProcessEnv);
  const ctx = await buildContext(config);
  // 用注入 fake exec 的 Tmux 顶替真实 tmux（scrollback 路由只读 ctx.tmux）。
  ctx.tmux = new Tmux('rcc', (f, a) => fakeExec(f, a));
  app = await buildApp(config, { context: ctx, serveStatic: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/projects/:id/conversations/:cid/scrollback', () => {
  it('未登录 → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/x/conversations/y/scrollback',
    });
    expect(res.statusCode).toBe(401);
  });

  it('会话不存在 → 404', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-sb-nocid');
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/conversations/does-not-exist/scrollback`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('正常返回并按行 trimEnd', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-sb-ok');
    fakeExec = async (_f, a) => {
      if (a.includes('display-message')) return { stdout: '61 10\n', stderr: '' };
      if (a.includes('capture-pane')) return { stdout: 'a\nb  \n', stderr: '' }; // b 带尾空格
      return { stdout: '', stderr: '' };
    };
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/conversations/${convId}/scrollback?limit=800`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toEqual(['a', 'b']); // 尾空格被 trimEnd
    expect(body.atTop).toBe(true); // 61+10=71 < 800 → 一窗到顶
    expect(body.nextBefore).toBe(0);
  });

  it('空白窗(capture 返回空串)→ lines 为空数组而非伪空行', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-sb-empty');
    fakeExec = async (_f, a) => {
      if (a.includes('display-message')) return { stdout: '5 10\n', stderr: '' };
      if (a.includes('capture-pane')) return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/conversations/${convId}/scrollback`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines).toEqual([]);
  });

  it('会话不在 tmux（historyInfo=null）→ 空 chunk 容错', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-sb-fault');
    fakeExec = async () => {
      throw new Error('no server running');
    };
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/conversations/${convId}/scrollback`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ lines: [], nextBefore: 0, atTop: true });
  });

  it('不可见项目（非 owner）→ 404', async () => {
    const adminCookie = await login('admin', 'test-pass');
    for (const username of ['alice', 'bob']) {
      await app.inject({
        method: 'POST',
        url: '/api/admin/users',
        cookies: { rcc_token: adminCookie },
        payload: { username, password: `${username}-pass`, role: 'user' },
      });
    }
    const aliceCookie = await login('alice', 'alice-pass');
    const bobCookie = await login('bob', 'bob-pass');
    const { projectId, convId } = await makeProjectWithConv(aliceCookie, 'Alice-sb');
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/conversations/${convId}/scrollback`,
      cookies: { rcc_token: bobCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
