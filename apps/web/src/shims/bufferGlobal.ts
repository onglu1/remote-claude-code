/**
 * 提供浏览器侧最小的 Buffer 占位 — research-core 的 briefRich.maxBytes 分支会
 * 用到 Buffer.byteLength。web 当前调用都不传 maxBytes,实际走不到这条路径,但
 * 我们防御性地塞个 polyfill,免得未来代码改了悄悄 ReferenceError。
 */
if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  const enc = new TextEncoder();
  (globalThis as unknown as { Buffer: { byteLength: (s: string) => number } }).Buffer = {
    byteLength: (s: string) => enc.encode(String(s)).length,
  };
}

export {};
