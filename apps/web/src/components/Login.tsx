import { useState } from 'react';
import type { AuthUser } from '@rcc/shared';
import { api } from '../lib/api';

export function Login({ onLoggedIn }: { onLoggedIn: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      const { user } = await api.login(username, password);
      onLoggedIn(user);
    } catch (e) {
      setError((e as Error).message || '登录失败');
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="content" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '70vh' }}>
        <div style={{ marginBottom: 'var(--sp-6)' }}>
          <h1 style={{ fontSize: 34, lineHeight: 1.1 }}>remote-cc</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            服务器上 Claude Code / Codex 的远程窗口
          </p>
        </div>
        <div className="field">
          <label>用户名</label>
          <input
            className="input"
            type="text"
            value={username}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="用户名"
          />
        </div>
        <div className="field">
          <label>口令</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="输入口令登录"
          />
          {error && <div className="error">{error}</div>}
        </div>
        <button className="btn primary block" onClick={submit} disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </div>
    </div>
  );
}
