import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Conversation, Folder } from '@rcc/shared';
import { api } from '../lib/api';

/**
 * 右键(桌面)/长按(移动端,Radix 的 ContextMenu.Trigger 默认支持)弹出的菜单:
 * - 移到文件夹(子菜单:未分类、各文件夹、内联输入新建)
 * - 加/取消星
 * - 关闭(仅未休眠)、恢复(仅休眠)
 * - 删除(starred 时 disabled,文案提示"先取消星")
 *
 * 数据变更走 props 回调,父组件(SidebarTree → ConversationList)负责刷列表
 * 或本地替换该条;本组件不持有 state(除了"新建文件夹的输入态")。
 */
export interface SessionContextMenuProps {
  conv: Conversation;
  folders: Folder[];
  projectId: string;
  children: React.ReactNode;
  /** patch 成功后回调:父端合并新 conv 到列表 */
  onPatched: (conv: Conversation) => void;
  /** close 成功后回调:父端刷新或更新 closedAt */
  onClosed: (conv: Conversation) => void;
  /** resume 成功后回调:父端刷新或清 closedAt */
  onResumed: (conv: Conversation) => void;
  /** 软删除成功后回调:父端从活动列表移除该 id */
  onDeleted: (cid: string) => void;
  /** 子菜单"新建文件夹…"时调用,父端创建并把新 Folder 回写状态;返回创建后的 Folder 让本组件接着 move 过去 */
  onNewFolder: (name: string) => Promise<Folder | null>;
}

export function SessionContextMenu(props: SessionContextMenuProps) {
  const {
    conv,
    folders,
    projectId,
    children,
    onPatched,
    onClosed,
    onResumed,
    onDeleted,
    onNewFolder,
  } = props;

  const [newFolderInput, setNewFolderInput] = useState('');
  const [showInput, setShowInput] = useState(false);

  async function move(folderId: string | null) {
    const r = await api
      .patchConversation(projectId, conv.id, { folderId })
      .catch(() => null);
    if (r) onPatched(r.conversation);
  }
  async function toggleStar() {
    const r = await api
      .patchConversation(projectId, conv.id, { starred: !conv.starred })
      .catch(() => null);
    if (r) onPatched(r.conversation);
  }
  async function close() {
    const r = await api.closeConversation(projectId, conv.id).catch(() => null);
    if (r) onClosed(r.conversation);
  }
  async function resume() {
    const r = await api.resumeConversation(projectId, conv.id).catch(() => null);
    if (r) onResumed(r.conversation);
  }
  async function softDelete() {
    if (conv.starred) {
      window.alert('该会话已加星,删除被拒绝。请先取消星再试。');
      return;
    }
    const ok = await api
      .deleteConversation(projectId, conv.id)
      .then(() => true)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : '删除失败';
        window.alert(msg);
        return false;
      });
    if (ok) onDeleted(conv.id);
  }

  async function commitNewFolder() {
    const name = newFolderInput.trim();
    if (!name) {
      setShowInput(false);
      setNewFolderInput('');
      return;
    }
    const f = await onNewFolder(name);
    if (f) await move(f.id);
    setShowInput(false);
    setNewFolderInput('');
  }

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="ctx-menu" collisionPadding={8}>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="ctx-item">
              移到文件夹 <span className="ctx-arrow">▸</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="ctx-menu" sideOffset={2}>
                <ContextMenu.Item
                  className="ctx-item"
                  disabled={(conv.folderId ?? null) === null}
                  onSelect={() => void move(null)}
                >
                  未分类
                </ContextMenu.Item>
                {folders.map((f) => (
                  <ContextMenu.Item
                    key={f.id}
                    className="ctx-item"
                    disabled={conv.folderId === f.id}
                    onSelect={() => void move(f.id)}
                  >
                    {f.name}
                  </ContextMenu.Item>
                ))}
                <ContextMenu.Separator className="ctx-sep" />
                {showInput ? (
                  <div className="ctx-input-row">
                    <input
                      autoFocus
                      className="ctx-input"
                      value={newFolderInput}
                      maxLength={40}
                      onChange={(e) => setNewFolderInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitNewFolder();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setShowInput(false);
                          setNewFolderInput('');
                        }
                      }}
                      onBlur={() => void commitNewFolder()}
                      placeholder="新文件夹名,⏎ 确认"
                    />
                  </div>
                ) : (
                  <ContextMenu.Item
                    className="ctx-item"
                    onSelect={(e) => {
                      e.preventDefault(); // 不关菜单
                      setShowInput(true);
                    }}
                  >
                    新建文件夹…
                  </ContextMenu.Item>
                )}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className="ctx-item" onSelect={() => void toggleStar()}>
            {conv.starred ? '取消星' : '★ 加星'}
          </ContextMenu.Item>
          {conv.closedAt ? (
            <ContextMenu.Item className="ctx-item" onSelect={() => void resume()}>
              恢复(从休眠拉起)
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Item className="ctx-item" onSelect={() => void close()}>
              关闭(进入休眠)
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="ctx-sep" />
          <ContextMenu.Item
            className={`ctx-item danger ${conv.starred ? 'disabled' : ''}`}
            disabled={conv.starred}
            onSelect={() => void softDelete()}
          >
            删除 {conv.starred && <span className="ctx-hint">(先取消星)</span>}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
