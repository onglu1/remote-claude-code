import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileBrowser, resolveWithin, listSubdirs, PathTraversalError } from './files';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-files-'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), '# title');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveWithin', () => {
  it('正常相对路径', () => {
    expect(resolveWithin(root, 'a.txt')).toBe(fs.realpathSync(path.join(root, 'a.txt')));
  });
  it('拒绝 ../ 越界', () => {
    expect(() => resolveWithin(root, '../etc/passwd')).toThrow(PathTraversalError);
  });
  it('拒绝符号链接逃逸', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-out-'));
    fs.writeFileSync(path.join(outside, 'secret'), 'x');
    fs.symlinkSync(outside, path.join(root, 'link'));
    expect(() => resolveWithin(root, 'link/secret')).toThrow(PathTraversalError);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('FileBrowser', () => {
  it('列目录：目录在前、文本可读', () => {
    const fb = new FileBrowser([root]);
    const entries = fb.listDir('');
    expect(entries[0].kind).toBe('dir');
    expect(entries.map((e) => e.name)).toContain('a.txt');
  });

  it('列目录：文件带 size，目录不带', () => {
    const fb = new FileBrowser([root]);
    const entries = fb.listDir('');
    expect(entries.find((e) => e.name === 'a.txt')?.size).toBe(5);
    expect(entries.find((e) => e.name === 'sub')?.size).toBeUndefined();
  });

  it('读文本文件', () => {
    const fb = new FileBrowser([root]);
    const c = fb.readFile('a.txt');
    expect(c.kind).toBe('text');
    expect(c.content).toBe('hello');
  });

  it('识别二进制', () => {
    const fb = new FileBrowser([root]);
    expect(fb.readFile('bin.dat').kind).toBe('binary');
  });

  it('越界读取被拒', () => {
    const fb = new FileBrowser([root]);
    expect(() => fb.readFile('../../etc/passwd')).toThrow();
  });

  it('写文本文件后可读回', () => {
    const fb = new FileBrowser([root]);
    const c = fb.writeTextFile('sub/b.md', '# changed');
    expect(c.kind).toBe('text');
    expect(c.content).toBe('# changed');
    expect(fs.readFileSync(path.join(root, 'sub', 'b.md'), 'utf8')).toBe('# changed');
  });

  it('越界写入被拒', () => {
    const fb = new FileBrowser([root]);
    expect(() => fb.writeTextFile('../escape.txt', 'x')).toThrow(PathTraversalError);
  });
});

describe('listSubdirs', () => {
  it('只返回子目录并给出绝对路径', () => {
    const r = listSubdirs(root, '');
    expect(r.dirs.map((d) => d.name)).toEqual(['sub']);
    expect(r.absolute).toBe(fs.realpathSync(root));
  });
  it('可逐级进入', () => {
    fs.mkdirSync(path.join(root, 'sub', 'deep'));
    const r = listSubdirs(root, 'sub');
    expect(r.dirs.map((d) => d.name)).toContain('deep');
    expect(r.dirs[0].path).toBe(path.join('sub', 'deep'));
  });
  it('越界被拒', () => {
    expect(() => listSubdirs(root, '../..')).toThrow(PathTraversalError);
  });
});
