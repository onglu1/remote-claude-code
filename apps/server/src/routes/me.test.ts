import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';

// /api/me/settings 的端到端用例:读返默认 3、写改成 6、超范围(>48)400、未登录 401。

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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-me-'));
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

describe('GET /api/me/settings', () => {
  it('未设置过:返回默认 idleCloseHours=3', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ idleCloseHours: 3 });
  });

  it('未登录:401', async () => {
    const res = await app.inject({ url: '/api/me/settings' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /api/me/settings', () => {
  it('改成 6 后 GET 返 6', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
      payload: { idleCloseHours: 6 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ idleCloseHours: 6 });
    const r2 = await app.inject({
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
    });
    expect(r2.json()).toMatchObject({ idleCloseHours: 6 });
  });

  it('idleCloseHours=0 合法(=关闭功能)', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
      payload: { idleCloseHours: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ idleCloseHours: 0 });
  });

  it('超范围(>48):400', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
      payload: { idleCloseHours: 99 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('负值:400', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
      payload: { idleCloseHours: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('非整数:400', async () => {
    const cookie = await login('admin', 'test-pass');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      cookies: { rcc_token: cookie },
      payload: { idleCloseHours: 2.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('未登录:401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/settings',
      payload: { idleCloseHours: 5 },
    });
    expect(res.statusCode).toBe(401);
  });
});
