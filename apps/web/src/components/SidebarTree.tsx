import { useEffect, useMemo, useState } from 'react';
import type { Conversation, Folder } from '@rcc/shared';
import { api } from '../lib/api';

/**
 * 三态映射:把 Conversation 后端字段翻成 UI 状态枚举。纯函数,易测。
 * - sleeping:closedAt 存在(IdleSweeper 或手动 close 已 kill tmux,可 resume)
 * - alive   :alive=true 且无 closedAt(正常运行中)
 * - dead    :alive=false 且无 closedAt(僵死/未拉起的瞬态)
 */
export function conversationStatus(c: Conversation): 'alive' | 'sleeping' | 'dead' {
  if (c.closedAt) return 'sleeping';
  if (c.alive) return 'alive';
  return 'dead';
}

/**
 * 按 folderId 分组:Map 的 key 为 folderId(null=未分类);
 * 文件夹被删但会话还指向它(后端 cascade 之前)→ 该会话兜底进未分类。
 * 纯函数,易测。
 */
export function groupConversationsByFolder(
  conversations: Conversation[],
  folders: Folder[],
): Map<string | null, Conversation[]> {
  const m = new Map<string | null, Conversation[]>();
  m.set(null, []);
  for (const f of folders) m.set(f.id, []);
  for (const c of conversations) {
    const key = c.folderId ?? null;
    if (m.has(key)) m.get(key)!.push(c);
    else m.get(null)!.push(c);
  }
  return m;
}

/**
 * 侧栏文件夹树:把会话按 folderId 分组、文件夹标题可折叠;每条会话展示三态点。
 *
 * 三态点语义:
 *   - 绿(alive=true, closedAt 空)     运行中
 *   - 灰(closedAt 存在)               休眠中(IdleSweeper 或手动 close 已 kill tmux)
 *   - 红(alive=false, closedAt 空)    僵死/未拉起(罕见,主要是后端 ensure 失败的瞬态)
 *   - 星(starred=true)                叠加显示在名字前
 *
 * 本组件**只渲染列表**,不持有"新建会话/垃圾箱"等动作按钮——那些由父
 * ConversationList 负责(保留原有交互)。
 *
 * Task 14 会包 SessionContextMenu;本 task 暂时把编辑/复制/关闭做成行内按钮,
 * 后续移到右键菜单。
 */
export interface SidebarTreeProps {
  projectId: string;
  conversations: Conversation[];
  /** 文件夹列表;由父组件持有,onFoldersChange 回写以保持单一源 */
  folders: Folder[];
  onFoldersChange: (folders: Folder[]) => void;
  /** 点会话条目:无多选时进入会话;有多选时在父 toggle 选中 */
  onOpen: (conv: Conversation) => void;
  /** 数据变更后请求父刷新会话列表(避免本组件持有重复 state) */
  onRefresh: () => void;
  /** 行内按钮:复制 sessionId、重命名、关闭(沿用原 ConversationList 行为) */
  onCopySessionId?: (conv: Conversation) => void;
  onRequestRename?: (conv: Conversation) => void;
  onRequestClose?: (conv: Conversation) => void;
  /** 当前正在编辑名字的条目 id;非 null 时渲染输入框 */
  editingId?: string | null;
  /** 渲染编辑器:把整个 input + 保存/取消按钮交给父,SidebarTree 只挪位置 */
  renderEditor?: (conv: Conversation) => React.ReactNode;
}

export function SidebarTree(props: SidebarTreeProps) {
  const {
    projectId,
    conversations,
    folders,
    onFoldersChange,
    onOpen,
    onCopySessionId,
    onRequestRename,
    onRequestClose,
    editingId,
    renderEditor,
  } = props;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // 异步拉一次文件夹;后续 CRUD 由父 / ContextMenu 推回(本组件读 props 渲染)。
  useEffect(() => {
    let alive = true;
    api
      .listFolders(projectId)
      .then((r) => {
        if (alive) onFoldersChange(r.folders);
      })
      .catch(() => {
        /* 静默:文件夹拉不到时退回"未分类一组",列表仍可用 */
      });
    return () => {
      alive = false;
    };
    // onFoldersChange 是父端 setter,稳定;projectId 变更才需要重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // 按 folderId 分组;未分类(null/undefined)放第一个分组
  const grouped = useMemo(
    () => groupConversationsByFolder(conversations, folders),
    [conversations, folders],
  );

  function toggleCollapse(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  }

  function renderGroup(label: string, key: string | null, items: Conversation[]) {
    const collapseKey = key ?? '__null';
    const isCollapsed = collapsed.has(collapseKey);
    return (
      <div key={collapseKey} className="sidebar-group">
        <button
          type="button"
          className="sidebar-group-header"
          onClick={() => toggleCollapse(collapseKey)}
        >
          <span className="sidebar-group-name">
            {isCollapsed ? '▸' : '▾'} {label}
          </span>
          <span className="sidebar-group-count">{items.length}</span>
        </button>
        {!isCollapsed && items.length === 0 && (
          <div className="sidebar-group-empty">空</div>
        )}
        {!isCollapsed && items.length > 0 && (
          <ul className="sidebar-list">
            {items.map((c) => {
              const cls = conversationStatus(c);
              const editing = editingId === c.id;
              return (
                <li key={c.id} className={`sidebar-item ${cls}`}>
                  <span className={`dot ${cls}`} aria-label={cls} />
                  {c.starred && <span className="star" aria-label="加星">★</span>}
                  {editing && renderEditor ? (
                    <div className="sidebar-edit grow">{renderEditor(c)}</div>
                  ) : (
                    <button
                      type="button"
                      className="sidebar-item-open grow"
                      onClick={() => onOpen(c)}
                    >
                      <div className="name">{c.name}</div>
                      <div className="sub">
                        {cls === 'sleeping'
                          ? '休眠 · 点按恢复'
                          : cls === 'alive'
                            ? '运行中 · 点按进入'
                            : '已停止 · 点按重启'}
                      </div>
                    </button>
                  )}
                  {!editing && (
                    <>
                      {onCopySessionId && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          title="复制 session UUID"
                          aria-label="复制 session UUID"
                          onClick={() => onCopySessionId(c)}
                        >
                          ⎘
                        </button>
                      )}
                      {onRequestRename && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          title="重命名"
                          aria-label="重命名"
                          onClick={() => onRequestRename(c)}
                        >
                          ✎
                        </button>
                      )}
                      {onRequestClose && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          title="关闭(进垃圾箱可恢复)"
                          onClick={() => onRequestClose(c)}
                        >
                          关闭
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  async function newFolder() {
    const name = window.prompt('新建文件夹的名字:');
    if (!name) return;
    const r = await api.createFolder(projectId, name.trim()).catch(() => null);
    if (r) onFoldersChange([...folders, r.folder]);
  }

  return (
    <div className="sidebar-tree">
      {renderGroup('未分类', null, grouped.get(null) ?? [])}
      {folders.map((f) => renderGroup(f.name, f.id, grouped.get(f.id) ?? []))}
      <button type="button" className="sidebar-new-folder" onClick={() => void newFolder()}>
        + 新建文件夹
      </button>
    </div>
  );
}
