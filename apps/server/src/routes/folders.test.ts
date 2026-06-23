import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';

// 文件夹 CRUD 路由的端到端用例。与 sessions.rename.test.ts 同风格:buildApp + inject + cookie。

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

async function makeProject(cookie: string, projName: string): Promise<string> {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name: projName, path: projDir, type: 'dev' },
  });
  expect(res.statusCode).toBe(200);
  return res.json().project.id as string;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-folders-'));
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

describe('folders 路由', () => {
  it('GET 空列表:200 + []', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-empty');
    const res = await app.inject({
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folders).toEqual([]);
  });

  it('POST 创建:200 + folder', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-create');
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '工作' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder).toMatchObject({ name: '工作', projectId: pid });
    expect(res.json().folder.id).toMatch(/^fld_/);
  });

  it('POST 同名重复 → 409', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-dup');
    await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '重复' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '重复' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'duplicate' });
  });

  it('PATCH 改名:成功', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-rename');
    const made = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '旧名' },
    });
    const fid = made.json().folder.id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/folders/${fid}`,
      cookies: { rcc_token: cookie },
      payload: { name: '新名' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.name).toBe('新名');
  });

  it('DELETE 空文件夹:200 + { reassigned: 0 }', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-del-empty');
    const made = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '待删' },
    });
    const fid = made.json().folder.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${pid}/folders/${fid}`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reassigned: 0 });
  });

  it('DELETE 非空文件夹:内部会话 folderId 置 null', async () => {
    const cookie = await login('admin', 'test-pass');
    const pid = await makeProject(cookie, 'P-del-with-conv');
    const made = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: cookie },
      payload: { name: '装会话的' },
    });
    const fid = made.json().folder.id as string;
    const conv = await app.inject({
      method: 'POST',
      url: `/api/projects/${pid}/conversations`,
      cookies: { rcc_token: cookie },
      payload: { name: '受牵连' },
    });
    const cid = conv.json().conversation.id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${pid}/conversations/${cid}`,
      cookies: { rcc_token: cookie },
      payload: { folderId: fid },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${pid}/folders/${fid}`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reassigned).toBe(1);
    const list = await app.inject({
      url: `/api/projects/${pid}/conversations`,
      cookies: { rcc_token: cookie },
    });
    const found = (list.json().conversations as Array<{ id: string; folderId?: string | null }>).find(
      (c) => c.id === cid,
    );
    // null/undefined 都算"已清",但 store 写的是 null,所以期望 null。
    expect(found?.folderId ?? null).toBeNull();
  });

  it('GET 不可见项目 → 404', async () => {
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
    const pid = await makeProject(aliceCookie, 'Alice-folders-proj');
    const res = await app.inject({
      url: `/api/projects/${pid}/folders`,
      cookies: { rcc_token: bobCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      url: `/api/projects/whatever/folders`,
    });
    expect(res.statusCode).toBe(401);
  });
});
