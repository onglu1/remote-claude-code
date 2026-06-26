import type { SkeletonTail } from '@rcc/shared';
import { Markdown } from './markdown';

/**
 * 折叠的旧 AI 回合。两形态:
 * - 普通旧回合:裸"展开 Claude 的回复"行(用户提示词即摘要,无需正文)。
 * - 最后一轮:展示 tail(底部约一屏文本)+ 若还有更多则"展开全部"。
 * 正文按需经 load_turn 取回,故只在点击时下传——巨型回复不主动看就不传。
 */
export function CollapsedTurn({
  turnId,
  tail,
  loading,
  assistantLabel,
  onExpand,
}: {
  turnId: string;
  tail?: SkeletonTail;
  loading: boolean;
  assistantLabel: string;
  onExpand: (id: string) => void;
}) {
  if (tail) {
    return (
      <div className="turn assistant-turn" id={`turn-${turnId}`}>
        <span className="assistant-marker" aria-hidden>
          ⏺
        </span>
        <div className="assistant-body">
          <Markdown>{tail.text}</Markdown>
          {tail.truncated && (
            <button className="expand-turn" disabled={loading} onClick={() => onExpand(turnId)}>
              {loading ? '加载中…' : '展开全部'}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <button className="collapsed-turn" id={`turn-${turnId}`} disabled={loading} onClick={() => onExpand(turnId)}>
      <span className="assistant-marker" aria-hidden>
        ⏺
      </span>
      <span>{loading ? '加载中…' : `展开 ${assistantLabel} 的回复`}</span>
    </button>
  );
}
