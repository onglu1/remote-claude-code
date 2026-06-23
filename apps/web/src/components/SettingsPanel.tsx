import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * 用户偏好面板:目前只有"空闲自动关闭(小时)"。
 * - 0 = 关闭功能(空闲不再 kill tmux)
 * - 1..48 = 超过 N 小时无活动 → 自动 close + 写 closedAt
 *
 * 数据来自 GET/PATCH /api/me/settings;成功保存后 1.5s 显示"已保存"。
 * 单字段时直接打开,后续多字段可补 section。
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [hours, setHours] = useState<number>(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (alive) {
          setHours(s.idleCloseHours);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc 关闭(键盘可达,但移动端依赖右上角 ×)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const s = await api.updateSettings({ idleCloseHours: hours });
      setHours(s.idleCloseHours);
      setSavedAt(Date.now());
      window.setTimeout(() => setSavedAt((t) => (t === null || Date.now() - t < 1500 ? t : null)), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  const clamped = (v: number) => Math.max(0, Math.min(48, Math.floor(v) || 0));

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        // 点遮罩关;面板内点击不冒泡
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-panel" role="dialog" aria-label="用户设置">
        <div className="settings-header">
          <h3>设置</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </div>
        <div className="settings-body">
          <div className="field">
            <label htmlFor="idle-close-hours">空闲自动关闭(小时)</label>
            <input
              id="idle-close-hours"
              className="input"
              type="number"
              min={0}
              max={48}
              step={1}
              value={hours}
              onChange={(e) => setHours(clamped(parseInt(e.target.value, 10)))}
              disabled={loading || saving}
              inputMode="numeric"
            />
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              超过 N 小时无任何活动,会话的 tmux 会被关闭以释放资源,transcript
              文件不删,点击休眠会话会自动恢复。0 = 关闭此功能。上限 48。
            </p>
          </div>
          {error && <div className="error">{error}</div>}
          <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'center', marginTop: 'var(--sp-3)' }}>
            <button className="btn primary" onClick={() => void save()} disabled={loading || saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            {savedAt !== null && (
              <span style={{ color: 'var(--ok)', fontSize: 13 }}>已保存</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
