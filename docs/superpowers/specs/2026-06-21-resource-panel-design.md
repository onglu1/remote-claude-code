# 服务器资源实时面板（CPU / GPU / 内存 / 磁盘）设计

日期：2026-06-21
状态：已与用户确认方案，进入实现

## 背景与问题

这台机器是多人共用的 8 卡 A100 服务器。用户在网页里挑卡跑任务时，**看不到哪块 GPU 已经被别人占着**，很容易撞卡（两个进程挤同一张卡，显存/算力打架）。诉求：一个手机优先的实时面板，**重点是 GPU**——一眼看出哪块空闲、哪块在跑、**是谁在跑**；CPU、内存、磁盘也要有，作为整机健康概览。

约束（项目硬规则）：
- 并行增量添加，不动现有功能；新页面从项目列表顶部入口进入，App 加一个 view 状态切过去。
- 解析逻辑全抽成纯函数 + 依赖注入命令执行器，单测喂真实样本字符串、不依赖真实 GPU。
- 任意登录用户可见（服务器全局信息，不按项目过滤）；未登录 401。
- 不引入新依赖、前端不用浏览器存储。

## 实测命令与真实输出（本机，2026-06-21）

本机：8× NVIDIA A100-PCIE-40GB；80 核；主盘 `/dev/sda1` 挂 `/`。

每卡（utilization.gpu / memory.used / memory.total / temperature.gpu）：

    nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits

    0, NVIDIA A100-PCIE-40GB, 10, 27417, 40960, 35
    1, NVIDIA A100-PCIE-40GB, 12, 29935, 40960, 36
    2, NVIDIA A100-PCIE-40GB, 16, 29935, 40960, 37
    3, NVIDIA A100-PCIE-40GB, 8, 21875, 40960, 34
    4, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 32
    5, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 32
    6, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 34
    7, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 33

每进程占用（gpu_uuid / pid / used_memory）：

    nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits

    GPU-106d9047-aedb-8a57-b4c6-dff9e95be091, 4111566, 27408
    GPU-4f788396-e646-2f8e-7a0b-0c9238f26dc6, 4111566, 29926
    GPU-423155c3-6418-afbc-f57d-457bae97bb9e, 4111566, 29926
    GPU-015c98b5-f4e1-7c42-01d7-32a023c23002, 4111566, 21866

uuid→index 映射：

    nvidia-smi --query-gpu=index,uuid --format=csv,noheader

    0, GPU-106d9047-aedb-8a57-b4c6-dff9e95be091
    ... 7, GPU-25d04b02-15ba-5ee3-e9d5-085a41c89a3f

进程归属（谁在跑）——**关键坑：默认 user 列宽 8 会截断长用户名为 `zhangre+`**，必须加宽列宽：

    ps -o pid=,user:32=,comm= -p 4111566

    4111566 alice                     python

CPU：`os.cpus().length`=80、`os.loadavg()`=[5.54,5.85,5.25]，负载率≈load1/核数。
内存（`/proc/meminfo`，比 os.freemem 准）：MemTotal 660485696 kB、MemAvailable 623006972 kB；used=total-avail。
磁盘（`df -P -k`，单位 KiB）：真实挂载 `/`(73%) `/backup`(98%) `/mnt`(96%) `/mnt1`(92%)；**需过滤** udev/tmpfs/devtmpfs/loop/squashfs/overlay 等伪文件系统。

## 快照结构（放 packages/shared/src/schemas.ts，前端共享类型）

```
MetricsGpuProcess { pid:number; user:string; command:string; memMiB:number }
MetricsGpu {
  index:number; name:string; utilPct:number;
  memUsedMiB:number; memTotalMiB:number; tempC:number;
  idle:boolean; processes:MetricsGpuProcess[];
}
MetricsCpu  { cores:number; load1:number; load5:number; load15:number; loadPct:number }
MetricsMem  { totalMiB:number; usedMiB:number; availMiB:number }
MetricsDisk { mount:string; totalKiB:number; usedKiB:number; availKiB:number; usedPct:number }
MetricsSnapshot {
  gpus:MetricsGpu[]; gpuAvailable:boolean;   // 无 nvidia-smi 时 gpus=[] 且 gpuAvailable=false
  cpu:MetricsCpu; mem:MetricsMem; disks:MetricsDisk[];
  ts:number;                                  // 采样毫秒时间戳
}
```

