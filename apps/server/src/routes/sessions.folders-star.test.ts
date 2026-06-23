import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';

// PATCH /api/projects/:id/conversations/:cid 扩字段（folderId / starred）的端到端用例。
// 与 sessions.rename.test.ts 同风格：buildApp + app.inject + cookie。

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-folders-star-'));
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

describe('PATCH conversations 扩字段（folderId / starred）', () => {
  it('PATCH folderId：成功，列表反映归属', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-folder-ok');
    const fid = await makeFolder(cookie, projectId, '工作');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { folderId: fid },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.folderId).toBe(fid);

    const list = await app.inject({
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: cookie },
    });
    const found = (list.json().conversations as Array<{ id: string; folderId?: string | null }>).find(
      (c) => c.id === convId,
    );
    expect(found?.folderId).toBe(fid);
  });

  it('PATCH folderId=null：成功清除归属', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-folder-null');
    const fid = await makeFolder(cookie, projectId, '清除组');
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { folderId: fid },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { folderId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.folderId).toBeNull();
  });

  it('PATCH starred=true：成功', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-star-ok');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { starred: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.starred).toBe(true);

    const list = await app.inject({
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: cookie },
    });
    const found = (list.json().conversations as Array<{ id: string; starred?: boolean }>).find(
      (c) => c.id === convId,
    );
    expect(found?.starred).toBe(true);
  });

  it('PATCH starred=true 后 DELETE：返回 409 starred_locked', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-star-delete');
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { starred: true },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'starred_locked' });
  });

  it('PATCH starred=true 后 DELETE?hard=1：允许彻底删', async () => {
    // 标星只锁软删（垃圾箱路径），hard=1 仍可彻底删除（管理员显式操作）。
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-star-hard');
    await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { starred: true },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/conversations/${convId}?hard=1`,
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PATCH folderId 指向不存在文件夹：400', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-folder-nope');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { folderId: 'fld_nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH 同时改 name + starred：两字段都生效', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-multi');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: { name: '组合改', starred: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().conversation.name).toBe('组合改');
    expect(res.json().conversation.starred).toBe(true);
  });

  it('PATCH 空 body：400（至少要一个字段）', async () => {
    const cookie = await login('admin', 'test-pass');
    const { projectId, convId } = await makeProjectWithConv(cookie, 'P-empty');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/conversations/${convId}`,
      cookies: { rcc_token: cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
