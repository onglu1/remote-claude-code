import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.RCC_BACKEND ?? 'http://127.0.0.1:4400';

/**
 * research-core 的 barrel re-export 把 store/scaffold/runCli 等 node-only 模块
 * 也拉进了浏览器 bundle。web 实际只调用纯函数(renderBrief / renderBriefRich /
 * nextAll / analyzeGraph),那些 node-tainted 路径在浏览器运行时不会被触达,
 * 但 rollup 必须能 resolve 它们的导入才能完成构建。
 * 这里把 node:* 一并桩成空模块(并暴露 process / Buffer 占位)以让 build 过去。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'node:fs': new URL('./src/shims/empty.ts', import.meta.url).pathname,
      'node:path': new URL('./src/shims/empty.ts', import.meta.url).pathname,
      'node:os': new URL('./src/shims/empty.ts', import.meta.url).pathname,
      'node:url': new URL('./src/shims/empty.ts', import.meta.url).pathname,
    },
  },
  define: {
    'process.pid': '0',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist' },
});
