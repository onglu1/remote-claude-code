import type { Turn, AskPick } from '@rcc/shared';
import { UserTurn } from './UserTurn';
import { AssistantTurn, type ToolResultMap, type AskStateMap } from './AssistantTurn';

/** 把回合序列渲染为 用户气泡 / 助手回合块。 */
export function TurnList({
  turns,
  toolResults,
  askStates,
  onAnswerAsk,
}: {
  turns: Turn[];
  toolResults: ToolResultMap;
  askStates?: AskStateMap;
  onAnswerAsk?: (toolUseId: string, picks: AskPick[]) => void;
}) {
  return (
    <>
      {turns.map((t) =>
        t.kind === 'user' ? (
          <UserTurn key={t.message.uuid} message={t.message} />
        ) : (
          <AssistantTurn key={t.id} blocks={t.blocks} toolResults={toolResults} askStates={askStates} onAnswerAsk={onAnswerAsk} />
        ),
      )}
    </>
  );
}
