import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import type { Conversation, Folder } from '@rcc/shared';
import { api } from '../lib/api';
import { SessionContextMenu } from './SessionContextMenu';

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
 * 拖拽 id 编码:'c:<convId>' / 'f:<folderId>'(__null = 未分类)。
 * 纯函数,易测。
 */
export function parseDragIds(active: string, over: string | null):
  | { kind: 'invalid' }
  | { kind: 'moveToFolder'; convId: string; folderId: string | null } {
  if (!over) return { kind: 'invalid' };
  if (!active.startsWith('c:') || !over.startsWith('f:')) return { kind: 'invalid' };
  const folderKey = over.slice(2);
  const convId = active.slice(2);
  const folderId = folderKey === '__null' ? null : folderKey;
  return { kind: 'moveToFolder', convId, folderId };
}

/** 检测是否启用拖拽 sensor:只在有 hover(桌面端鼠标)的设备启用。 */
function detectDragEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  // matchMedia 不支持时退一步默认开(避免桌面端被错误禁用)
  if (!window.matchMedia) return true;
  return window.matchMedia('(hover: hover)').matches;
}

/**
 * 侧栏文件夹树:
 * - 把会话按 folderId 分组,文件夹标题可折叠;每条会话展示三态点。
 * - 右键/长按出 SessionContextMenu(移到文件夹/加星/关闭/恢复/删除)。
 * - 桌面端可拖拽会话条目到文件夹标题 → patchConversation({folderId})。
 *   移动端默认禁用拖拽 sensor,避免与长按菜单冲突。
 *
 * 本组件**只渲染列表**,不持有"新建会话/垃圾箱"等动作按钮——那些由父
 * ConversationList 负责(保留原有交互)。
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
  /** 右键/长按菜单的回调:父端合并新 conv 或刷新 */
  onPatched: (conv: Conversation) => void;
  onClosed: (conv: Conversation) => void;
  onResumed: (conv: Conversation) => void;
  onDeleted: (cid: string) => void;
  /** 行内按钮:复制 sessionId、重命名、删除/软删(沿用原 ConversationList 行为;
   * 命名故意避开"关闭"——SessionContextMenu 里"关闭"专指进入休眠,这里其实是删除进垃圾箱) */
  onCopySessionId?: (conv: Conversation) => void;
  onRequestRename?: (conv: Conversation) => void;
  onRequestClose?: (conv: Conversation) => void;
  /** 当前正在编辑名字的条目 id;非 null 时渲染输入框 */
  editingId?: string | null;
  /** 渲染编辑器:把整个 input + 保存/取消按钮交给父,SidebarTree 只挪位置 */
  renderEditor?: (conv: Conversation) => React.ReactNode;
  /** 多选状态(可选):非空时点条目=toggle,空时=onOpen;cmd/ctrl 始终 toggle */
  selectedIds?: Set<string>;
  onToggleSelect?: (cid: string) => void;
}

/** 把每个会话条目包成 draggable。拖动靠 dot 当 handle,中间按钮区域照常可点。 */
function DraggableItem({ convId, children }: { convId: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `c:${convId}`,
  });
  const style: React.CSSProperties = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 100 : undefined,
      }
    : {};
  return (
    <div ref={setNodeRef} style={style} className="sidebar-drag-wrap">
      {/* 拖把手:左侧一道窄条,只占少量像素,避免吃掉条目主区域的点击 */}
      <div className="sidebar-drag-handle" {...listeners} {...attributes} aria-label="拖动到文件夹" />
      <div className="sidebar-drag-body">{children}</div>
    </div>
  );
}

/** 文件夹分组的整体作为 droppable;拖到 header 或里面 list 都算 hit. */
function DroppableGroup({
  folderKey,
  children,
}: {
  folderKey: string;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `f:${folderKey}` });
  return (
    <div ref={setNodeRef} className={`sidebar-group ${isOver ? 'drop-over' : ''}`}>
      {children}
    </div>
  );
}

