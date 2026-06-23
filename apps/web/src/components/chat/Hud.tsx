import { useState } from 'react';
import type { Hud as HudData } from '@rcc/shared';

/** 占用达此百分比即视为高位 → 切警示色（条 + 数字）。 */
const WARN_AT = 80;

/** 紧凑 token 数：195000→195k，1200000→1.2m。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * 统一度量条：标签 + 细条 + 百分比。上下文/5h/周共用同一外观（同高度、同标签格式、
 * 同配色规则：低=常态 accent、高=警示 danger）。整体一行、可换行不溢出。
 */
function Meter({ label, pct, hint }: { label: string; pct?: number; hint?: string }) {
  const w = Math.max(0, Math.min(100, pct ?? 0));
  const warn = (pct ?? 0) >= WARN_AT;
  return (
    <span className={`hud-meter${warn ? ' warn' : ''}`} title={hint}>
      <span className="hud-meter-label">{label}</span>
      <span className="hud-bar" aria-hidden>
        <span className="hud-bar-fill" style={{ width: `${w}%` }} />
      </span>
      <span className="hud-pct">{pct !== undefined ? `${pct}%` : '—'}</span>
    </span>
  );
}

/**
 * 聊天顶部 HUD 信息条：模型徽标 + 上下文/5h/周三个统一度量（一行紧凑，手机友好可换行）。
 * 数据源优先级 sidecar(statusLine,最完整)→transcript→读屏；usage 缺失（API/无订阅）时
 * 只显示 model+context。点徽标展开看明细（token/来源）+ raw 原文兜底。
 */
export function Hud({
  model,
  contextWindow,
  contextPct,
  contextTokens,
  contextWindowTokens,
  approxContext,
  fiveHour,
  weekly,
  gitBranch,
  source,
  raw,
}: HudData) {
  const [open, setOpen] = useState(false);

  const ctxHint =
    contextTokens !== undefined
      ? `上下文 ${approxContext ? '≈' : ''}${contextPct ?? '?'}% · ${fmtTokens(contextTokens)}${
          contextWindowTokens ? ` / ${fmtTokens(contextWindowTokens)}` : ''
        }`
      : `上下文 ${contextPct ?? '?'}%`;

  return (
    <div className="hud-bar-row">
      <div className="hud-line">
        <button className="hud-model" onClick={() => setOpen((o) => !o)} title="点击查看明细/原文">
          {model ?? 'model'}
          {contextWindow && <em className="hud-win">{contextWindow}</em>}
          <span className="hud-caret" aria-hidden>
            {open ? '▴' : '▾'}
          </span>
        </button>
        <Meter label="ctx" pct={contextPct} hint={ctxHint} />
        {fiveHour && <Meter label="5h" pct={fiveHour.pct} hint={fiveHour.text ? `5 小时用量 · 重置 ${fiveHour.text}` : '5 小时用量'} />}
        {weekly && <Meter label="周" pct={weekly.pct} hint={weekly.text ? `每周用量 · 重置 ${weekly.text}` : '每周用量'} />}
        {gitBranch && (
          <span className="hud-git" title={`git: ${gitBranch}`}>
            ⎇ {gitBranch}
          </span>
        )}
      </div>
      {open && (
        <div className="hud-detail">
          <div className="hud-detail-grid">
            <span>来源</span>
            <span>{source ?? '—'}</span>
            <span>上下文</span>
            <span>
              {approxContext && '≈'}
              {contextPct ?? '?'}%
              {contextTokens !== undefined &&
                ` · ${fmtTokens(contextTokens)}${contextWindowTokens ? ` / ${fmtTokens(contextWindowTokens)}` : ''} tok`}
            </span>
            {fiveHour && (
              <>
                <span>5 小时</span>
                <span>
                  {fiveHour.pct ?? '?'}%{fiveHour.text ? ` · 重置 ${fiveHour.text}` : ''}
                </span>
              </>
            )}
            {weekly && (
              <>
                <span>每周</span>
                <span>
                  {weekly.pct ?? '?'}%{weekly.text ? ` · 重置 ${weekly.text}` : ''}
                </span>
              </>
            )}
          </div>
          {raw && <pre className="hud-raw">{raw}</pre>}
        </div>
      )}
    </div>
  );
}
