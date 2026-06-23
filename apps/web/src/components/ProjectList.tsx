import { useEffect, useState } from 'react';
import type { Project, AuthUser } from '@rcc/shared';
import { api } from '../lib/api';
import { DirPicker } from './DirPicker';

export function ProjectList({
  user,
  onOpen,
  onOpenMetrics,
  onOpenUsers,
  onLock,
}: {
  user: AuthUser;
  onOpen: (p: Project) => void;
  onOpenMetrics: () => void;
  onOpenUsers: () => void;
  onLock: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [adding, setAdding] = useState(false);
  // admin 视图把 ownerId 映射成用户名，给每行加 owner 标签。
  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});

  const load = () => api.listProjects().then((r) => setProjects(r.projects)).catch(() => {});
  useEffect(() => {
    load();
    if (user.role === 'admin') {
      api
        .adminListUsers()
        .then((r) => setOwnerNames(Object.fromEntries(r.users.map((u) => [u.id, u.username]))))
        .catch(() => {});
    }
  }, [user.role]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="title">
          项目
          <small>remote-cc · {user.username}</small>
        </div>
        <button className="btn ghost sm" onClick={onOpenMetrics}>
          资源
        </button>
        {user.role === 'admin' && (
          <button className="btn ghost sm" onClick={onOpenUsers}>
            用户
          </button>
        )}
        <button className="btn ghost sm" onClick={onLock}>
          退出
        </button>
      </div>
      <div className="content">
        {projects.length === 0 && !adding && (
          <div className="empty">还没有登记项目。点下方「添加项目」开始。</div>
        )}
        <div className="list">
          {projects.map((p) => (
            <button key={p.id} className="row" onClick={() => onOpen(p)}>
              <div className="grow">
                <div className="name">{p.name}</div>
                <div className="sub">{p.path}</div>
              </div>
              {user.role === 'admin' && p.ownerId && ownerNames[p.ownerId] && (
                <span className="tag">{ownerNames[p.ownerId]}</span>
              )}
              <span className={`tag ${p.type}`}>{p.type === 'research' ? '科研' : '开发'}</span>
              <span className="chev">›</span>
            </button>
          ))}
        </div>

        {adding ? (
          <AddProjectForm
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              load();
            }}
          />
        ) : (
          <button
            className="btn block"
            style={{ marginTop: 'var(--sp-5)' }}
            onClick={() => setAdding(true)}
          >
            ＋ 添加项目
          </button>
        )}
      </div>
    </div>
  );
}

function AddProjectForm({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [type, setType] = useState<'dev' | 'research'>('dev');
  const [launchCommand, setLaunchCommand] = useState('Fable-yolo');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'var(--bg)', overflow: 'auto' }}>
        <DirPicker
          onClose={() => setPicking(false)}
          onPick={(absolute, base) => {
            setPath(absolute);
            if (!name) setName(base);
            setPicking(false);
          }}
        />
      </div>
    );
  }

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.addProject({ name, path, type, launchCommand: launchCommand || undefined });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        marginTop: 'var(--sp-5)',
        padding: 'var(--sp-4)',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
      }}
    >
      <h3 style={{ fontSize: 17, marginBottom: 'var(--sp-4)' }}>添加项目</h3>
      <div className="field">
        <label>显示名</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="sample-research" />
      </div>
      <div className="field">
        <label>路径</label>
        <button
          type="button"
          className="input"
          style={{ textAlign: 'left', color: path ? 'var(--ink)' : 'var(--muted)' }}
          onClick={() => setPicking(true)}
        >
          {path || '点此逐级选择目录 ›'}
        </button>
      </div>
      <div className="field">
        <label>类型</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as 'dev' | 'research')}>
          <option value="dev">开发</option>
          <option value="research">科研（含 task / evidence）</option>
        </select>
      </div>
      <div className="field">
        <label>启动命令</label>
        <input
          className="input"
          value={launchCommand}
          onChange={(e) => setLaunchCommand(e.target.value)}
          placeholder="claude"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        <button className="btn primary grow" style={{ flex: 1 }} onClick={submit} disabled={busy}>
          {busy ? '添加中…' : '添加'}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
