import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextNumber } from './numbering';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlab-num-'));
  fs.mkdirSync(path.join(root, 'research', 'nodes', 'tasks'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('nextNumber', () => {
  it('空目录从 001 开始', () => {
    expect(nextNumber(root, 'task')).toBe('001');
  });
  it('取现有最大主编号 +1,零填充 3 位', () => {
    const dir = path.join(root, 'research', 'nodes', 'tasks');
    fs.writeFileSync(path.join(dir, '001.json'), '{}');
    fs.writeFileSync(path.join(dir, '007.json'), '{}');
    expect(nextNumber(root, 'task')).toBe('008');
  });
  it('忽略子编号文件,只按主编号取 max', () => {
    const dir = path.join(root, 'research', 'nodes', 'tasks');
    fs.writeFileSync(path.join(dir, '025.json'), '{}');
    fs.writeFileSync(path.join(dir, '025.1.json'), '{}');
    expect(nextNumber(root, 'task')).toBe('026');
  });
  it('目录不存在也返回 001', () => {
    expect(nextNumber(root, 'idea')).toBe('001');
  });
});
