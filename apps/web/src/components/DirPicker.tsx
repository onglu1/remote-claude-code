import { useEffect, useState } from 'react';
import { api } from '../lib/api';

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * 逐级点选目录。从配置的浏览根开始，点子目录进入下一级，
 * 「选择此目录」把当前绝对路径回传。全程不用手输。
 */
export function DirPicker({
  onPick,
  onClose,
}: {
  onPick: (absolute: string, name: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState('');
  const [absolute, setAbsolute] = useState('');
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listDirs(path)
      .then((r) => {
        setAbsolute(r.absolute);
        setDirs(r.dirs);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  }, [path]);

  const basename = absolute.split('/').filter(Boolean).pop() ?? '';

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onClose} aria-label="返回">
          ‹
        </button>
        <div className="title">
          选择目录
          <small>{absolute || '…'}</small>
        </div>
      </div>
      <div className="content">
        <div className="crumb">
          <button
            className="btn ghost sm"
            disabled={path === ''}
            onClick={() => setPath(parentOf(path))}
          >
            ‹ 上级
          </button>
          <span className="crumb-path">{absolute}</span>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="list" style={{ gap: 'var(--sp-2)' }}>
          {dirs.map((d) => (
            <button
              key={d.path}
              className="row"
              style={{ padding: 'var(--sp-3) var(--sp-4)' }}
              onClick={() => setPath(d.path)}
            >
              <span style={{ width: 22 }}>📁</span>
              <div className="grow">
                <div className="name">{d.name}</div>
              </div>
              <span className="chev">›</span>
            </button>
          ))}
          {dirs.length === 0 && !error && <div className="empty">这一级没有子目录</div>}
        </div>
      </div>
      <div
        className="keybar"
        style={{ background: 'var(--bg)', borderTop: '1px solid var(--line)' }}
      >
        <button
          className="btn primary block"
          disabled={!absolute}
          onClick={() => onPick(absolute, basename)}
        >
          ✓ 选择此目录{basename ? `：${basename}` : ''}
        </button>
      </div>
    </div>
  );
}
