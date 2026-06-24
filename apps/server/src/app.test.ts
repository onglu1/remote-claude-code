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

  it('多用户:admin 普通入口也只看自己 namespace,跨 namespace 需走 /api/admin/projects', async () => {
    // 管理员降级 2026-06-25:admin 不再 bypass canSeeProject。
    // GET /api/projects:admin 跟普通用户一样按 namespaceId 比对(只看自己建的)。
    // GET /api/admin/projects:admin 专用全量视图。
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-pass' },
    });
    const adminCookie = cookieOf(adminLogin);
    const adminId = adminLogin.json().user.id;

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
    const aliceProjectId = made.json().project.id;

    // alice 只看到自己的(原行为不变)。
    const aliceView = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: aliceCookie },
    });
    const aliceProjects = aliceView.json().projects as { id: string; ownerId?: string }[];
    expect(aliceProjects.every((p) => p.ownerId === aliceId)).toBe(true);

    // admin 普通入口 GET /api/projects:看不到 alice 的(只看自己 namespace)。
    const adminView = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: adminCookie },
    });
    const adminProjects = adminView.json().projects as { id: string; ownerId?: string }[];
    expect(adminProjects.every((p) => p.ownerId === adminId)).toBe(true);
    expect(adminProjects.some((p) => p.id === aliceProjectId)).toBe(false);

    // admin 专用入口 GET /api/admin/projects:看到所有项目(含 alice 的)。
    const adminAllView = await app.inject({
      url: '/api/admin/projects',
      cookies: { rcc_token: adminCookie },
    });
    expect(adminAllView.statusCode).toBe(200);
    const allProjects = adminAllView.json().projects as { id: string; ownerId?: string }[];
    expect(allProjects.some((p) => p.id === aliceProjectId && p.ownerId === aliceId)).toBe(true);
  });

  it('admin 改 owner:PATCH /api/admin/projects/:id 把项目转给另一个 namespace', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-pass' },
    });
    const adminCookie = cookieOf(adminLogin);
    const adminId = adminLogin.json().user.id;

    // admin 建一个自己的项目
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'transfer-'));
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { rcc_token: adminCookie },
      payload: { name: 'transfer-me', path: projDir, type: 'dev' },
    });
    expect(made.json().project.ownerId).toBe(adminId);
    const projectId = made.json().project.id;

    // 拿到 alice id(上一用例已建)
    const usersRes = await app.inject({
      url: '/api/admin/users',
      cookies: { rcc_token: adminCookie },
    });
    const alice = (usersRes.json().users as { id: string; username: string }[]).find(
      (u) => u.username === 'alice',
    )!;

    // PATCH owner → alice
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/projects/${projectId}`,
      cookies: { rcc_token: adminCookie },
      payload: { ownerId: alice.id },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().project.ownerId).toBe(alice.id);

    // 转完 admin 自己再看普通入口:看不到了
    const adminViewAfter = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: adminCookie },
    });
    const adminProjectsAfter = adminViewAfter.json().projects as { id: string }[];
    expect(adminProjectsAfter.some((p) => p.id === projectId)).toBe(false);

    // 改一个不存在的 owner → 400
    const badPatch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/projects/${projectId}`,
      cookies: { rcc_token: adminCookie },
      payload: { ownerId: 'no-such-namespace' },
    });
    expect(badPatch.statusCode).toBe(400);
  });

  it('admin 删项目:DELETE /api/admin/projects/:id 绕过 canSeeProject', async () => {
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-pass' },
    });
    const adminCookie = cookieOf(adminLogin);

    // alice 建一个项目
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-pass' },
    });
    const aliceCookie = cookieOf(aliceLogin);
    const projDir = fs.mkdtempSync(path.join(tmpDir, 'del-'));
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: { rcc_token: aliceCookie },
      payload: { name: 'del-me', path: projDir, type: 'dev' },
    });
    const projectId = made.json().project.id;

    // admin 走普通 DELETE 路径:看不见这项目(canSeeProject false) → 404,符合"不暴露存在性"语义
    const normalDelete = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}`,
      cookies: { rcc_token: adminCookie },
    });
    expect(normalDelete.statusCode).toBe(404);

    // admin 走专用路径:能删
    const adminDelete = await app.inject({
      method: 'DELETE',
      url: `/api/admin/projects/${projectId}`,
      cookies: { rcc_token: adminCookie },
    });
    expect(adminDelete.statusCode).toBe(200);

    // alice 再看自己项目列表,应该没了
    const aliceViewAfter = await app.inject({
      url: '/api/projects',
      cookies: { rcc_token: aliceCookie },
    });
    expect(
      (aliceViewAfter.json().projects as { id: string }[]).some((p) => p.id === projectId),
    ).toBe(false);
  });

  it('非 admin 调 /api/admin/projects 返回 403', async () => {
    const aliceLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'alice-pass' },
    });
    const res = await app.inject({
      url: '/api/admin/projects',
      cookies: { rcc_token: cookieOf(aliceLogin) },
    });
    expect(res.statusCode).toBe(403);
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
