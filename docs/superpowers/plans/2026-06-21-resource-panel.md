# 服务器资源实时面板 实现计划（TDD 分步提交）

设计见 specs/2026-06-21-resource-panel-design.md。每步一个中文提交，先测后码。

## 步骤

1. **docs**：spec + 本 plan。（本提交）

2. **shared 类型**：在 `packages/shared/src/schemas.ts` 加
   `MetricsGpuProcessSchema / MetricsGpuSchema / MetricsCpuSchema / MetricsMemSchema /
   MetricsDiskSchema / MetricsSnapshotSchema` 及对应 type。
   提交：`feat(shared): 资源快照 zod 类型(GPU/CPU/内存/磁盘)`

3. **后端纯函数（TDD）**：先写 `apps/server/src/lib/metrics.test.ts`（喂真实样本断言
   parse* / mergeGpus / cpuFromOs / parseDf 过滤 / parseMeminfo / Sampler 缓存 + GPU 容错），
   再实现 `apps/server/src/lib/metrics.ts`（纯函数 + 注入式 run + MetricsSampler）。
   `npm -w @rcc/server test` 绿。
   提交：`feat(server): 资源采集纯函数 + MetricsSampler(TTL 缓存/GPU 容错)(TDD)`

4. **后端路由**：`apps/server/src/routes/metrics.ts`（GET /api/metrics，requireAuth，
   单例 Sampler），app.ts 注册。
   提交：`feat(server): GET /api/metrics 路由(requireAuth 任意登录可见)`

5. **前端 api + 面板**：`lib/api.ts` 加 getMetrics；新增 `components/ResourcePanel.tsx`
   （2s 轮询、离开清定时器、GPU 空闲/繁忙明显区分）；`ProjectList` 顶栏「资源」入口；
   `App.tsx` 加 metrics view。少量 .res-* 样式入 index.css。
   提交：`feat(web): 资源面板 ResourcePanel(GPU 卡片网格/空闲繁忙区分/2s 轮询)`

6. **真验证**：typecheck + test + build 全绿；`./start.sh` 重启；curl admin 登录拿
   cookie → GET /api/metrics 看真实 8×A100 + CPU/内存/磁盘；未登录 401。

## 验证清单

- [ ] npm run typecheck 绿
- [ ] npm test 绿（含新 metrics.test.ts）
- [ ] npm run build 绿
- [ ] ./start.sh 重启成功
- [ ] curl 已登录 GET /api/metrics 返回 8 卡（4-7 idle=true / 0-3 带 processes+user）+ cpu/mem/disks
- [ ] curl 未登录 GET /api/metrics 返回 401
