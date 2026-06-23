import { useState } from 'react';
import type { RewindItem, RewindMode } from '@rcc/shared';

const MODE_CN: Record<RewindMode, string> = {
  both: '恢复代码+对话',
  conversation: '仅对话',
  code: '仅代码',
};

/** 结构化回退面板：列表 → 选恢复模式 → 二次确认（防误触）。 */
export function RewindPanel({
  items,
  busy,
  onExecute,
  onClose,
}: {
  items: RewindItem[];
  busy: boolean;
  onExecute: (index: number, mode: RewindMode) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [mode, setMode] = useState<RewindMode | null>(null);
  const pickedItem = items.find((i) => i.index === picked);

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">回退到检查点</div>

        {/* 第一步：选 checkpoint */}
        {picked === null && (
          <div className="rw-list">
            {items.length === 0 && <div className="empty">暂无可回退点</div>}
            {items.map((it) => (
              <button key={it.index} className="rw-item" onClick={() => setPicked(it.index)}>
                <div className="rw-label">{it.label}</div>
                <div className="rw-changes">{it.changes}</div>
              </button>
            ))}
          </div>
        )}

        {/* 第二步：选恢复模式 */}
        {picked !== null && mode === null && (
          <div className="rw-modes">
            <div className="rw-sub">{pickedItem?.label}</div>
            {(['both', 'conversation', 'code'] as RewindMode[]).map((m) => (
              <button key={m} className="btn block" onClick={() => setMode(m)}>
                {MODE_CN[m]}
              </button>
            ))}
            <button className="btn ghost" onClick={() => setPicked(null)}>
              ‹ 返回
            </button>
          </div>
        )}

        {/* 第三步：二次确认（防误触） */}
        {picked !== null && mode !== null && (
          <div className="rw-confirm">
            <p>
              确认将「<b>{MODE_CN[mode]}</b>」回退到此处？
              <br />
              此操作不可轻易撤销。
            </p>
            <div className="rw-actions">
              <button className="btn ghost" disabled={busy} onClick={() => setMode(null)}>
                取消
              </button>
              <button className="btn primary" disabled={busy} onClick={() => onExecute(picked, mode)}>
                {busy ? '回退中…' : '确认回退'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
