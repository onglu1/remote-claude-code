import React from 'react';
import ReactDOM from 'react-dom/client';
import './shims/bufferGlobal'; // 浏览器最小 Buffer 占位(research-core 偶用 Buffer.byteLength)
import './index.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 注册 Service Worker(PWA 可安装;SW 本身 network-only 不缓存)。失败静默,不影响应用。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
