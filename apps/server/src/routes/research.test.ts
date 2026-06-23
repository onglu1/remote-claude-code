import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config';
import { buildApp } from '../app';
import { scaffoldResearchRepo, addNode, NodeStore } from '@rcc/research-core';

// 科研呈现层后端读 endpoint 端到端用例:buildApp + app.inject + cookie。
// 与 sessions.rename.test.ts 同风格;节点直接落盘(不经过 HTTP)以构造场景。

let app: FastifyInstance;
let tmpDir: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rcc_token')!.value;

async function login(username = 'admin', password = 'test-pass'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

let projCounter = 0;

/** 建一个 research 项目(path 指向 tmpDir 子目录,可选 scaffold);name 唯一以避免 id 冲突。 */
async function makeResearchProject(cookie: string, scaffold = false) {
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'rp-'));
  if (scaffold) scaffoldResearchRepo(projDir, { projectName: 'Demo' });
  const name = `RP-${++projCounter}`;
  const made = await app.inject({
    method: 'POST',
    url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name, path: projDir, type: 'research' },
  });
  expect(made.statusCode).toBe(200);
  return { projectId: made.json().project.id as string, projDir };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-research-route-'));
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

describe('GET /api/projects/:id/research/init-status', () => {
  it('未 scaffold → initialized=false', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, false);
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/init-status`,
      cookies: { rcc_token: cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ initialized: false, root: projDir });
  });

  it('scaffold 后 initialized=true', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, true);
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/init-status`,
      cookies: { rcc_token: cookie },
    });
    expect(r.json().initialized).toBe(true);
  });

  it('未登录 → 401', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/x/research/init-status`,
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('GET /research/graph', () => {
  it('空仓 → nodes: []', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, true);
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/graph`,
      cookies: { rcc_token: cookie },
    });
    expect(r.json()).toEqual({ nodes: [] });
  });

  it('有节点 → 返回 nodes 数组', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, true);
    addNode(projDir, new NodeStore(projDir), { type: 'thread', title: 'T', as: '001' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/graph`,
      cookies: { rcc_token: cookie },
    });
    const body = r.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].id).toBe('thread/001');
  });
});

describe('GET /research/brief, /next, /analyze', () => {
  it('三个读 endpoint 200 + 非空 payload', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, true);
    addNode(projDir, new NodeStore(projDir), { type: 'task', title: 'T', as: '001' });

    const brief = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/brief`,
      cookies: { rcc_token: cookie },
    });
    expect(brief.statusCode).toBe(200);
    expect(brief.json().text).toContain('task/001');

    const next = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/next`,
      cookies: { rcc_token: cookie },
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().items.length).toBeGreaterThan(0);

    const an = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/analyze`,
      cookies: { rcc_token: cookie },
    });
    expect(an.statusCode).toBe(200);
    expect(an.json().stats.totals.nodes).toBe(1);
  });
});

describe('GET /research/node/*, /affected-by/*', () => {
  it('node 返回 node + inEdges', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, true);
    addNode(projDir, new NodeStore(projDir), { type: 'task', title: 'A', as: '001' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/node/${encodeURIComponent('task/001')}`,
      cookies: { rcc_token: cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().node.id).toBe('task/001');
  });

  it('affected-by 返回 report 含 from / downstream', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, true);
    addNode(projDir, new NodeStore(projDir), { type: 'task', title: 'A', as: '001' });
    const r = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/research/affected-by/${encodeURIComponent('task/001')}`,
      cookies: { rcc_token: cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().report.from).toBe('task/001');
  });
});

describe('POST 写动词', () => {
  it('init → add → set → graph 含新节点', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, false);

    const init = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/init`, cookies: { rcc_token: cookie }, payload: { name: 'Demo' } });
    expect(init.statusCode).toBe(200);

    const add = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/add`, cookies: { rcc_token: cookie }, payload: { type: 'task', title: 'T', as: '007' } });
    expect(add.statusCode).toBe(200);
    expect(add.json().node.id).toBe('task/007');

    const set = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/set`, cookies: { rcc_token: cookie }, payload: { id: 'task/007', title: 'T 新标题' } });
    expect(set.json().node.title).toBe('T 新标题');

    const graph = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/research/graph`, cookies: { rcc_token: cookie } });
    expect(graph.json().nodes).toHaveLength(1);
  });
  it('add 缺 title → 400', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, true);
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/add`, cookies: { rcc_token: cookie }, payload: { type: 'task' } });
    expect(r.statusCode).toBe(400);
  });
  it('conclude 全流程 → task done + evidence + produces 边', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, true);
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/add`, cookies: { rcc_token: cookie }, payload: { type: 'task', title: 'T', as: '001' } });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/conclude`, cookies: { rcc_token: cookie }, payload: { task: 'task/001', result: 'positive', summary: '验证通过' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.task.status).toBe('done');
    expect(body.evidence.result).toBe('positive');
  });
  it('invalidate → next 含 stale(整个生命周期)', async () => {
    const cookie = await login();
    const { projectId } = await makeResearchProject(cookie, true);
    // 建一个 task,conclude 得 evidence,再 add 一个 task depends-on evidence,然后 invalidate evidence
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/add`, cookies: { rcc_token: cookie }, payload: { type: 'task', title: 'A', as: '001' } });
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/conclude`, cookies: { rcc_token: cookie }, payload: { task: 'task/001', result: 'positive' } });
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/add`, cookies: { rcc_token: cookie }, payload: { type: 'task', title: 'B', as: '002' } });
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/link`, cookies: { rcc_token: cookie }, payload: { from: 'task/002', to: 'evidence/001', label: 'depends-on' } });
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/invalidate`, cookies: { rcc_token: cookie }, payload: { id: 'evidence/001', reason: '配置有误' } });

    const next = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/research/next`, cookies: { rcc_token: cookie } });
    expect(next.statusCode).toBe(200);
    const items = next.json().items as Array<{ kind: string; id: string }>;
    expect(items.some((x) => x.kind === 'stale' && x.id === 'task/002')).toBe(true);
  });
});

describe('POST /research/import-legacy', () => {
  it('从 docs/tasks|evidence/INDEX.md 导入节点', async () => {
    const cookie = await login();
    const { projectId, projDir } = await makeResearchProject(cookie, true);
    // 准备旧 INDEX.md
    fs.mkdirSync(path.join(projDir, 'docs', 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(projDir, 'docs', 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'docs', 'tasks', 'INDEX.md'),
      `| 编号 | 任务 | 优先级 | 来源 |\n|---:|---|---|---|\n| 003 | [t](003.md) | 高 | 实验 002 |\n`);
    fs.writeFileSync(path.join(projDir, 'docs', 'evidence', 'INDEX.md'),
      `| 编号 | 实验 | 核心结论 |\n|---:|---|---|\n| 003 | [差异化](003.md) | H |\n`);

    const r = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/research/import-legacy`, cookies: { rcc_token: cookie }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().report.createdTasks).toContain('task/003');
    expect(r.json().report.createdEvidence).toContain('evidence/003');
  });
});