export function SidebarTree(props: SidebarTreeProps) {
  const {
    projectId,
    conversations,
    folders,
    onFoldersChange,
    onOpen,
    onPatched,
    onClosed,
    onResumed,
    onDeleted,
    onCopySessionId,
    onRequestRename,
    onRequestClose,
    editingId,
    renderEditor,
    selectedIds,
    onToggleSelect,
  } = props;
  const multiActive = (selectedIds?.size ?? 0) > 0;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // 桌面端启拖拽,触摸端不启;一次检测即可,屏幕变化罕见
  const dragEnabled = useMemo(() => detectDragEnabled(), []);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

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

  async function handleDragEnd(e: DragEndEvent) {
    const parsed = parseDragIds(String(e.active.id), e.over ? String(e.over.id) : null);
    if (parsed.kind !== 'moveToFolder') return;
    const conv = conversations.find((c) => c.id === parsed.convId);
    if (!conv) return;
    // 已经在目标文件夹,跳过 PATCH
    if ((conv.folderId ?? null) === parsed.folderId) return;
    // 乐观:先本地更新,失败后端没改也无视觉跳变(下次 listConversations 校准)
    onPatched({ ...conv, folderId: parsed.folderId });
    const r = await api
      .patchConversation(projectId, conv.id, { folderId: parsed.folderId })
      .catch(() => null);
    if (r) onPatched(r.conversation);
  }

  function renderGroup(label: string, key: string | null, items: Conversation[]) {
    const collapseKey = key ?? '__null';
    const isCollapsed = collapsed.has(collapseKey);
    const folderKey = key ?? '__null';
    return (
      <DroppableGroup key={folderKey} folderKey={folderKey}>
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
          <div className="sidebar-group-empty">空(可拖会话到此分组)</div>
        )}
        {!isCollapsed && items.length > 0 && (
          <ul className="sidebar-list">
            {items.map((c) => {
              const cls = conversationStatus(c);
              const editing = editingId === c.id;
              const isSelected = selectedIds?.has(c.id) ?? false;
              // 点条目主区域:
              //  - cmd/ctrl 始终 toggle 选中(支持回调时)
              //  - 已有选中态(multiActive) → toggle
              //  - 无选中态 → 进入会话
              const onItemMainClick = (e: React.MouseEvent) => {
                if (onToggleSelect && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onToggleSelect(c.id);
                  return;
                }
                if (multiActive && onToggleSelect) {
                  onToggleSelect(c.id);
                  return;
                }
                onOpen(c);
              };
              const liNode = (
                <li className={`sidebar-item ${cls} ${isSelected ? 'selected' : ''}`}>
                  {multiActive && onToggleSelect ? (
                    <input
                      type="checkbox"
                      className="sidebar-select"
                      checked={isSelected}
                      onChange={() => onToggleSelect(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label="选中此会话"
                    />
                  ) : (
                    <span className={`dot ${cls}`} aria-label={cls} />
                  )}
                  {c.starred && <span className="star" aria-label="加星">★</span>}
                  {/* agent 小字母 badge:C=claude / X=codex,一眼区分会话类型。
                      与 dot/star 同为 flex:none 兄弟,永不被会话名挤掉(小屏友好)。 */}
                  <span
                    className={`sidebar-agent-badge ${c.agentKind}`}
                    title={c.agentKind === 'claude' ? 'Claude 会话' : 'Codex 会话'}
                    aria-label={c.agentKind === 'claude' ? 'Claude 会话' : 'Codex 会话'}
                  >
                    {c.agentKind === 'claude' ? 'C' : 'X'}
                  </span>
                  {editing && renderEditor ? (
                    <div className="sidebar-edit grow">{renderEditor(c)}</div>
                  ) : (
                    <button
                      type="button"
                      className="sidebar-item-open grow"
                      onClick={onItemMainClick}
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
                          title="删除(进垃圾箱可恢复)"
                          aria-label="删除(进垃圾箱可恢复)"
                          onClick={() => onRequestClose(c)}
                        >
                          删除
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
              const ctxNode = (
                <SessionContextMenu
                  conv={c}
                  folders={folders}
                  projectId={projectId}
                  onPatched={onPatched}
                  onClosed={onClosed}
                  onResumed={onResumed}
                  onDeleted={onDeleted}
                  onNewFolder={async (name) => {
                    const r = await api.createFolder(projectId, name).catch(() => null);
                    if (r) {
                      onFoldersChange([...folders, r.folder]);
                      return r.folder;
                    }
                    return null;
                  }}
                >
                  {liNode}
                </SessionContextMenu>
              );
              // 桌面端用 DraggableItem 包,移动端直接用 ctxNode(不挂 sensor 也不渲染 handle)
              return dragEnabled ? (
                <DraggableItem key={c.id} convId={c.id}>
                  {ctxNode}
                </DraggableItem>
              ) : (
                <div key={c.id}>{ctxNode}</div>
              );
            })}
          </ul>
        )}
      </DroppableGroup>
    );
  }

  async function newFolder() {
    const name = window.prompt('新建文件夹的名字:');
    if (!name) return;
    const r = await api.createFolder(projectId, name.trim()).catch(() => null);
    if (r) onFoldersChange([...folders, r.folder]);
  }

  const treeBody = (
    <div className="sidebar-tree">
      {renderGroup('未分类', null, grouped.get(null) ?? [])}
      {folders.map((f) => renderGroup(f.name, f.id, grouped.get(f.id) ?? []))}
      <button type="button" className="sidebar-new-folder" onClick={() => void newFolder()}>
        + 新建文件夹
      </button>
    </div>
  );

  // 移动端绕过 DndContext,省点 listener 注册;桌面端正常挂
  if (!dragEnabled) return treeBody;
  return (
    <DndContext sensors={sensors} onDragEnd={(e) => void handleDragEnd(e)}>
      {treeBody}
    </DndContext>
  );
}
