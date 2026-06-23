import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import type {
  MetricsCpu,
  MetricsDisk,
  MetricsGpu,
  MetricsGpuProcess,
  MetricsMem,
  MetricsSnapshot,
} from '@rcc/shared';

/**
 * 整机资源采集：解析逻辑全为纯函数 + 注入式命令执行器，便于单测喂真实样本字符串、
 * 不依赖真实 GPU。MetricsSampler 带 TTL 缓存与分项容错（GPU 不可用不拖垮其它）。
 */

/** 单卡静态字段（不含 idle / processes，后者由 mergeGpus 补）。 */
export type GpuRow = Omit<MetricsGpu, 'idle' | 'processes'>;

const KIB_PER_MIB = 1024;

/** 把 csv 一行按逗号切并 trim。 */
function csvCells(line: string): string[] {
  return line.split(',').map((c) => c.trim());
}

/** 非空行迭代（去 \r、丢空白行）。 */
function lines(out: string): string[] {
  return out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * 解析 `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu
 * --format=csv,noheader,nounits`。
 */
export function parseGpuCsv(out: string): GpuRow[] {
  const rows: GpuRow[] = [];
  for (const line of lines(out)) {
    const c = csvCells(line);
    if (c.length < 6) continue;
    const index = Number(c[0]);
    if (!Number.isFinite(index)) continue;
    rows.push({
      index,
      name: c[1],
      utilPct: Number(c[2]) || 0,
      memUsedMiB: Number(c[3]) || 0,
      memTotalMiB: Number(c[4]) || 0,
      tempC: Number(c[5]) || 0,
    });
  }
  return rows;
}

/** 解析 `--query-compute-apps=gpu_uuid,pid,used_memory`。无进程的说明行（非三段数字）跳过。 */
export function parseComputeAppsCsv(out: string): { uuid: string; pid: number; memMiB: number }[] {
  const apps: { uuid: string; pid: number; memMiB: number }[] = [];
  for (const line of lines(out)) {
    const c = csvCells(line);
    if (c.length < 3) continue;
    const pid = Number(c[1]);
    const memMiB = Number(c[2]);
    if (!c[0].startsWith('GPU-') || !Number.isFinite(pid)) continue;
    apps.push({ uuid: c[0], pid, memMiB: Number.isFinite(memMiB) ? memMiB : 0 });
  }
  return apps;
}

/** 解析 `--query-gpu=index,uuid --format=csv,noheader` → uuid→index。 */
export function parseGpuUuidIndex(out: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of lines(out)) {
    const c = csvCells(line);
    if (c.length < 2) continue;
    const index = Number(c[0]);
    if (!Number.isFinite(index) || !c[1].startsWith('GPU-')) continue;
    m.set(c[1], index);
  }
  return m;
}

/**
 * 解析 `ps -o pid=,user:32=,comm= -p <pids>` → pid→{user,command}。
 * 行形如 "4111566 alice   python"（user 列加宽避免截断）。
 * 取首段为 pid、末段为 comm、中间为 user。
 */
export function parsePsUsers(out: string): Map<number, { user: string; command: string }> {
  const m = new Map<number, { user: string; command: string }>();
  for (const line of lines(out)) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    if (!Number.isFinite(pid)) continue;
    const command = parts[parts.length - 1];
    const user = parts.slice(1, parts.length - 1).join(' ');
    m.set(pid, { user, command });
  }
  return m;
}

/** 解析 /proc/meminfo 的 MemTotal/MemAvailable(退化 MemFree) → MiB。 */
export function parseMeminfo(out: string): MetricsMem {
  const get = (key: string): number | null => {
    const re = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm');
    const mm = re.exec(out);
    return mm ? Number(mm[1]) : null;
  };
  const totalKiB = get('MemTotal') ?? 0;
  const availKiB = get('MemAvailable') ?? get('MemFree') ?? 0;
  const totalMiB = Math.round(totalKiB / KIB_PER_MIB);
  const availMiB = Math.round(availKiB / KIB_PER_MIB);
  return { totalMiB, availMiB, usedMiB: Math.max(0, totalMiB - availMiB) };
}

/** df -P -k 输出里要剔除的伪文件系统类型 / 设备前缀。 */
const PSEUDO_FS = /^(udev|tmpfs|devtmpfs|overlay|squashfs|none)$/;
const PSEUDO_DEV = /^(\/dev\/loop|tmpfs|udev|overlay)/;

/**
 * 解析 `df -P -k`（POSIX、单位 KiB）。过滤 tmpfs/udev/loop/squashfs 等伪文件系统，
 * 只留真实挂载。usedPct 用 used/(used+avail)（与 df 的 Capacity 含保留块口径一致），
 * used+avail 为 0 时退化用 total。
 */
export function parseDf(out: string): MetricsDisk[] {
  const disks: MetricsDisk[] = [];
  const all = lines(out);
  for (const line of all) {
    if (/^Filesystem\b/.test(line)) continue; // 表头
    const c = line.split(/\s+/).filter(Boolean);
    // 期望：Filesystem 1024-blocks Used Available Capacity Mounted-on（>=6 段）
    if (c.length < 6) continue;
    const fs = c[0];
    if (PSEUDO_FS.test(fs) || PSEUDO_DEV.test(fs)) continue;
    const totalKiB = Number(c[1]);
    const usedKiB = Number(c[2]);
    const availKiB = Number(c[3]);
    const mount = c.slice(5).join(' ');
    if (!Number.isFinite(totalKiB) || totalKiB <= 0) continue;
    const denom = usedKiB + availKiB > 0 ? usedKiB + availKiB : totalKiB;
    const usedPct = Math.round((usedKiB / denom) * 100);
    disks.push({ mount, totalKiB, usedKiB, availKiB, usedPct });
  }
  return disks;
}

