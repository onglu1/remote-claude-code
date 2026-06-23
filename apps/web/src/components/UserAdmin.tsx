import { useEffect, useState } from 'react';
import type { AuthUser, Role } from '@rcc/shared';
import { api } from '../lib/api';

/** 用户管理（仅管理员可见）：列出 / 新增 / 改口令 / 删用户。手机友好。 */
export function UserAdmin({ me, onBack }: { me: AuthUser; onBack: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<AuthUser | null>(null);

  const load = () =>
    api
      .adminListUsers()
      .then((r) => setUsers(r.users))
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  const del = async (u: AuthUser) => {
    setError('');
    try {
      await api.adminDeleteUser(u.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onBack} aria-label="返回">
          ‹
        </button>
        <div className="title">
          用户管理
          <small>管理应用账号</small>
        </div>
      </div>
      <div className="content">
        {error && <div className="error">{error}</div>}
        <div className="list">
          {users.map((u) => (
            <div key={u.id} className="row" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="name">{u.username}</div>
                <div className="sub">{u.id === me.id ? '（当前登录）' : u.id}</div>
              </div>
              <span className={`tag ${u.role === 'admin' ? 'research' : 'dev'}`}>
                {u.role === 'admin' ? '管理员' : '普通用户'}
              </span>
              <button
                className="btn ghost sm"
                style={{ marginLeft: 'var(--sp-2)' }}
                onClick={() => setPwFor(u)}
              >
                改口令
              </button>
              <button
                className="btn ghost sm"
                style={{ marginLeft: 'var(--sp-2)' }}
                onClick={() => del(u)}
                disabled={u.id === me.id}
                title={u.id === me.id ? '不能删除自己' : undefined}
              >
                删除
              </button>
            </div>
          ))}
        </div>

        {pwFor && (
          <PasswordForm
            user={pwFor}
            onCancel={() => setPwFor(null)}
            onDone={() => {
              setPwFor(null);
              load();
            }}
          />
        )}

        {adding ? (
          <AddUserForm
            onCancel={() => setAdding(false)}
            onAdded={() => {
              setAdding(false);
              load();
            }}
          />
        ) : (
          !pwFor && (
            <button
              className="btn block"
              style={{ marginTop: 'var(--sp-5)' }}
              onClick={() => setAdding(true)}
            >
              ＋ 新增用户
            </button>
          )
        )}
      </div>
    </div>
  );
}

function AddUserForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.adminAddUser({ username, password, role });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h3 style={{ fontSize: 17, marginBottom: 'var(--sp-4)' }}>新增用户</h3>
      <div className="field">
        <label>用户名</label>
        <input
          className="input"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
          placeholder="如 alice"
        />
      </div>
      <div className="field">
        <label>口令</label>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="初始口令"
        />
      </div>
      <div className="field">
        <label>角色</label>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        <button className="btn primary grow" style={{ flex: 1 }} onClick={submit} disabled={busy}>
          {busy ? '创建中…' : '创建'}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function PasswordForm({
  user,
  onCancel,
  onDone,
}: {
  user: AuthUser;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.adminSetPassword(user.id, password);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h3 style={{ fontSize: 17, marginBottom: 'var(--sp-4)' }}>改口令 · {user.username}</h3>
      <div className="field">
        <label>新口令</label>
        <input
          className="input"
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="新口令"
        />
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        <button className="btn primary grow" style={{ flex: 1 }} onClick={submit} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  marginTop: 'var(--sp-5)',
  padding: 'var(--sp-4)',
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
};
