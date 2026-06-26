import { groupTurns, collectToolResults, type ChatSkeletonItem, type ChatMessage, type AskPick } from '@rcc/shared';
import { UserTurn } from './UserTurn';
import { TurnList } from './TurnList';
import { CollapsedTurn } from './CollapsedTurn';
import type { AskStateMap } from './AssistantTurn';

/**
 * 渲染历史骨架:用户气泡(全文) / 折叠回合 / 已展开回合(完整 TurnList)。
 * 展开的回合就地把折叠行换成完整渲染;内容向下生长,故不打扰上方滚动位置。
 */
export function ChatHistory({
  items,
  expanded,
  loading,
  assistantLabel,
  onExpand,
  askStates,
  onAnswerAsk,
}: {
  items: ChatSkeletonItem[];
  expanded: Record<string, ChatMessage[]>;
  loading: Record<string, boolean>;
  assistantLabel: string;
  onExpand: (id: string) => void;
  askStates?: AskStateMap;
  onAnswerAsk?: (toolUseId: string, picks: AskPick[]) => void;
}) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === 'user') return <UserTurn key={it.message.uuid} message={it.message} />;
        const body = expanded[it.turnId];
        if (body) {
          return (
            <div key={it.turnId} id={`turn-${it.turnId}`}>
              <TurnList
                turns={groupTurns(body)}
                toolResults={collectToolResults(body)}
                askStates={askStates}
                onAnswerAsk={onAnswerAsk}
              />
            </div>
          );
        }
        return (
          <CollapsedTurn
            key={it.turnId}
            turnId={it.turnId}
            tail={it.tail}
            loading={!!loading[it.turnId]}
            assistantLabel={assistantLabel}
            onExpand={onExpand}
          />
        );
      })}
    </>
  );
}