**idle 判定**：`utilPct === 0 && processes.length === 0`。理由：A100 空闲卡 util 恒为 0、且无 compute-app；只要有进程占着就算繁忙（即便瞬时 util 低，显存被占住别人也不该上）。不引入"低利用率阈值"以免把别人显存占着但算力空窗的卡误判为空闲。

## 模块划分

### apps/server/src/lib/metrics.ts（+ metrics.test.ts）

纯函数（全部可单测，输入字符串输出结构）：
- `parseGpuCsv(out)` → `Omit<MetricsGpu,'idle'|'processes'>[]`
- `parseComputeAppsCsv(out)` → `{ uuid; pid; memMiB }[]`
- `parseGpuUuidIndex(out)` → `Map<uuid, index>`
- `parsePsUsers(out)` → `Map<pid, {user;command}>`
- `parseMeminfo(out)` → `MetricsMem`
- `parseDf(out)` → `MetricsDisk[]`（含伪文件系统过滤）
- `mergeGpus(gpuRows, apps, uuidIndex, psMap)` → `MetricsGpu[]`（把进程并入对应卡、算 idle）
- `cpuFromOs(cores, loadavg)` → `MetricsCpu`

`run(cmd:string):string` 注入式命令执行器（默认实现用 `child_process.execSync`，超时 + 失败抛错）。

`MetricsSampler`：
- 构造注入 `{ run, readMeminfo, cpus, loadavg, now, ttlMs=1500 }`（IO 全可替身）。
- `getSnapshot()` 异步，TTL 缓存（默认 1500ms）：缓存未过期直接返回上次快照；并发首访共享同一次进行中的采样（用一个 in-flight Promise）。
- 容错：GPU 采集（nvidia-smi×3 + ps）整体 try/catch，失败 → `gpus:[], gpuAvailable:false`，**不影响** CPU/内存/磁盘；磁盘/内存各自 try/catch 退化（meminfo 失败退 os.totalmem/freemem；df 失败返回 []）。

### apps/server/src/routes/metrics.ts

`GET /api/metrics`，挂 `requireAuth`（任意登录用户）。路由内持有单例 `MetricsSampler`（每路由注册一次，复用缓存）。返回 `{ metrics: MetricsSnapshot }`。

在 app.ts 注册 `registerMetricsRoutes`。

### 前端

- `lib/api.ts` 加 `getMetrics()`。
- 新增 `components/ResourcePanel.tsx`：手机优先。
  - GPU 卡片网格：空闲卡（绿/ok 边框 + "空闲"标签）与繁忙卡（clay/accent 边框 + 进程标签）颜色明确区分，直接服务"挑空卡"。每卡：序号+名、利用率%、显存条(used/total)、温度、进程小标签(user·命令·显存)。
  - CPU：负载条(loadPct) + 核数 + load1/5/15。
  - 内存：used/total 条。
  - 磁盘：每挂载一条（mount + used/total + usedPct），高占用(≥90%)标红。
  - 打开每 2s 轮询 `/api/metrics`；离开/卸载清定时器。沿用 tokens.css/index.css 变量与既有 class（.row/.tag/.btn/.topbar），新增少量 .res-* 样式。
- `ProjectList` 顶栏加「资源」按钮；`App.tsx` 加 `{name:'metrics'}` view 切过去（任意登录用户）。

## 测试要点（TDD，先写）

metrics.test.ts 用上面真实样本字符串断言：
- parseGpuCsv：8 行、字段类型与数值正确。
- parseComputeAppsCsv / parseGpuUuidIndex / parsePsUsers：解析正确；ps 长用户名不被截断（喂 `alice`）。
- mergeGpus：GPU0-3 带 1 个进程 user=alice command=python、idle=false；GPU4-7 processes=[] 且 idle=true。
- parseDf：过滤 tmpfs/udev，保留 `/` `/backup` `/mnt` `/mnt1`；usedPct 由 used/(used+avail) 或直接 used/total 计算。
- parseMeminfo：totalMiB/availMiB/usedMiB 正确（kB→MiB）。
- MetricsSampler：TTL 内第二次 getSnapshot 不再调用 run（命中缓存，用计数 fake 验证）；GPU run 抛错时 gpuAvailable=false 但 cpu/mem/disks 仍在。

## 遗留与风险

- df 在某些挂载点可能因权限/坏盘卡住；execSync 设超时兜底。
- nvidia-smi 调用频次受 1.5s TTL 保护，避免高并发刷爆。
- 进程命令名只取 comm（短名 python），不取完整 cmdline（避免泄露参数/路径、且更短适合手机）。
