import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';

// 会话改名路由 PATCH /api/projects/:id/conversations/:cid 的端到端用例。
// 与 app.test.ts 同风格：buildApp + app.inject + cookie；tmux 无 server 时 alive 恒 false。

let app: FastifyInstance;
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

/** 用某用户建项目（path 用真实临时目录）+ 一个会话，返回 {projectId, convId, name}。 */
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
    payload: { name: '原始名' },
  });
  expect(conv.statusCode).toBe(200);
  return {
    projectId,
    convId: conv.json().conversation.id as string,
    name: conv.json().conversation.name as string,
  };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-rename-'));
  const config = loadConfig({
    ADMIN_PASSWORD: 'test-pass',
    ADMIN_USERNAME: 'admin',
    SESSION_SECRET: 'test-secret-key',
    PROJECTS_CONFIG: path.join(tmpDir, 'projects.json'),
  } as NodeJS.ProcessEnv);
  app = await buildApp(config, { serveStatic: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PATCH /api/projects/:id/conversations/:cid（会话改名）', () => {
  it('成功改名：返回新名且列表生效', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-rename-ok');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: '新名字' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation).toMatchObject({ id: convId, name: '新名字', alive: false });

    const list = await app.inject({
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: cookie },
    });
    const found = (list.json().conversations as { id: string; name: string }[]).find(
      (c) => c.id === convId,
    );
    expect(found?.name).toBe('新名字');
  });

  it('改名 trim 首尾空白后存储', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-rename-trim');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: '  带空白的名  ' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.name).toBe('带空白的名');
  });

  it('纯空白名 → 400', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-rename-blank');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('超长名（>60）→ 400', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-rename-long');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: 'x'.repeat(61) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('不可见项目（非 owner）→ 404', async () => {
    const adminCookie = await login('admin', 'test-pass');
    // admin 建 alice、bob 两个普通用户
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

    // alice 的项目+会话，bob 来改名 → 看不到该项目 → 404
    const { projectId, convId } = await makeProjectWithConv(aliceCookie, 'Alice-proj');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: bobCookie },
      payload: { name: '坏人改的名' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('会话不存在 → 404', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId } = await makeProjectWithConv(cookie, 'P-rename-nocid');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/does-not-exist`,
      cookies: { rcc_token: cookie },
      payload: { name: '改一个不存在的' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('已软删除(垃圾箱)的会话 → 404,不能被改名', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-rename-deleted');

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
    });
    expect(del.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: '垃圾箱里也能改名?' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('未登录 → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/whatever/conversations/whatever`,
      payload: { name: '匿名改名' },
    });
    expect(res.statusCode).toBe(401);
  });
});
