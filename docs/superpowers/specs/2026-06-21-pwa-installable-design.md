# PWA「添加到主屏幕」设计

日期:2026-06-21
状态:已与用户确认,待出实现计划

## 背景与目标

remote-cc 已经是一个**手机优先、同源、经 Cloudflare Tunnel 暴露为 HTTPS** 的单页应用(Fastify 同时托管 `apps/web/dist` 静态产物与 `/api` REST + WS)。用户希望在**安卓**上把它「添加到主屏幕」,得到一个全屏、有桌面图标的独立 App 体验,而不必每次开浏览器、忍受地址栏。

目标:用最小代价让本站成为**可安装的 PWA**。安卓 Chrome「添加到主屏幕 / 安装应用」后,以 `display: standalone` 全屏启动,有专属图标。

## 非目标(YAGNI)

- 不做离线可用。本站是实时终端/聊天网关,离线无意义;因此**不缓存应用资源**。
- 不打包成 APK / 不上架 Play Store(那是后续 TWA 方案,本设计是其前置)。
- 不引入 Capacitor / Cordova(会破坏同源 cookie 认证,见下)。
- 不改后端、认证、ws/api、隧道。

## 现状:为什么天然适配(无需改连接逻辑)

- REST 用相对路径 `/api/...`(`apps/web/src/lib/api.ts` 的 `req`),cookie 认证 `credentials: 'include'`。
- WebSocket 用 `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/...`(`lib/ws.ts`、`lib/chatWs.ts`),**跟随当前 origin**。
- 生产由 Fastify 托管 `apps/web/dist` 静态 + 非 `/api` 的 SPA 回退(`apps/server/src/plugins/staticSite.ts`),前后端同源。

PWA「添加到主屏幕」是在浏览器内、**同一 origin** 打开本站,故上述相对路径 / `location.host` / cookie 全部照常工作,**前端连接与认证逻辑零改动**。

## 架构与产物

所有新增静态资源放 `apps/web/public/`。Vite 默认 `publicDir = "public"`,构建时原样拷到 `dist/` 根;Fastify 静态根即 `dist`、前缀 `/`,故 `/manifest.webmanifest`、`/sw.js`、`/icons/*.png` 都能直接被请求到(静态文件存在时直接命中,不走 SPA 回退)。SW 部署在根路径 → 作用域为根 `/`。

### 1. `apps/web/public/manifest.webmanifest`

字段:
- `name`: `remote-cc`,`short_name`: `remote-cc`
- `start_url`: `/`,`scope`: `/`
- `display`: `standalone`
- `theme_color`: `#f6f3ec`(与 index.html 现有 `<meta name="theme-color">` 一致)
- `background_color`: `#f3efe6`(与 `apps/web/src/themes/tokens.css` 的 `--bg` 一致,作启动闪屏底色)
- `icons`:
  - `icons/icon-192.png`(192×192,`purpose: "any"`)
  - `icons/icon-512.png`(512×512,`purpose: "any"`)
  - `icons/icon-maskable-512.png`(512×512,`purpose: "maskable"`)

### 2. 图标

视觉:深色 `>_`(终端提示符)居中,米色底(`#f3efe6`)。maskable 版内容收缩到中心安全区(约中心 80%,四周留 padding),避免被各 launcher 的圆形/方圆遮罩裁掉。

附加:`apps/web/public/apple-touch-icon.png`(180×180),顺带让 iOS Safari「添加到主屏幕」也有像样图标(本设计主攻安卓,iOS 仅顺手覆盖,不额外验证)。

生成方式:仓库内置一份 `>_` SVG,用一次性脚本(`apps/web/scripts/gen-icons.mjs`,基于 `sharp` 或 `@resvg/resvg-js` 把 SVG 栅格化为各尺寸 PNG)。**产物 PNG 直接提交进库**,脚本保留以便日后复现/改图。栅格化依赖按需安装(网络允许 npmjs);实现计划里确定是加 devDependency 还是临时安装。

### 3. `apps/web/public/sw.js`(极简,network-only)

行为:
- `install`:`self.skipWaiting()`。
- `activate`:`self.clients.claim()`。
- `fetch`:**一律直通网络(network-only),不读写任何 Cache**。

理由:项目纪律强调「改完代码必须重建才生效」,任何资源缓存都可能让用户吃到旧前端;故 SW 只为满足「可安装」体验与未来扩展点,**绝不缓存**,从根上杜绝陈旧。

(备注:现代 Chrome 安装 PWA 已不强制 SW;此处加最简 SW 是为跨 Chrome 版本的安装体验更稳,且零陈旧风险。)

### 4. `apps/web/index.html` 与 `main.tsx`

`index.html` `<head>` 增加:
- `<link rel="manifest" href="/manifest.webmanifest">`
- `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
- `<meta name="mobile-web-app-capable" content="yes">`

(`viewport`、`theme-color` 已存在,不动。)

`main.tsx` 增加 SW 注册(特性判断):
```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
```

## 不改动项(明确边界)

后端(`apps/server`)、认证、`lib/api.ts`/`lib/ws.ts`/`lib/chatWs.ts` 的连接逻辑、隧道配置 —— 一律不碰。本设计纯加法。

## 验证方案

1. `./start.sh` 构建后,本地 `curl` 确认 `/manifest.webmanifest`、`/sw.js`、`/icons/icon-512.png` 均 200 且 MIME 正确。
2. Chrome DevTools → Application 面板:Manifest 无报错、图标载入、Installability 通过;Service Workers 显示已激活。
3. 经隧道在**安卓 Chrome 真机**「添加到主屏幕 / 安装应用」:确认全屏 standalone 启动、桌面图标正确、`wss` 连接与登录 cookie 正常(开一个终端/聊天会话验证收发)。

## 风险与部署注意

- **隧道域名要稳定**:已安装的 PWA 钉在某个 origin;隧道公网主机名若变化,安装的图标/作用域会失效。建议隧道用稳定自定义域名(部署层,不阻塞本实现)。
- manifest / SW 要求同源 HTTPS —— 隧道已满足。
- SW 根作用域依赖 `/sw.js` 由根路径托管 —— 现有静态托管满足。

## 文件清单

新增:
- `apps/web/public/manifest.webmanifest`
- `apps/web/public/icons/icon-192.png`、`icon-512.png`、`icon-maskable-512.png`
- `apps/web/public/apple-touch-icon.png`
- `apps/web/public/sw.js`
- `apps/web/scripts/gen-icons.mjs`(图标生成脚本)

修改:
- `apps/web/index.html`(manifest / apple 标签)
- `apps/web/src/main.tsx`(注册 SW)
- 可能:`apps/web/package.json`(若把 sharp/resvg 加为 devDependency)
