import { useEffect, useMemo, useState } from 'react';
import type { Project, AuthUser, SubUser } from '@rcc/shared';
import { api } from '../lib/api';

type SubUserView = Omit<SubUser, 'passwordHash'>;

/** 一个 namespace 的标签:主账号显示 username,子用户显示 `parent.displayName`。 */
interface NamespaceOption {
  id: string;
  label: string;
  /** 主账号 / 子用户,用于 UI 上分组排序与图标差异。 */
  kind: 'user' | 'subuser';
}

/**
 * 项目跨 namespace 管理页(仅管理员可见)。
 *
 * 多用户隔离设计 2026-06-25:admin 降级后,普通 /api/projects 入口只看自己 namespace,
 * 想看其他用户/子用户建的项目就来这里。这里直接调 /api/admin/projects/* 专用通道。
 *
 * 能力面:
 *  - 看:所有项目(含 owner 显示)。
 *  - 改 owner:把项目转给另一个 namespace(下拉所有主账号 + 子用户)。
 *  - 删:绕过 canSeeProject 删项目。
 *
 * 不做的事:
 *  - 不在这里新建项目;新建仍走 ProjectList 的"+ 添加项目"(加到自己 namespace),
 *    admin 想替别人建就先建再转 owner(少一个分支、行为可预测)。
 *  - 不改 path/launchCommand/notes(避免管家手滑改了正在跑的 tmux 会话的 cwd)。
 *    用户想改自己项目的这些元数据,目前仍需要让我升级 ProjectList 自身的 UI(后续 issue)。
 */
export function ProjectAdmin({ onBack }: { onBack: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [subs, setSubs] = useState<SubUserView[]>([]);
  const [error, setError] = useState('');
  const [transferFor, setTransferFor] = useState<Project | null>(null);

  const load = () =>
    Promise.all([
      api.adminListProjects().then((r) => setProjects(r.projects)),
      api.adminListUsers().then((r) => setUsers(r.users)),
      api.adminListSubUsers().then((r) => setSubs(r.subusers)).catch(() => setSubs([])),
    ]).catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  // 全量 namespace 选项(主账号 + 子用户),用于 owner 下拉显示和搜索。
  // 主账号 label = username;子用户 label = `parent.displayName`,直观看出归属。
  const nsOptions = useMemo<NamespaceOption[]>(() => {
    const usersById = new Map(users.map((u) => [u.id, u.username]));
    const userOpts: NamespaceOption[] = users.map((u) => ({
      id: u.id,
      label: u.username,
      kind: 'user',
    }));
    const subOpts: NamespaceOption[] = subs.map((s) => ({
      id: s.id,
      label: `${usersById.get(s.parentId) ?? '?'}.${s.displayName}`,
      kind: 'subuser',
    }));
    return [...userOpts, ...subOpts];
  }, [users, subs]);

  // 反查表:project.ownerId → 显示用 label(找不到时显示原 id 让 admin 看出"孤儿"项目)。
  const ownerLabel = useMemo(() => {
    const m = new Map(nsOptions.map((o) => [o.id, o.label]));
    return (ownerId?: string) => (ownerId ? (m.get(ownerId) ?? `<未知:${ownerId.slice(0, 8)}…>`) : '<无 owner>');
  }, [nsOptions]);

  const del = async (p: Project) => {
    if (!confirm(`确认删除项目「${p.name}」?\n\nowner=${ownerLabel(p.ownerId)}\n路径=${p.path}\n\n这只删项目登记,不动磁盘文件,但该项目下所有会话/文件夹会变成孤儿(看不到)。`))
      return;
    setError('');
    try {
      await api.adminDeleteProject(p.id);
      await load();
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
          管理项目
          <small>跨用户 / 子用户的项目总览</small>
        </div>
      </div>
      <div className="content">
        {error && <div className="error">{error}</div>}
        {projects.length === 0 ? (
          <div className="empty">还没有任何项目登记。</div>
        ) : (
          <div className="list">
            {projects.map((p) => (
              <div key={p.id} className="row" style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="name">{p.name}</div>
                  <div className="sub">{p.path}</div>
                </div>
                <span className="tag">{ownerLabel(p.ownerId)}</span>
                <span className={`tag ${p.type}`}>{p.type === 'research' ? '科研' : '开发'}</span>
                <button
                  className="btn ghost sm"
                  style={{ marginLeft: 'var(--sp-2)' }}
                  onClick={() => setTransferFor(p)}
                >
                  改 owner
                </button>
                <button
                  className="btn ghost sm"
                  style={{ marginLeft: 'var(--sp-2)' }}
                  onClick={() => del(p)}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        )}

        {transferFor && (
          <TransferOwnerForm
            project={transferFor}
            options={nsOptions}
            currentLabel={ownerLabel(transferFor.ownerId)}
            onCancel={() => setTransferFor(null)}
            onDone={async () => {
              setTransferFor(null);
              await load();
            }}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

function TransferOwnerForm({
  project,
  options,
  currentLabel,
  onCancel,
  onDone,
  onError,
}: {
  project: Project;
  options: NamespaceOption[];
  currentLabel: string;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [target, setTarget] = useState<string>(project.ownerId ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!target || target === project.ownerId || busy) return;
    setBusy(true);
    try {
      await api.adminSetProjectOwner(project.id, target);
      onDone();
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  // 主账号在前、子用户在后,各组内按 label 排序(给人选起来直观)。
  const sorted = [
    ...options.filter((o) => o.kind === 'user').sort((a, b) => a.label.localeCompare(b.label)),
    ...options.filter((o) => o.kind === 'subuser').sort((a, b) => a.label.localeCompare(b.label)),
  ];

  return (
    <div style={panelStyle}>
      <h3 style={{ fontSize: 17, marginBottom: 'var(--sp-4)' }}>改 owner · {project.name}</h3>
      <div className="sub" style={{ marginBottom: 'var(--sp-3)' }}>
        当前 owner:{currentLabel}。转给另一个 namespace 后,原 owner 在他视图里就看不到这项目了。
        正在跑的 tmux 会话不受影响(unixUser 仍按当前 conversation.unixUser 走),
        但新 owner 想"重排"会话时会以他自己 unixUser 跑——可能找不到原 transcript。
      </div>
      <div className="field">
        <label>新 owner</label>
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="" disabled>
            选一个 namespace…
          </option>
          {sorted.map((o) => (
            <option key={o.id} value={o.id}>
              [{o.kind === 'subuser' ? '子' : '主'}] {o.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        <button
          className="btn primary grow"
          style={{ flex: 1 }}
          onClick={submit}
          disabled={busy || !target || target === project.ownerId}
        >
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
