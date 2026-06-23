import { describe, it, expect } from 'vitest';
import {
  parseGpuCsv,
  parseComputeAppsCsv,
  parseGpuUuidIndex,
  parsePsUsers,
  parseMeminfo,
  parseDf,
  mergeGpus,
  cpuFromOs,
  MetricsSampler,
} from './metrics';

/* 本机实测样本（2026-06-21，8× A100；GPU0-3 在跑同一进程 pid4111566/alice/python，GPU4-7 空闲）。 */
const GPU_CSV = `0, NVIDIA A100-PCIE-40GB, 10, 27417, 40960, 35
1, NVIDIA A100-PCIE-40GB, 12, 29935, 40960, 36
2, NVIDIA A100-PCIE-40GB, 16, 29935, 40960, 37
3, NVIDIA A100-PCIE-40GB, 8, 21875, 40960, 34
4, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 32
5, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 32
6, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 34
7, NVIDIA A100-PCIE-40GB, 0, 3, 40960, 33`;

const APPS_CSV = `GPU-106d9047-aedb-8a57-b4c6-dff9e95be091, 4111566, 27408
GPU-4f788396-e646-2f8e-7a0b-0c9238f26dc6, 4111566, 29926
GPU-423155c3-6418-afbc-f57d-457bae97bb9e, 4111566, 29926
GPU-015c98b5-f4e1-7c42-01d7-32a023c23002, 4111566, 21866`;

const UUID_INDEX = `0, GPU-106d9047-aedb-8a57-b4c6-dff9e95be091
1, GPU-4f788396-e646-2f8e-7a0b-0c9238f26dc6
2, GPU-423155c3-6418-afbc-f57d-457bae97bb9e
3, GPU-015c98b5-f4e1-7c42-01d7-32a023c23002
4, GPU-fd684f46-3518-14f0-f0de-dd6a939d9cdb
5, GPU-f6327ec2-0791-53cb-ac29-730b8b169204
6, GPU-623e5a61-3f49-31f9-381a-04e836b3df1d
7, GPU-25d04b02-15ba-5ee3-e9d5-085a41c89a3f`;

// ps -o pid=,user:32=,comm=（加宽列宽，长用户名不被截断为 zhangre+）
const PS_OUT = `4111566 alice                     python`;

const MEMINFO = `MemTotal:       660485696 kB
MemFree:        28383060 kB
MemAvailable:   623006972 kB
Buffers:         1234567 kB`;

const DF_OUT = `Filesystem     1024-blocks       Used Available Capacity Mounted on
udev             330196572          0 330196572       0% /dev
tmpfs             66048572       1396  66047176       1% /run
/dev/sda1        515923476  356855516 137975800      73% /
tmpfs            330242848      70272 330172576       1% /dev/shm
/dev/sdb        1030992024  954932224  23614616      98% /backup
/dev/sdc1       2579152636 2330887420 117176888      96% /mnt
/dev/sdd1       2063104400 1795537940 162692528      92% /mnt1
tmpfs             66048568         24  66048544       1% /run/user/0`;

describe('parseGpuCsv', () => {
  it('解析 8 行每卡字段', () => {
    const rows = parseGpuCsv(GPU_CSV);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({
      index: 0,
      name: 'NVIDIA A100-PCIE-40GB',
      utilPct: 10,
      memUsedMiB: 27417,
      memTotalMiB: 40960,
      tempC: 35,
    });
    // 空闲卡：util 0、显存 3MiB
    expect(rows[4].utilPct).toBe(0);
    expect(rows[4].memUsedMiB).toBe(3);
  });

  it('空输出 → 空数组', () => {
    expect(parseGpuCsv('')).toEqual([]);
    expect(parseGpuCsv('\n  \n')).toEqual([]);
  });
});

describe('parseComputeAppsCsv', () => {
  it('解析 4 条进程占用', () => {
    const apps = parseComputeAppsCsv(APPS_CSV);
    expect(apps).toHaveLength(4);
    expect(apps[0]).toEqual({
      uuid: 'GPU-106d9047-aedb-8a57-b4c6-dff9e95be091',
      pid: 4111566,
      memMiB: 27408,
    });
  });

  it('无进程时 nvidia-smi 多打印的提示行被忽略 → 空', () => {
    expect(parseComputeAppsCsv('')).toEqual([]);
    // 某些环境无进程会打印一行说明，不含逗号分隔的三段数字 → 跳过
    expect(parseComputeAppsCsv('No running processes found')).toEqual([]);
  });
});

