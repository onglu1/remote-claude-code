import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';
import { buildContext, type AppContext } from '../context';

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

async function addUser(adminCookie: string, username: string): Promise<{ id: string; cookie: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    cookies: { rcc_token: adminCookie },
    payload: { username, password: `${username}-pass`, role: 'user' },
  });
  expect(created.statusCode).toBe(200);
  return { id: created.json().user.id as string, cookie: await login(username, `${username}-pass`) };
}

async function makeProject(cookie: string, name: string): Promise<string> {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name, path: projDir, type: 'dev' },
  });
  expect(made.statusCode).toBe(200);
  return made.json().project.id as string;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-agent-access-route-'));
  const config = loadConfig({
    ADMIN_PASSWORD: 'test-pass',
    ADMIN_USERNAME: 'admin',
    SESSION_SECRET: 'test-secret-key',
    PROJECTS_CONFIG: path.join(tmpDir, 'projects.json'),
  } as NodeJS.ProcessEnv);
  ctx = await buildContext(config);
  app = await buildApp(config, { context: ctx, serveStatic: false });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('agent access admin routes', () => {
  it('admin 可读写;非 admin 403', async () => {
    const adminCookie = await login('admin', 'test-pass');
    const { id: aliceId, cookie: aliceCookie } = await addUser(adminCookie, 'alice-agent-access');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: aliceCookie },
    });
    expect(denied.statusCode).toBe(403);

    const save = await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: true, allowedPrincipalIds: [aliceId] },
        codex: { enabled: false, allowedPrincipalIds: [] },
      },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().access.claude.allowedPrincipalIds).toEqual([aliceId]);

    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().access.claude.enabled).toBe(true);
  });

  it('拒绝未知主体 id', async () => {
    const adminCookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: true, allowedPrincipalIds: ['missing'] },
        codex: { enabled: false, allowedPrincipalIds: [] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('unknown_principal');
  });
});

describe('agent access enforcement', () => {
  it('启用 claude 白名单后,未列入用户不能新建默认 claude 会话', async () => {
    const adminCookie = await login('admin', 'test-pass');
    const { cookie: bobCookie } = await addUser(adminCookie, 'bob-agent-access');
    const projectId = await makeProject(bobCookie, 'Bob Agent Project');
    await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: true, allowedPrincipalIds: [] },
        codex: { enabled: false, allowedPrincipalIds: [] },
      },
    });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: bobCookie },
      payload: { name: 'blocked' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'agent_access_denied' });
  });

  it('列入白名单后可新建;移出后不能 resume 旧会话', async () => {
    const adminCookie = await login('admin', 'test-pass');
    const { id: carolId, cookie: carolCookie } = await addUser(adminCookie, 'carol-agent-access');
    const projectId = await makeProject(carolCookie, 'Carol Agent Project');
    await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: true, allowedPrincipalIds: [carolId] },
        codex: { enabled: false, allowedPrincipalIds: [] },
      },
    });
    const created = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: carolCookie },
      payload: { name: 'allowed' },
    });
    expect(created.statusCode).toBe(200);
    const convId = created.json().conversation.id as string;

    ctx.conversations.update(convId, { closedAt: '2026-06-26T00:00:00.000Z' });
    await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: true, allowedPrincipalIds: [] },
        codex: { enabled: false, allowedPrincipalIds: [] },
      },
    });

    const denied = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations/${convId}/resume`,
      cookies: { rcc_token: carolCookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'agent_access_denied' });
  });

  it('codex 白名单与 claude 独立', async () => {
    const adminCookie = await login('admin', 'test-pass');
    const { id: daveId, cookie: daveCookie } = await addUser(adminCookie, 'dave-agent-access');
    const projectId = await makeProject(daveCookie, 'Dave Agent Project');
    await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: false, allowedPrincipalIds: [] },
        codex: { enabled: true, allowedPrincipalIds: [daveId] },
      },
    });

    const codex = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: daveCookie },
      payload: { name: 'codex ok', agentKind: 'codex' },
    });
    expect(codex.statusCode).toBe(200);

    await app.inject({
      method: 'PUT',
      url: '/api/admin/agent-access',
      cookies: { rcc_token: adminCookie },
      payload: {
        claude: { enabled: false, allowedPrincipalIds: [] },
        codex: { enabled: true, allowedPrincipalIds: [] },
      },
    });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/conversations`,
      cookies: { rcc_token: daveCookie },
      payload: { name: 'codex blocked', agentKind: 'codex' },
    });
    expect(blocked.statusCode).toBe(403);
  });
});
