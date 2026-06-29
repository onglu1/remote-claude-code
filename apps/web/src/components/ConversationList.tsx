import { useEffect, useRef, useState } from 'react';
import type { Project, Conversation, Folder, AgentKind } from '@rcc/shared';
import { api } from '../lib/api';
import { SidebarTree } from './SidebarTree';
import { SidebarSearch } from './SidebarSearch';
import { MultiSelectToolbar } from './MultiSelectToolbar';
import { NewConversationDialog } from './NewConversationDialog';

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
  const [folders, setFolders] = useState<Folder[]>([]);
  const [trash, setTrash] = useState<Conversation[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showNewDialog, setShowNewDialog] = useState(false);
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

  // 新建会话:opts 由 NewConversationDialog 提交(agent/名称/启动命令/续接 UUID);
  // 留空字段交后端 adapter 兜底。沿用既有 busy 锁 + loadActive 刷新 + onOpen 直接进入。
  const create = async (opts?: { name?: string; agentKind?: AgentKind; launchCommand?: string; sessionId?: string }) => {
    if (busy) return;
    setBusy(true);
    try {
      const { conversation } = await api.createConversation(project.id, opts);
      await loadActive();
      onOpen(conversation);
    } catch (e) {
      alert(e instanceof Error ? e.message : '新建会话失败');
    } finally {
      setBusy(false);
    }
  };

  // 按 Claude session UUID 接续:让用户输入一个旧的 sessionId,后端用同 UUID 起新会话,
  // ensure 时 transcript 已存在 → --resume 接续那段对话。手机优先用 prompt() 够用。
  const createBySessionId = async () => {
    if (busy) return;
    const raw = window.prompt(
      '粘贴要接续的 Claude session UUID:\n(可在 ~/.claude/projects/<cwd>/<sessionId>.jsonl 找到;Codex 接续请用「新建会话」弹窗选择 Codex)',
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

  /** SidebarTree 调编辑态用:把 input + 保存/取消按钮塞回原位置 */
  const renderEditor = (c: Conversation) => (
    <>
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
      <button className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitEdit(c)}>
        保存
      </button>
      <button className="btn ghost sm" onMouseDown={(e) => e.preventDefault()} onClick={cancelEdit}>
        取消
      </button>
    </>
  );

  const toggleSelect = (cid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  };

  const clearSelect = () => setSelected(new Set());

  async function runBatch(
    action: 'move' | 'star' | 'unstar' | 'close' | 'softDelete',
    payload?: { folderId: string | null },
  ) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const r = await api
      .batchConversations(project.id, { ids, action, payload })
      .catch(() => null);
    if (!r) {
      window.alert('批量操作失败,请重试');
      return;
    }
    if (r.failed.length > 0) {
      // 把 failed 汇总成一条文案(主要场景:starred_locked 删除拒)
      window.alert(
        `${r.succeeded.length} 条成功;${r.failed.length} 条失败:\n` +
          r.failed.map((f) => `· ${f.id.slice(0, 8)}: ${f.reason}`).join('\n'),
      );
    }
    clearSelect();
    await loadAll();
  }

  return (
    <div>
      {/* 顶部跨会话搜索:空 query 时折叠;非空时展示扁平结果,点击跨项目跳转 */}
      <SidebarSearch />
      {convs.length === 0 && (
        <div className="empty">还没有会话。新建时可选择 Claude Code 或 Codex；进入后可在聊天/终端视图间随时切换。</div>
      )}
      <MultiSelectToolbar
        selectedIds={Array.from(selected)}
        folders={folders}
        onMove={(folderId) => void runBatch('move', { folderId })}
        onStar={() => void runBatch('star')}
        onUnstar={() => void runBatch('unstar')}
        onClose={() => void runBatch('close')}
        onDelete={() => void runBatch('softDelete')}
        onCancel={clearSelect}
      />
      <SidebarTree
        projectId={project.id}
        conversations={convs}
        folders={folders}
        onFoldersChange={setFolders}
        onOpen={onOpen}
        onRefresh={loadActive}
        onPatched={(c) => {
          // 本地替换该条:避免轮询前菜单点星点完 UI 不动
          setConvs((prev) => prev.map((x) => (x.id === c.id ? c : x)));
          if (c.name) onRenamed?.(c.id, c.name);
        }}
        onClosed={(c) => {
          // close 不进垃圾箱、仅写 closedAt,本地更新状态
          setConvs((prev) => prev.map((x) => (x.id === c.id ? c : x)));
        }}
        onResumed={(c) => {
          setConvs((prev) => prev.map((x) => (x.id === c.id ? c : x)));
        }}
        onDeleted={(cid) => {
          // softDelete 后从活动列表移除,刷新垃圾箱
          setConvs((prev) => prev.filter((x) => x.id !== cid));
          void loadTrash();
        }}
        onCopySessionId={(c) => void copySessionId(c)}
        onRequestRename={startEdit}
        onRequestClose={(c) => void close(c.id)}
        editingId={editingId}
        renderEditor={renderEditor}
        selectedIds={selected}
        onToggleSelect={toggleSelect}
      />

      <button
        className="btn primary block"
        style={{ marginTop: 'var(--sp-5)' }}
        onClick={() => setShowNewDialog(true)}
        disabled={busy}
      >
        ＋ 新建会话
      </button>
      <button
        className="btn ghost block"
        style={{ marginTop: 'var(--sp-2)' }}
        onClick={createBySessionId}
        disabled={busy}
        title="新建一个 Claude 会话并以 --resume 接续指定 session UUID"
      >
        ↺ 按 Claude session ID 接续…
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

      {showNewDialog && (
        <NewConversationDialog
          project={project}
          onCreate={(opts) => {
            // 先关弹窗(create 成功会 onOpen 切到会话视图),再发起创建。
            setShowNewDialog(false);
            void create(opts);
          }}
          onCancel={() => setShowNewDialog(false)}
        />
      )}
    </div>
  );
}
