import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * 任意层级目录选择器:
 *   - 默认起步 = 当前用户 home(后端按 req.user.unixUser 决定)
 *   - "上级"按钮回到上一层(到 / 时禁用)
 *   - "我的家"按钮跳回 home
 *   - 任何能 readdir 的目录都可"选这里"作为项目根
 *
 * 多用户隔离设计 + UX 改造 2026-06-23:不再有 root/relPath 概念,全用绝对路径。
 */
export function DirPicker({
  onPick,
  onClose,
}: {
  onPick: (absolute: string, name: string) => void;
  onClose: () => void;
}) {
  // 空串 = 让后端定默认起步(用户 home)
  const [path, setPath] = useState('');
  const [current, setCurrent] = useState('');
  const [home, setHome] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listDirs(path)
      .then((r) => {
        setCurrent(r.path);
        setHome(r.home);
        setParent(r.parent);
        setDirs(r.dirs);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  }, [path]);

  const basename = current.split('/').filter(Boolean).pop() ?? '';
  const atHome = current === home;

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onClose} aria-label="返回">
          ‹
        </button>
        <div className="title">
          选择目录
          <small>{current || '…'}</small>
        </div>
      </div>
      <div className="content">
        <div
          className="crumb"
          style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}
        >
          <button
            className="btn ghost sm"
            disabled={parent === null}
            onClick={() => parent !== null && setPath(parent)}
            title={parent === null ? '已在根目录' : `回到 ${parent}`}
          >
            ‹ 上级
          </button>
          <button
            className="btn ghost sm"
            disabled={atHome}
            onClick={() => setPath(home)}
            title={`回到家:${home}`}
          >
            🏠 我的家
          </button>
          <span className="crumb-path" style={{ marginLeft: 'auto', opacity: 0.7 }}>
            {current}
          </span>
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
          disabled={!current}
          onClick={() => onPick(current, basename)}
        >
          ✓ 选择此目录{basename ? `:${basename}` : ''}
        </button>
      </div>
    </div>
  );
}