describe('parseGpuUuidIndex', () => {
  it('uuid → index 映射', () => {
    const m = parseGpuUuidIndex(UUID_INDEX);
    expect(m.get('GPU-106d9047-aedb-8a57-b4c6-dff9e95be091')).toBe(0);
    expect(m.get('GPU-25d04b02-15ba-5ee3-e9d5-085a41c89a3f')).toBe(7);
    expect(m.size).toBe(8);
  });
});

describe('parsePsUsers', () => {
  it('pid → user/command（长用户名不截断）', () => {
    const m = parsePsUsers(PS_OUT);
    expect(m.get(4111566)).toEqual({ user: 'alice', command: 'python' });
  });

  it('多行 + 命令名含空格取最后段为 comm 前的属主', () => {
    const m = parsePsUsers('111 alice python\n222 bob  node');
    expect(m.get(111)).toEqual({ user: 'alice', command: 'python' });
    expect(m.get(222)).toEqual({ user: 'bob', command: 'node' });
  });

  it('空输出 → 空 map', () => {
    expect(parsePsUsers('').size).toBe(0);
  });
});

describe('mergeGpus', () => {
  it('把进程并入对应卡并判定 idle', () => {
    const gpus = mergeGpus(
      parseGpuCsv(GPU_CSV),
      parseComputeAppsCsv(APPS_CSV),
      parseGpuUuidIndex(UUID_INDEX),
      parsePsUsers(PS_OUT),
    );
    expect(gpus).toHaveLength(8);
    // GPU0：繁忙，带 1 进程 user=alice command=python memMiB=27408
    expect(gpus[0].idle).toBe(false);
    expect(gpus[0].processes).toEqual([
      { pid: 4111566, user: 'alice', command: 'python', memMiB: 27408 },
    ]);
    // GPU3：也繁忙
    expect(gpus[3].idle).toBe(false);
    expect(gpus[3].processes[0].memMiB).toBe(21866);
    // GPU4-7：空闲，无进程
    for (const i of [4, 5, 6, 7]) {
      expect(gpus[i].idle).toBe(true);
      expect(gpus[i].processes).toEqual([]);
    }
  });

  it('进程的 pid 在 ps 里查不到时 user/command 留空但仍记 memMiB', () => {
    const gpus = mergeGpus(
      parseGpuCsv(GPU_CSV),
      parseComputeAppsCsv(APPS_CSV),
      parseGpuUuidIndex(UUID_INDEX),
      new Map(), // ps 全空
    );
    expect(gpus[0].processes[0]).toEqual({
      pid: 4111566,
      user: '',
      command: '',
      memMiB: 27408,
    });
    expect(gpus[0].idle).toBe(false);
  });

  it('util>0 但无进程也算繁忙（保守不误判空闲）', () => {
    const gpus = mergeGpus(
      [{ index: 0, name: 'x', utilPct: 5, memUsedMiB: 10, memTotalMiB: 40960, tempC: 30 }],
      [],
      new Map(),
      new Map(),
    );
    expect(gpus[0].idle).toBe(false);
  });
});

describe('cpuFromOs', () => {
  it('核数 + loadavg + 负载率', () => {
    const cpu = cpuFromOs(80, [5.54, 5.85, 5.25]);
    expect(cpu.cores).toBe(80);
    expect(cpu.load1).toBe(5.54);
    expect(cpu.load5).toBe(5.85);
    expect(cpu.load15).toBe(5.25);
    expect(cpu.loadPct).toBeCloseTo(5.54 / 80, 4);
  });

  it('cores 为 0 时不除零', () => {
    expect(cpuFromOs(0, [1, 1, 1]).loadPct).toBe(0);
  });
});

describe('parseMeminfo', () => {
  it('kB → MiB，used=total-avail', () => {
    const mem = parseMeminfo(MEMINFO);
    // 660485696 kB = 660485696/1024 MiB ≈ 644race; 用整数下取
    expect(mem.totalMiB).toBe(Math.round(660485696 / 1024));
    expect(mem.availMiB).toBe(Math.round(623006972 / 1024));
    expect(mem.usedMiB).toBe(mem.totalMiB - mem.availMiB);
  });

  it('缺 MemAvailable 时退化用 MemFree', () => {
    const mem = parseMeminfo('MemTotal: 1048576 kB\nMemFree: 524288 kB');
    expect(mem.totalMiB).toBe(1024);
    expect(mem.availMiB).toBe(512);
  });
});

