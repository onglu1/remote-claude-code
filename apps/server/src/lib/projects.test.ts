import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore, slugify } from './projects';

let dir: string;
let file: string;
let projDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-proj-'));
  file = path.join(dir, 'projects.json');
  projDir = path.join(dir, 'a-project');
  fs.mkdirSync(projDir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ProjectStore', () => {
  it('文件不存在时返回空数组（不扫描）', () => {
    expect(new ProjectStore(file).load()).toEqual([]);
  });

  it('add 后可 load 回来', () => {
    const store = new ProjectStore(file);
    const p = store.add({ name: 'A Project', path: projDir, type: 'dev' });
    expect(p.id).toBe('a-project');
    expect(p.launchCommand).toBe('Fable-yolo');
    expect(store.load()).toHaveLength(1);
  });

  it('拒绝重复 id', () => {
    const store = new ProjectStore(file);
    store.add({ name: 'A Project', path: projDir, type: 'dev' });
    expect(() => store.add({ name: 'A Project', path: projDir, type: 'dev' })).toThrow();
  });

  it('拒绝相对路径', () => {
    const store = new ProjectStore(file);
    expect(() => store.add({ name: 'rel', path: 'a-project', type: 'dev' })).toThrow();
  });

  it('拒绝不存在的路径', () => {
    const store = new ProjectStore(file);
    expect(() =>
      store.add({ name: 'ghost', path: path.join(dir, 'nope'), type: 'dev' }),
    ).toThrow();
  });

  it('第二次写回生成 .bak', () => {
    const bDir = path.join(dir, 'b-project');
    fs.mkdirSync(bDir);
    const store = new ProjectStore(file);
    store.add({ name: 'A Project', path: projDir, type: 'dev' });
    store.add({ name: 'B Project', path: bDir, type: 'dev' });
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
  });

  it('remove 删除条目', () => {
    const store = new ProjectStore(file);
    store.add({ name: 'A Project', path: projDir, type: 'dev' });
    store.remove('a-project');
    expect(store.load()).toEqual([]);
  });

  it('migrate 给缺 ownerId 的存量项目回填 admin', () => {
    // 模拟存量：直接写一条无 ownerId 的项目
    fs.writeFileSync(
      file,
      JSON.stringify([{ id: 'legacy', name: 'L', path: projDir, type: 'dev' }], null, 2),
    );
    const store = new ProjectStore(file);
    store.migrate('admin-1');
    expect(store.get('legacy')?.ownerId).toBe('admin-1');
  });

  it('migrate 不覆盖已有 ownerId 且幂等', () => {
    fs.writeFileSync(
      file,
      JSON.stringify(
        [{ id: 'owned', name: 'O', path: projDir, type: 'dev', ownerId: 'u-x' }],
        null,
        2,
      ),
    );
    const store = new ProjectStore(file);
    store.migrate('admin-1');
    expect(store.get('owned')?.ownerId).toBe('u-x');
    // 幂等：全部已有 owner 时不应生成 .bak（未写盘）
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});

describe('slugify', () => {
  it('转小写连字符', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
  });
});
