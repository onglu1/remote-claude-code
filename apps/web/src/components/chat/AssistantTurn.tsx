import { useState } from 'react';
import type { ContentBlock, AskPick } from '@rcc/shared';
import { Markdown } from './markdown';
import { ToolCard } from './ToolCard';
import { AskChoiceCard, type AskState } from './AskChoiceCard';

export type ToolResultMap = Record<string, { content: string; isError?: boolean }>;
export type AskStateMap = Record<string, AskState>;

/** 思考块:默认折叠,点击展开(沿用用户认可的 Ctrl+O 式交互)。 */
function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="thinking-head" onClick={() => setOpen((o) => !o)}>
        💭 思考 {open ? '▾' : '▸'}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

/**
 * 助手回合:一轮助手工作(文本/思考/工具卡)渲染为单一扁平块,贴近原生 Claude Code。
 * 工具结果由 toolResults 按 id 注入对应卡片;tool_result 块本身不直接渲染。
 */
export function AssistantTurn({
  blocks,
  toolResults,
  askStates,
  onAnswerAsk,
}: {
  blocks: ContentBlock[];
  toolResults: ToolResultMap;
  askStates?: AskStateMap;
  onAnswerAsk?: (toolUseId: string, picks: AskPick[]) => void;
}) {
  return (
    <div className="turn assistant-turn">
      <span className="assistant-marker" aria-hidden>
        ⏺
      </span>
      <div className="assistant-body">
        {blocks.map((b, i) => {
          switch (b.type) {
            case 'text':
              return <Markdown key={i}>{b.text}</Markdown>;
            case 'thinking':
              return <Thinking key={i} text={b.text} />;
            case 'tool_use':
              if (b.name === 'AskUserQuestion')
                return (
                  <AskChoiceCard
                    key={i}
                    input={b.input}
                    result={toolResults[b.id]}
                    state={askStates?.[b.id]}
                    onAnswer={(picks) => onAnswerAsk?.(b.id, picks)}
                  />
                );
              return <ToolCard key={i} name={b.name} input={b.input} result={toolResults[b.id]} />;
            case 'image':
              return (
                <div key={i} className="img-chip">
                  🖼 {b.alt || '图片'}
                </div>
              );
            case 'tool_result':
              return null; // 结果在对应工具卡里展示
          }
        })}
      </div>
    </div>
  );
}
