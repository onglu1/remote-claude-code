import { useState } from 'react';
import type { Folder } from '@rcc/shared';

/**
 * 多选状态下的批量操作工具栏。
 *
 * 后端 batchConversations "尽力而为":单条失败不阻断全部,返回 succeeded/failed;
 * 这里把 failed 汇总成一条 alert 弹给用户(主要是 starred_locked 的删除拒)。
 *
 * 选 ≥ 1 条才渲染;空选返回 null。
 */
export interface MultiSelectToolbarProps {
  selectedIds: string[];
  folders: Folder[];
  onMove: (folderId: string | null) => void;
  onStar: () => void;
  onUnstar: () => void;
  onClose: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function MultiSelectToolbar(props: MultiSelectToolbarProps) {
  const { selectedIds, folders, onMove, onStar, onUnstar, onClose, onDelete, onCancel } = props;
  const [moveValue, setMoveValue] = useState<string>('');

  if (selectedIds.length === 0) return null;

  function handleMoveChange(value: string) {
    setMoveValue(value);
    if (!value) return;
    onMove(value === '__null' ? null : value);
    setMoveValue(''); // 重置 select,允许同一目标再次触发
  }

  return (
    <div className="multi-toolbar" role="toolbar" aria-label="批量操作">
      <span className="multi-count">已选 {selectedIds.length}</span>
      <select
        className="input"
        style={{ width: 'auto', minWidth: 100 }}
        value={moveValue}
        onChange={(e) => handleMoveChange(e.target.value)}
      >
        <option value="">移到…</option>
        <option value="__null">未分类</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <button className="btn ghost sm" onClick={onStar} title="加星">
        ★
      </button>
      <button className="btn ghost sm" onClick={onUnstar} title="取消星">
        ☆
      </button>
      <button className="btn ghost sm" onClick={onClose} title="关闭(进入休眠)">
        关闭
      </button>
      <button
        className="btn ghost sm"
        style={{ color: 'var(--danger)' }}
        onClick={onDelete}
        title="删除(starred 拒绝)"
      >
        删除
      </button>
      <button className="btn ghost sm" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}
