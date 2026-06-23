import { useEffect, useRef, useState } from 'react';
import type { Project, Conversation } from '@rcc/shared';
import { api } from '../lib/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ConversationList({
  project,
  onOpen,
  onRenamed,
}: {
  project: Project;
  onOpen: (c: Conversation) => void;
  /** 改名成功后回调（cid + 新名）：供上层同步已打开会话的标题等。 */
  onRenamed?: (cid: string, name: string) => void;
}) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [trash, setTrash] = useState<Conversation[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const loadActive = () =>
    api.listConversations(project.id).then((r) => setConvs(r.conversations)).catch(() => {});
  const loadTrash = () =>
    api.listTrash(project.id).then((r) => setTrash(r.conversations)).catch(() => {});
  const loadAll = () => Promise.all([loadActive(), loadTrash()]);

  useEffect(() => {
    void loadAll();
    const t = setInterval(loadActive, 5000); // 垃圾箱不轮询,展开时手动刷一次就够了
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // 进入编辑态后聚焦并全选，方便手机直接改。
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { conversation } = await api.createConversation(project.id);
      await loadActive();
      onOpen(conversation);
    } finally {
      setBusy(false);
    }
  };

  // 按 claude session UUID 接续:让用户输入一个旧的 sessionId,后端用同 UUID 起新会话,
  // ensure 时 transcript 已存在 → --resume 接续那段对话。手机优先用 prompt() 够用。
  const createBySessionId = async () => {
    if (busy) return;
    const raw = window.prompt(
      '粘贴要接续的 claude session UUID:\n(可在 ~/.claude/projects/<cwd>/<sessionId>.jsonl 找到;或在另一台机的会话详情里复制)',
      '',
    );
    if (!raw) return;
    const sid = raw.trim();
    if (!UUID_RE.test(sid)) {
      alert('不是合法的 UUID,应类似 ab12cd34-ef56-7890-abcd-1234567890ab');
      return;
    }
    setBusy(true);
    try {
      const { conversation } = await api.createConversation(project.id, {
        sessionId: sid,
        name: `接续 ${sid.slice(0, 8)}`,
      });
      await loadActive();
      onOpen(conversation);
    } catch (e) {
      alert(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const close = async (cid: string) => {
    // 默认软删除(进垃圾箱可恢复)。
    await api.deleteConversation(project.id, cid).catch(() => {});
    void loadAll();
  };

  const restore = async (cid: string) => {
    await api.restoreConversation(project.id, cid).catch(() => {});
    void loadAll();
  };

  const purge = async (cid: string, name: string) => {
    if (!window.confirm(`彻底删除"${name}"?该操作不可恢复。\n(transcript 文件本身不会删,后续可用 session UUID 接续。)`)) return;
    await api.deleteConversation(project.id, cid, true).catch(() => {});
    void loadAll();
  };

  const copySessionId = async (c: Conversation) => {
    try {
      await navigator.clipboard.writeText(c.sessionId);
    } catch {
      window.prompt('session UUID(手动复制):', c.sessionId);
    }
  };

  const startEdit = (c: Conversation) => {
    setEditingId(c.id);
    setDraft(c.name);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
  };
  const commitEdit = async (c: Conversation) => {
    const name = draft.trim();
    // 空名或没改动：直接退出编辑态，不发请求。
    if (!name || name === c.name) {
      cancelEdit();
      return;
    }
    try {
      const { conversation } = await api.renameConversation(project.id, c.id, name);
      setConvs((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: conversation.name } : x)));
      onRenamed?.(c.id, conversation.name);
      cancelEdit();
    } catch {
      // 失败保持编辑态，让用户重试/取消。
    }
  };

  return (
    <div>
      {convs.length === 0 && (
        <div className="empty">还没有会话。新建一个会话即开启一个常驻的 Claude Code；进入后可在聊天/终端视图间随时切换。</div>
      )}
      <div className="list">
        {convs.map((c) => {
          const editing = editingId === c.id;
          return (
            <div key={c.id} className="row" style={{ cursor: 'default' }}>
              <span className={`dot ${c.alive ? 'alive' : ''}`} />
              {editing ? (
                <input
                  ref={inputRef}
                  className="input grow"
                  value={draft}
                  maxLength={60}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitEdit(c);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => void commitEdit(c)}
                  aria-label="会话名称"
                />
              ) : (
                <button
                  className="grow"
                  style={{ background: 'none', border: 'none', textAlign: 'left', padding: 0 }}
                  onClick={() => onOpen(c)}
                >
                  <div className="name">{c.name}</div>
                  <div className="sub">{c.alive ? '运行中 · 点按进入' : '已停止 · 点按重启'}</div>
                </button>
              )}
              {editing ? (
                <>
                  <button className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitEdit(c)}>
                    保存
                  </button>
                  <button className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={cancelEdit}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn ghost sm"
                    title="复制 session UUID(可在别处粘贴接续)"
                    aria-label="复制 session UUID"
                    onClick={() => void copySessionId(c)}
                  >
                    ⎘
                  </button>
                  <button className="btn ghost sm" title="重命名" aria-label="重命名" onClick={() => startEdit(c)}>
                    ✎
                  </button>
                  <button className="btn ghost sm" title="关闭(进垃圾箱可恢复)" onClick={() => void close(c.id)}>
                    关闭
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <button className="btn primary block" style={{ marginTop: 'var(--sp-5)' }} onClick={create} disabled={busy}>
        ＋ 新建会话
      </button>
      <button
        className="btn ghost block"
        style={{ marginTop: 'var(--sp-2)' }}
        onClick={createBySessionId}
        disabled={busy}
        title="新建一个会话并以 --resume 接续指定 session UUID"
      >
        ↺ 按 session ID 接续…
      </button>

      <button
        className="btn ghost block"
        style={{ marginTop: 'var(--sp-4)' }}
        onClick={() => {
          setTrashOpen((o) => !o);
          if (!trashOpen) void loadTrash();
        }}
      >
        🗑 垃圾箱 {trash.length > 0 ? `(${trash.length})` : ''} {trashOpen ? '▾' : '▸'}
      </button>
      {trashOpen && (
        <div className="list" style={{ marginTop: 'var(--sp-3)' }}>
          {trash.length === 0 && <div className="empty" style={{ padding: 'var(--sp-3)' }}>垃圾箱是空的</div>}
          {trash.map((c) => (
            <div key={c.id} className="row" style={{ cursor: 'default', opacity: 0.85 }}>
              <span className="dot" />
              <div className="grow">
                <div className="name">{c.name}</div>
                <div className="sub">
                  删除于 {c.deletedAt ? new Date(c.deletedAt).toLocaleString() : '?'} · session{' '}
                  {c.sessionId.slice(0, 8)}…
                </div>
              </div>
              <button className="btn ghost sm" title="恢复(下次进入按 --resume 拉起)" onClick={() => void restore(c.id)}>
                恢复
              </button>
              <button
                className="btn ghost sm"
                style={{ color: 'var(--danger)' }}
                title="彻底删除(不可恢复;transcript 文件仍在,可凭 session UUID 接续)"
                onClick={() => void purge(c.id, c.name)}
              >
                ✕ 删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
