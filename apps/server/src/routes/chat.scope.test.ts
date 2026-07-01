import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';

let app: FastifyInstance;
let tmpDir: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rcc_token')!.value;

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'test-pass' },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

async function makeProjectWithConv(cookie: string, name: string): Promise<{ projectId: string; convId: string }> {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'proj-'));
  const project = await app.inject({
    method: 'POST',
    url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name, path: projDir, type: 'dev' },
  });
  expect(project.statusCode).toBe(200);
  const projectId = project.json().project.id as string;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-chat-scope-'));
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

describe('chat route scope', () => {
  it('upload rejects project/conversation mismatch', async () => {
    const cookie = await login();
    const p1 = await makeProjectWithConv(cookie, 'P-chat-scope-a');
    const p2 = await makeProjectWithConv(cookie, 'P-chat-scope-b');

    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${p1.projectId}/conversations/${p2.convId}/uploads?name=x.png&mime=image/png`,
      cookies: { rcc_token: cookie },
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3]),
    });

    expect(res.statusCode).toBe(404);
  });
});
