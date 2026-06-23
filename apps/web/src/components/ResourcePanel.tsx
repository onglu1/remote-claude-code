import { useEffect, useState } from 'react';
import type { MetricsSnapshot, MetricsGpu, MetricsDisk } from '@rcc/shared';
import { api } from '../lib/api';

/** 显存等 MiB→GiB 友好显示。 */
function gib(miB: number): string {
  return (miB / 1024).toFixed(miB >= 10 * 1024 ? 0 : 1);
}

/** 通用占用条（pct 0..1）；danger 为 true 时用告警色。 */
function Meter({ pct, danger }: { pct: number; danger?: boolean }) {
  const clamped = Math.max(0, Math.min(1, pct));
  return (
    <div className="res-meter">
      <span
        className={`res-meter-fill${danger ? ' danger' : ''}`}
        style={{ width: `${(clamped * 100).toFixed(1)}%` }}
      />
    </div>
  );
}

function GpuCard({ g }: { g: MetricsGpu }) {
  return (
    <div className={`res-gpu${g.idle ? ' idle' : ' busy'}`}>
      <div className="res-gpu-head">
        <span className="res-gpu-idx">GPU {g.index}</span>
        <span className={`tag ${g.idle ? 'res-free' : 'res-busy'}`}>{g.idle ? '空闲' : '占用'}</span>
        <span className="res-gpu-temp">{g.tempC}°C</span>
      </div>
      <div className="res-gpu-name">{g.name}</div>
      <div className="res-row">
        <span className="res-k">算力</span>
        <Meter pct={g.utilPct / 100} />
        <span className="res-v">{g.utilPct}%</span>
      </div>
      <div className="res-row">
        <span className="res-k">显存</span>
        <Meter pct={g.memTotalMiB ? g.memUsedMiB / g.memTotalMiB : 0} />
        <span className="res-v">
          {gib(g.memUsedMiB)}/{gib(g.memTotalMiB)}G
        </span>
      </div>
      {g.processes.length > 0 && (
        <div className="res-procs">
          {g.processes.map((p, i) => (
            <span className="res-proc" key={`${p.pid}-${i}`}>
              <b>{p.user || '?'}</b>·{p.command || '?'}·{gib(p.memMiB)}G
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DiskRow({ d }: { d: MetricsDisk }) {
  const danger = d.usedPct >= 90;
  return (
    <div className="res-disk">
      <div className="res-row">
        <span className="res-k mono">{d.mount}</span>
        <Meter pct={d.usedPct / 100} danger={danger} />
        <span className={`res-v${danger ? ' danger' : ''}`}>{d.usedPct}%</span>
      </div>
      <div className="res-disk-sub">
        {(d.usedKiB / 1024 / 1024).toFixed(0)} / {(d.totalKiB / 1024 / 1024).toFixed(0)} GiB
      </div>
    </div>
  );
}

export function ResourcePanel({ onBack }: { onBack: () => void }) {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .getMetrics()
        .then((r) => {
          if (alive) {
            setSnap(r.metrics);
            setErr('');
          }
        })
        .catch((e) => {
          if (alive) setErr((e as Error).message);
        });
    tick();
    const id = setInterval(tick, 2000); // 打开时每 2s 刷新
    return () => {
      alive = false;
      clearInterval(id); // 离开页面清掉定时器
    };
  }, []);

  const idleCount = snap?.gpus.filter((g) => g.idle).length ?? 0;
  const gpuTotal = snap?.gpus.length ?? 0;

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onBack} aria-label="返回">
          ‹
        </button>
        <div className="title">
          服务器资源
          <small>
            {snap
              ? snap.gpuAvailable
                ? `${gpuTotal} 卡 · 空闲 ${idleCount}`
                : '本机无 GPU'
              : '加载中…'}
          </small>
        </div>
      </div>

      <div className="content">
        {err && <div className="error">{err}</div>}
        {!snap ? (
          <div className="empty">加载中…</div>
        ) : (
          <>
            {snap.gpuAvailable && (
              <>
                <div className="eyebrow">GPU</div>
                <div className="res-gpu-grid">
                  {snap.gpus.map((g) => (
                    <GpuCard key={g.index} g={g} />
                  ))}
                </div>
              </>
            )}

            <div className="eyebrow">CPU</div>
            <div className="res-block">
              <div className="res-row">
                <span className="res-k">负载</span>
                <Meter pct={snap.cpu.loadPct} danger={snap.cpu.loadPct >= 0.9} />
                <span className="res-v">{Math.round(snap.cpu.loadPct * 100)}%</span>
              </div>
              <div className="res-sub">
                {snap.cpu.cores} 核 · load {snap.cpu.load1.toFixed(2)} / {snap.cpu.load5.toFixed(2)} /{' '}
                {snap.cpu.load15.toFixed(2)}
              </div>
            </div>

            <div className="eyebrow">内存</div>
            <div className="res-block">
              <div className="res-row">
                <span className="res-k">已用</span>
                <Meter
                  pct={snap.mem.totalMiB ? snap.mem.usedMiB / snap.mem.totalMiB : 0}
                  danger={snap.mem.totalMiB > 0 && snap.mem.usedMiB / snap.mem.totalMiB >= 0.9}
                />
                <span className="res-v">
                  {gib(snap.mem.usedMiB)}/{gib(snap.mem.totalMiB)}G
                </span>
              </div>
              <div className="res-sub">可用 {gib(snap.mem.availMiB)} GiB</div>
            </div>

            <div className="eyebrow">磁盘</div>
            <div className="res-block">
              {snap.disks.length === 0 ? (
                <div className="res-sub">无可用挂载信息</div>
              ) : (
                snap.disks.map((d) => <DiskRow key={d.mount} d={d} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