/** 由 os.cpus().length 与 os.loadavg() 组装 CPU 指标。 */
export function cpuFromOs(cores: number, load: number[]): MetricsCpu {
  const [load1 = 0, load5 = 0, load15 = 0] = load;
  return {
    cores,
    load1,
    load5,
    load15,
    loadPct: cores > 0 ? load1 / cores : 0,
  };
}

/**
 * 把每进程占用并入对应 GPU、判定 idle。
 * idle := utilPct===0 且 该卡无计算进程（有进程占显存即繁忙，别人不该上）。
 */
export function mergeGpus(
  rows: GpuRow[],
  apps: { uuid: string; pid: number; memMiB: number }[],
  uuidIndex: Map<string, number>,
  psMap: Map<number, { user: string; command: string }>,
): MetricsGpu[] {
  const procsByIndex = new Map<number, MetricsGpuProcess[]>();
  for (const app of apps) {
    const idx = uuidIndex.get(app.uuid);
    if (idx === undefined) continue;
    const info = psMap.get(app.pid);
    const proc: MetricsGpuProcess = {
      pid: app.pid,
      user: info?.user ?? '',
      command: info?.command ?? '',
      memMiB: app.memMiB,
    };
    const list = procsByIndex.get(idx) ?? [];
    list.push(proc);
    procsByIndex.set(idx, list);
  }
  return rows.map((r) => {
    const processes = procsByIndex.get(r.index) ?? [];
    return { ...r, processes, idle: r.utilPct === 0 && processes.length === 0 };
  });
}

/** 注入式命令执行器：返回 stdout 文本，失败抛错。 */
export type RunFn = (cmd: string) => string;

export interface MetricsSamplerDeps {
  run?: RunFn;
  readMeminfo?: () => string;
  cpus?: () => number;
  loadavg?: () => number[];
  now?: () => number;
  /** 缓存 TTL，默认 1500ms。 */
  ttlMs?: number;
}

const defaultRun: RunFn = (cmd) =>
  execSync(cmd, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * 整机采样器：getSnapshot() 异步返回结构化快照，带 TTL 缓存（并发首访共享一次采样，
 * 避免频繁 spawn nvidia-smi）。各分项容错：GPU 整组失败→空列表+gpuAvailable=false；
 * 内存/磁盘各自退化，互不拖垮。
 */
export class MetricsSampler {
  private readonly run: RunFn;
  private readonly readMeminfo: () => string;
  private readonly cpus: () => number;
  private readonly loadavg: () => number[];
  private readonly now: () => number;
  private readonly ttlMs: number;

  private cached: MetricsSnapshot | null = null;
  private cachedAt = 0;
  private inFlight: Promise<MetricsSnapshot> | null = null;

  constructor(deps: MetricsSamplerDeps = {}) {
    this.run = deps.run ?? defaultRun;
    this.readMeminfo = deps.readMeminfo ?? (() => readFileSync('/proc/meminfo', 'utf8'));
    this.cpus = deps.cpus ?? (() => os.cpus().length);
    this.loadavg = deps.loadavg ?? (() => os.loadavg());
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? 1500;
  }

  async getSnapshot(): Promise<MetricsSnapshot> {
    const t = this.now();
    if (this.cached && t - this.cachedAt < this.ttlMs) return this.cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sample(t).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sample(ts: number): Promise<MetricsSnapshot> {
    const snap: MetricsSnapshot = {
      ...this.sampleGpus(),
      cpu: this.sampleCpu(),
      mem: this.sampleMem(),
      disks: this.sampleDisks(),
      ts,
    };
    this.cached = snap;
    this.cachedAt = ts;
    return snap;
  }

  private sampleGpus(): { gpus: MetricsGpu[]; gpuAvailable: boolean } {
    try {
      const rows = parseGpuCsv(
        this.run(
          'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
        ),
      );
      const apps = parseComputeAppsCsv(
        this.run(
          'nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits',
        ),
      );
      const uuidIndex = parseGpuUuidIndex(
        this.run('nvidia-smi --query-gpu=index,uuid --format=csv,noheader'),
      );
      const pids = [...new Set(apps.map((a) => a.pid))];
      const psMap =
        pids.length > 0 ? parsePsUsers(this.run(`ps -o pid=,user:32=,comm= -p ${pids.join(',')}`)) : new Map();
      return { gpus: mergeGpus(rows, apps, uuidIndex, psMap), gpuAvailable: true };
    } catch {
      // 无 nvidia-smi 或采集失败：降级，不影响其它分项。
      return { gpus: [], gpuAvailable: false };
    }
  }

  private sampleCpu(): MetricsCpu {
    try {
      return cpuFromOs(this.cpus(), this.loadavg());
    } catch {
      return { cores: 0, load1: 0, load5: 0, load15: 0, loadPct: 0 };
    }
  }

  private sampleMem(): MetricsMem {
    try {
      return parseMeminfo(this.readMeminfo());
    } catch {
      // 退化：用 os 的 total/free（不如 meminfo 的 available 准，但兜底可用）。
      const totalMiB = Math.round(os.totalmem() / 1024 / 1024);
      const availMiB = Math.round(os.freemem() / 1024 / 1024);
      return { totalMiB, availMiB, usedMiB: Math.max(0, totalMiB - availMiB) };
    }
  }

  private sampleDisks(): MetricsDisk[] {
    try {
      return parseDf(this.run('df -P -k'));
    } catch {
      return [];
    }
  }
}
