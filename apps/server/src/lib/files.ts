import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { type FileEntry } from '@rcc/shared';

const MAX_TEXT_BYTES = 512 * 1024; // 512KB 以上文本截断
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 浏览器编辑器保存上限，避免误写超大文件

export class PathTraversalError extends Error {}

/**
 * 把用户给的相对路径安全解析到项目根内。
 * 先 realpath，再断言落在 root（也 realpath 后）之内，拒绝符号链接逃逸与 ../。
 */
export function resolveWithin(root: string, relPath: string): string {
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, relPath.replace(/^\/+/, ''));

  // 1) 先做词法包含检查，挡住 ../ 越界（即便目标不存在）
  const lexRel = path.relative(realRoot, candidate);
  if (lexRel.startsWith('..') || path.isAbsolute(lexRel)) {
    throw new PathTraversalError(`路径越界: ${relPath}`);
  }

  // 2) 再对「存在的前缀」做 realpath，挡住符号链接逃逸
  const real = realpathExistingPrefix(candidate);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(`路径越界（符号链接逃逸）: ${relPath}`);
  }
  return real;
}

/** 对路径中已存在的最长前缀做 realpath，再拼回不存在的尾部。 */
function realpathExistingPrefix(p: string): string {
  let cur = p;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const realCur = fs.realpathSync(cur);
  return tail.length ? path.join(realCur, ...tail) : realCur;
}

export interface FileContent {
  kind: 'text' | 'image' | 'binary';
  path: string;
  mime: string;
  /** text: 内容；image: base64 data URL；binary: 空 */
  content?: string;
  truncated?: boolean;
  size: number;
}

export class FileBrowser {
  /** roots：可浏览的绝对根目录（已含项目根或白名单子目录）。 */
  constructor(private readonly roots: string[]) {}

  private rootFor(relPath: string): string {
    // 简化：单根场景直接用 roots[0]；多根时取第一个能容纳的根
    if (this.roots.length === 1) return this.roots[0];
    for (const r of this.roots) {
      try {
        resolveWithin(r, relPath);
        return r;
      } catch {
        /* try next */
      }
    }
    return this.roots[0];
  }

  listDir(relPath = ''): FileEntry[] {
    const root = this.rootFor(relPath);
    const abs = resolveWithin(root, relPath);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) throw new Error('不是目录');
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.git'))
      .map((d) => {
        const childAbs = path.join(abs, d.name);
        const childRel = path.relative(fs.realpathSync(root), childAbs);
        const isDir = d.isDirectory();
        let size: number | undefined;
        try {
          if (!isDir) size = fs.statSync(childAbs).size;
        } catch {
          /* ignore */
        }
        return {
          name: d.name,
          path: childRel,
          kind: isDir ? 'dir' : 'file',
          size,
          mime: isDir ? undefined : (mime.lookup(d.name) || 'application/octet-stream'),
        } satisfies FileEntry;
      })
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
      );
  }

  readFile(relPath: string): FileContent {
    const root = this.rootFor(relPath);
    const abs = resolveWithin(root, relPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error('是目录，不是文件');
    const mimeType = mime.lookup(abs) || 'application/octet-stream';
    const rel = path.relative(fs.realpathSync(root), abs);

    if (mimeType.startsWith('image/') && stat.size <= 5 * 1024 * 1024) {
      const b64 = fs.readFileSync(abs).toString('base64');
      return {
        kind: 'image',
        path: rel,
        mime: mimeType,
        content: `data:${mimeType};base64,${b64}`,
        size: stat.size,
      };
    }

    if (isProbablyText(mimeType, abs)) {
      const buf = fs.readFileSync(abs);
      const slice = buf.subarray(0, MAX_TEXT_BYTES);
      return {
        kind: 'text',
        path: rel,
        mime: mimeType,
        content: slice.toString('utf8'),
        truncated: buf.length > MAX_TEXT_BYTES,
        size: stat.size,
      };
    }

    return { kind: 'binary', path: rel, mime: mimeType, size: stat.size };
  }

  writeTextFile(relPath: string, content: string): FileContent {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error('文件过大，浏览器编辑器最多保存 2MB 文本');
    }

    const root = this.rootFor(relPath);
    const abs = resolveWithin(root, relPath);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      throw new Error('是目录，不是文件');
    }

    const parent = path.dirname(abs);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error('父目录不存在');
    }

    fs.writeFileSync(abs, content, 'utf8');
    return this.readFile(relPath);
  }
}

export interface DirListing {
  /** 当前位置的绝对路径 */
  absolute: string;
  /** 相对 root 的路径 */
  path: string;
  dirs: { name: string; path: string }[];
}

/**
 * 列出 root/relPath 下的「子目录」，供添加项目时逐级点选用。
 * 仅返回目录，按名排序；路径经越界防护，限定在 root 内。
 */
export function listSubdirs(root: string, relPath = ''): DirListing {
  const realRoot = fs.realpathSync(root);
  const abs = resolveWithin(root, relPath);
  if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录');
  const dirs = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '.git')
    .map((d) => ({ name: d.name, path: path.relative(realRoot, path.join(abs, d.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { absolute: abs, path: path.relative(realRoot, abs), dirs };
}

function isProbablyText(mimeType: string, abs: string): boolean {
  if (
    mimeType.startsWith('text/') ||
    /(json|javascript|typescript|xml|yaml|x-sh|x-python|markdown)/.test(mimeType)
  ) {
    return true;
  }
  // 嗅探前 4KB 是否含 NUL
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}
