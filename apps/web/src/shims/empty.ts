/**
 * Shims for node:* modules — research-core barrel re-exports drag in node-only
 * files (store/scaffold/runCli/etc). web only ever calls the pure functions at
 * runtime, never the IO paths; these shims exist purely so `vite build` can
 * resolve the imports.
 *
 * 各 named export 桩成 noop / 抛错(若浏览器真的走到就响亮失败)。
 */
function notInBrowser(name: string): never {
  throw new Error(`[rcc-web] node:${name} 不可在浏览器调用(research-core node-only 路径)`);
}

// fs
export const readFileSync = () => notInBrowser('fs.readFileSync');
export const writeFileSync = () => notInBrowser('fs.writeFileSync');
export const existsSync = () => false;
export const mkdirSync = () => notInBrowser('fs.mkdirSync');
export const readdirSync = (): string[] => [];
export const statSync = () => notInBrowser('fs.statSync');
export const renameSync = () => notInBrowser('fs.renameSync');
export const symlinkSync = () => notInBrowser('fs.symlinkSync');
export const unlinkSync = () => notInBrowser('fs.unlinkSync');
export const realpathSync = () => notInBrowser('fs.realpathSync');
export const lstatSync = () => notInBrowser('fs.lstatSync');

// path
export const join = (...parts: string[]) => parts.join('/');
export const resolve = (...parts: string[]) => parts.join('/');
export const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
export const basename = (p: string) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
export const extname = (p: string) => (p.includes('.') ? p.slice(p.lastIndexOf('.')) : '');
export const relative = (_from: string, to: string) => to;
export const sep = '/';

// os
export const homedir = () => '/';
export const platform = () => 'browser';
export const tmpdir = () => '/';

// url
export const fileURLToPath = (_u: string | URL) => '/';
export const pathToFileURL = (p: string) => new URL(`file://${p}`);

// default — provide a "do everything" object so `import fs from 'node:fs'`
// + fs.readFileSync(...) at module top-level resolves; same object covers
// fs / path / os since they share the alias target. Browser runtime never
// actually invokes these, so collisions on method names are fine.
const everything = {
  // fs
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  statSync, renameSync, symlinkSync, unlinkSync, realpathSync, lstatSync,
  // path
  join, resolve, dirname, basename, extname, relative, sep,
  // os
  homedir, platform, tmpdir,
  // url
  fileURLToPath, pathToFileURL,
};
export default everything;
