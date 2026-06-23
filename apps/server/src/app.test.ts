import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config';
import { buildApp } from './app';

let app: FastifyInstance;
let tmpDir: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rcc_token')!.value;

beforeAll(async () => {
  // 隔离的临时 config 目录，避免污染仓库 config/。
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-app-'));
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

describe('app', () => {
  it('health 开放', async () => {
    const res = await app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('未授权访问 projects 返回 401', async () => {
    const res = await app.inject({ url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('login：错误口令 401，正确口令拿 cookie 并返回 admin', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-pass' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ username: 'admin', role: 'admin' });

    const state = await app.inject({
      url: '/api/auth/state',
      cookies: { rcc_token: cookieOf(ok) },
    });
    expect(state.json().user).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('兼容别名 unlock 仍可用（按 ADMIN_USERNAME 校验口令）', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      payload: { password: 'test-pass' },
    });
    expect(ok.statusCode).toBe(200);
    const authed = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: cookieOf(ok) },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toHaveProperty('projects');
  });

  it('多用户：admin 与普通用户的 projects 视图不同', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-pass' },
    });
    const adminCookie = cookieOf(adminLogin);

    // admin 建一个普通用户
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      cookies: { rcc_token: adminCookie },
      payload: { username: 'alice', password: 'alice-pass', role: 'user' },
    });
    expect(created.statusCode).toBe(200);
    const aliceId = created.json().user.id;

    // 给 alice 建一个项目（用临时真实目录作 path）
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-pass' },
    });
    const aliceCookie = cookieOf(aliceLogin);
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { rcc_token: aliceCookie },
      payload: { name: 'Alice Proj', path: projDir, type: 'dev' },
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().project.ownerId).toBe(aliceId);

    // alice 只看到自己的；admin 看到全部（至少含 alice 的）
    const aliceView = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: aliceCookie },
    });
    const aliceProjects = aliceView.json().projects as { id: string; ownerId?: string }[];
    expect(aliceProjects.every((p) => p.ownerId === aliceId)).toBe(true);

    const adminView = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: adminCookie },
    });
    const adminProjects = adminView.json().projects as { id: string }[];
    expect(adminProjects.length).toBeGreaterThanOrEqual(aliceProjects.length);
    expect(adminProjects.some((p) => p.id === made.json().project.id)).toBe(true);
  });

  it('非 admin 调 /api/admin/users 返回 403', async () => {
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-pass' },
    });
    const res = await app.inject({
      url: '/api/admin/users',
      cookies: { rcc_token: cookieOf(aliceLogin) },
    });
    expect(res.statusCode).toBe(403);
  });
});
