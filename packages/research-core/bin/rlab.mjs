#!/usr/bin/env node
// 全局 rlab 命令包装:用 tsx 跑 research-core 的 cli.ts,工作目录为调用方 cwd。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)); // .../packages/research-core/bin
const cli = path.join(here, '..', 'src', 'cli.ts');
// tsx 可能在本包或被 monorepo 根 hoist;都找不到则退回 PATH 上的 tsx
const candidates = [
  path.join(here, '..', 'node_modules', '.bin', 'tsx'),
  path.join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx'),
];
const tsx = candidates.find((p) => fs.existsSync(p)) ?? 'tsx';
const r = spawnSync(tsx, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
process.exit(r.status ?? 1);
