import { useEffect, useState } from 'react';
import type { AuthUser, Role, SubUser } from '@rcc/shared';
import { api } from '../lib/api';

type SubUserView = Omit<SubUser, 'passwordHash'>;

/**
 * 用户管理(仅管理员可见):列出 / 新增 / 改口令 / 删用户 + 子用户管理。
 * 多用户隔离设计 2026-06-23:主账号列含 unixUser 字段;每个主账号下可挂子用户。
 */
export function UserAdmin({ me, onBack }: { me: AuthUser; onBack: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [subs, setSubs] = useState<SubUserView[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<AuthUser | null>(null);
  const [unixFor, setUnixFor] = useState<AuthUser | null>(null);
  /** 展开了哪个主账号的子用户面板。 */
  const [openSubs, setOpenSubs] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api.adminListUsers().then((r) => setUsers(r.users)),
      api.adminListSubUsers().then((r) => setSubs(r.subusers)).catch(() => setSubs([])),
    ]).catch((e) => setError((e as Error).message));
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
          {users.map((u) => {
            const mySubs = subs.filter((s) => s.parentId === u.id);
            const expanded = openSubs === u.id;
            return (
              <div key={u.id}>
                <div className="row" style={{ cursor: 'default' }}>
                  <div className="grow">
                    <div className="name">{u.username}</div>
                    <div className="sub">
                      unix:{u.unixUser ?? '?'} {u.id === me.id ? '· 当前登录' : ''}
                    </div>
                  </div>
                  <span className={`tag ${u.role === 'admin' ? 'research' : 'dev'}`}>
                    {u.role === 'admin' ? '管理员' : '普通用户'}
                  </span>
                  <button
                    className="btn ghost sm"
                    style={{ marginLeft: 'var(--sp-2)' }}
                    onClick={() => setOpenSubs(expanded ? null : u.id)}
                  >
                    子用户 {mySubs.length > 0 ? `(${mySubs.length})` : ''} {expanded ? '▾' : '▸'}
                  </button>
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
                    onClick={() => setUnixFor(u)}
                  >
                    改 unix
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
                {expanded && (
                  <SubUserPanel
                    parent={u}
                    subs={mySubs}
                    onChange={load}
                    onError={setError}
                  />
                )}
              </div>
            );
          })}
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

        {unixFor && (
          <UnixUserForm
            user={unixFor}
            onCancel={() => setUnixFor(null)}
            onDone={() => {
              setUnixFor(null);
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
  const [unixUser, setUnixUser] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      // unixUser 空 → 后端缺省回 serviceUser(与 admin 同一 unix,行为同单用户)
      await api.adminAddUser({
        username,
        password,
        role,
        ...(unixUser ? { unixUser } : {}),
      });
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
      <div className="field">
        <label>unix 用户名(可空=跟 admin 同 unix)</label>
        <input
          className="input"
          value={unixUser}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUnixUser(e.target.value)}
          placeholder="如 zhangsan(本机已存在的 unix 账号)"
        />
        <div className="sub" style={{ marginTop: 'var(--sp-1)' }}>
          多用户隔离:tmux/claude 以此 unix 用户身份跑,创建的文件 owner 是该用户。
          留空=跟 admin 一个 unix(行为同单用户)。
        </div>
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

function UnixUserForm({
  user,
  onCancel,
  onDone,
}: {
  user: AuthUser;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [unixUser, setUnixUser] = useState(user.unixUser ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!unixUser || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.adminSetUnixUser(user.id, unixUser);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h3 style={{ fontSize: 17, marginBottom: 'var(--sp-4)' }}>
        改 unix 用户 · {user.username}
      </h3>
      <div className="field">
        <label>unix 用户名</label>
        <input
          className="input"
          value={unixUser}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUnixUser(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <div className="sub" style={{ marginTop: 'var(--sp-1)' }}>
          下次开会话生效;当前已在跑的会话沿用旧 unix。
        </div>
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

/**
 * 主账号下的子用户面板。在 UserAdmin 行展开后显示;独立用户名/口令登录、unix 身份继承父。
 * 子用户与父在 unix 层零隔离,只是 web 视图按子用户独立 namespace。
 */
function SubUserPanel({
  parent,
  subs,
  onChange,
  onError,
}: {
  parent: AuthUser;
  subs: SubUserView[];
  onChange: () => void;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pwFor, setPwFor] = useState<SubUserView | null>(null);

  const del = async (s: SubUserView) => {
    try {
      await api.adminDeleteSubUser(s.id);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const toggleRole = async (s: SubUserView) => {
    const next: Role = s.role === 'admin' ? 'user' : 'admin';
    try {
      await api.adminSetSubUserRole(s.id, next);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div style={{ ...panelStyle, marginLeft: 'var(--sp-4)', marginTop: 'var(--sp-2)' }}>
      <div className="sub" style={{ marginBottom: 'var(--sp-3)' }}>
        子用户共享 {parent.username} 的 unix 身份(unixUser={parent.unixUser ?? '?'});
        会话/项目/文件夹按子用户独立 namespace。
      </div>
      <div className="list">
        {subs.length === 0 && (
          <div className="empty" style={{ padding: 'var(--sp-3)' }}>
            还没有子用户
          </div>
        )}
        {subs.map((s) => (
          <div key={s.id} className="row" style={{ cursor: 'default' }}>
            <div className="grow">
              <div className="name">{s.displayName}</div>
              <div className="sub">login: {s.username}</div>
            </div>
            <span className={`tag ${s.role === 'admin' ? 'research' : 'dev'}`}>
              {s.role === 'admin' ? '管理员' : '普通用户'}
            </span>
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'var(--sp-2) ' }}
              onClick={() => toggleRole(s)}
              disabled={parent.role !== 'admin' && s.role === 'user'}
              title={
                parent.role !== 'admin' && s.role === 'user'
                  ? '父账号是普通用户,不能升级子用户为管理员'
                  : undefined
              }
            >
              {s.role === 'admin' ? '降为 user' : '升为 admin'}
            </button>
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'var(--sp-2)' }}
              onClick={() => setPwFor(s)}
            >
              改口令
            </button>
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'var(--sp-2)' }}
              onClick={() => del(s)}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {pwFor && (
        <SubPasswordForm
          sub={pwFor}
          onCancel={() => setPwFor(null)}
          onDone={() => {
            setPwFor(null);
            onChange();
          }}
        />
      )}

      {adding ? (
        <AddSubUserForm
          parent={parent}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChange();
          }}
        />
      ) : (
        !pwFor && (
          <button
            className="btn block"
            style={{ marginTop: 'var(--sp-3)' }}
            onClick={() => setAdding(true)}
          >
            ＋ 新增子用户
          </button>
        )
      )}
    </div>
  );
}

function AddSubUserForm({
  parent,
  onCancel,
  onAdded,
}: {
  parent: AuthUser;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password || !displayName || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.adminAddSubUser({
        parentId: parent.id,
        username,
        password,
        displayName,
        role,
      });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{ ...panelStyle, marginTop: 'var(--sp-3)' }}>
      <h3 style={{ fontSize: 16, marginBottom: 'var(--sp-3)' }}>
        新增子用户 · 父={parent.username}
      </h3>
      <div className="field">
        <label>显示名</label>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="如 开发 / 研究"
        />
      </div>
      <div className="field">
        <label>登录用户名</label>
        <input
          className="input"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
          placeholder={`如 ${parent.username}_dev`}
        />
      </div>
      <div className="field">
        <label>口令</label>
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="field">
        <label>角色</label>
        <select
          className="input"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
        >
          <option value="user">普通用户</option>
          <option value="admin" disabled={parent.role !== 'admin'}>
            管理员{parent.role !== 'admin' ? '(父非 admin,不可选)' : ''}
          </option>
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

function SubPasswordForm({
  sub,
  onCancel,
  onDone,
}: {
  sub: SubUserView;
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
      await api.adminSetSubUserPassword(sub.id, password);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div style={{ ...panelStyle, marginTop: 'var(--sp-3)' }}>
      <h3 style={{ fontSize: 16, marginBottom: 'var(--sp-3)' }}>
        改口令 · 子用户 {sub.username}
      </h3>
      <div className="field">
        <label>新口令</label>
        <input
          className="input"
          type="password"
          value={password}
          autoFocus
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
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