describe('parseDf', () => {
  it('过滤伪文件系统，保留真实挂载', () => {
    const disks = parseDf(DF_OUT);
    const mounts = disks.map((d) => d.mount).sort();
    expect(mounts).toEqual(['/', '/backup', '/mnt', '/mnt1']);
    // 不含 tmpfs/udev 的挂载点
    expect(mounts).not.toContain('/dev');
    expect(mounts).not.toContain('/run');
    expect(mounts).not.toContain('/dev/shm');
  });

  it('根盘字段与占用率正确', () => {
    const disks = parseDf(DF_OUT);
    const root = disks.find((d) => d.mount === '/')!;
    expect(root.totalKiB).toBe(515923476);
    expect(root.usedKiB).toBe(356855516);
    expect(root.availKiB).toBe(137975800);
    // usedPct = used/(used+avail)*100，与 df 的 73% 一致
    expect(root.usedPct).toBe(72);
  });

  it('空/仅表头 → 空数组', () => {
    expect(parseDf('')).toEqual([]);
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on')).toEqual([]);
  });
});

describe('MetricsSampler', () => {
  /** 构造一个记录 run 调用次数、按 cmd 返回固定样本的注入 sampler。 */
  function makeSampler(opts: { gpuThrows?: boolean } = {}) {
    let runCalls = 0;
    let nowMs = 1_000_000;
    const run = (cmd: string): string => {
      runCalls++;
      if (cmd.includes('--query-gpu=index,name')) {
        if (opts.gpuThrows) throw new Error('nvidia-smi not found');
        return GPU_CSV;
      }
      if (cmd.includes('--query-compute-apps')) return APPS_CSV;
      if (cmd.includes('--query-gpu=index,uuid')) return UUID_INDEX;
      if (cmd.startsWith('ps ')) return PS_OUT;
      if (cmd.startsWith('df ')) return DF_OUT;
      return '';
    };
    const sampler = new MetricsSampler({
      run,
      readMeminfo: () => MEMINFO,
      cpus: () => 80,
      loadavg: () => [5.54, 5.85, 5.25],
      now: () => nowMs,
      ttlMs: 1500,
    });
    return {
      sampler,
      get runCalls() {
        return runCalls;
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('返回完整快照（8 卡 + cpu/mem/disks）', async () => {
    const { sampler } = makeSampler();
    const snap = await sampler.getSnapshot();
    expect(snap.gpuAvailable).toBe(true);
    expect(snap.gpus).toHaveLength(8);
    expect(snap.gpus[4].idle).toBe(true);
    expect(snap.gpus[0].processes[0].user).toBe('alice');
    expect(snap.cpu.cores).toBe(80);
    expect(snap.mem.totalMiB).toBeGreaterThan(0);
    expect(snap.disks.map((d) => d.mount)).toContain('/');
    expect(snap.ts).toBe(1_000_000);
  });

  it('TTL 内第二次命中缓存（不再调用 run）', async () => {
    const h = makeSampler();
    await h.sampler.getSnapshot();
    const after1 = h.runCalls;
    expect(after1).toBeGreaterThan(0);
    await h.sampler.getSnapshot(); // 仍在 1500ms 内
    expect(h.runCalls).toBe(after1); // 没新增调用
  });

  it('TTL 过期后重新采样', async () => {
    const h = makeSampler();
    await h.sampler.getSnapshot();
    const after1 = h.runCalls;
    h.advance(2000); // 超过 ttl
    await h.sampler.getSnapshot();
    expect(h.runCalls).toBeGreaterThan(after1);
  });

  it('并发首访共享同一次采样', async () => {
    const h = makeSampler();
    const [a, b] = await Promise.all([h.sampler.getSnapshot(), h.sampler.getSnapshot()]);
    expect(a).toBe(b); // 同一对象
    // 仅采样一轮：run 次数 = 单轮固定数（gpu+apps+uuid+ps+df = 5）
    expect(h.runCalls).toBe(5);
  });

  it('GPU 采集失败时降级：gpuAvailable=false、gpus 空，但 cpu/mem/disks 仍在', async () => {
    const { sampler } = makeSampler({ gpuThrows: true });
    const snap = await sampler.getSnapshot();
    expect(snap.gpuAvailable).toBe(false);
    expect(snap.gpus).toEqual([]);
    expect(snap.cpu.cores).toBe(80);
    expect(snap.mem.totalMiB).toBeGreaterThan(0);
    expect(snap.disks.map((d) => d.mount)).toContain('/');
  });
});
