import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { buildApp } from '../src/app';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-smoke-research-'));
  const config = loadConfig({
    ADMIN_PASSWORD: 'smoke-pass',
    ADMIN_USERNAME: 'admin',
    SESSION_SECRET: 'smoke-secret-key',
    PROJECTS_CONFIG: path.join(tmpDir, 'projects.json'),
  } as NodeJS.ProcessEnv);
  const app = await buildApp(config, { serveStatic: false });

  // 登录拿 cookie
  const loginRes = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: 'admin', password: 'smoke-pass' },
  });
  if (loginRes.statusCode !== 200) { console.error('登录失败', loginRes.body); process.exit(1); }
  const cookie = loginRes.cookies.find((c) => c.name === 'rcc_token')!.value;

  // 建一个 research 项目
  const projDir = fs.mkdtempSync(path.join(tmpDir, 'demo-'));
  const made = await app.inject({
    method: 'POST', url: '/api/projects',
    cookies: { rcc_token: cookie },
    payload: { name: 'SmokeDemo', path: projDir, type: 'research' },
  });
  if (made.statusCode !== 200) { console.error('建项目失败', made.body); process.exit(1); }
  const pid = made.json().project.id as string;

  async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    const r = await app.inject({ method, url, cookies: { rcc_token: cookie }, payload });
    const tag = `[${method}] ${url}`;
    const body = r.body.slice(0, 280);
    process.stdout.write(`\n${tag}\n  status: ${r.statusCode}\n  body: ${body}\n`);
    if (r.statusCode !== 200) {
      process.stderr.write(`❌ ${tag} -> ${r.statusCode}: ${r.body}\n`);
      process.exit(1);
    }
    return r.json();
  }

  const base = `/api/projects/${pid}/research`;
  await call('POST', `${base}/init`, { name: 'SmokeDemo' });
  await call('GET',  `${base}/init-status`);
  await call('POST', `${base}/add`, { type: 'thread', title: '错误危害方向', as: '003' });
  await call('POST', `${base}/add`, { type: 'task', title: '错误类型×位置矩阵', as: '007', parent: 'thread/003' });
  await call('POST', `${base}/conclude`, { task: 'task/007', result: 'positive', summary: '排序确认' });
  await call('POST', `${base}/add`, { type: 'task', title: '重测矩阵', as: '008', parent: 'thread/003' });
  await call('POST', `${base}/conclude`, { task: 'task/008', result: 'negative', summary: '相反结论' });
  await call('POST', `${base}/contradict`, { a: 'evidence/001', b: 'evidence/002', note: '设置微差' });
  await call('POST', `${base}/invalidate`, { id: 'evidence/002', reason: 'fi_server 配置有误' });
  await call('GET',  `${base}/graph`);
  await call('GET',  `${base}/next`);
  await call('GET',  `${base}/analyze`);
  await call('GET',  `${base}/brief?rich=1`);
  await call('GET',  `${base}/affected-by/${encodeURIComponent('evidence/002')}`);

  process.stdout.write('\n✅ 呈现层 HTTP API smoke 全绿\n');

  await app.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
