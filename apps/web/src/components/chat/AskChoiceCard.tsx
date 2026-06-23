import { useState } from 'react';
import type { AskPick } from '@rcc/shared';

/** AskUserQuestion 的 input 投影(防御式解析,字段缺失给安全默认)。 */
interface AskOption {
  label: string;
  description?: string;
}
interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskState {
  status: 'driving' | 'done' | 'failed';
  error?: string;
}

function parseQuestions(input: unknown): AskQuestion[] {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q) => {
    const o = (q ?? {}) as Record<string, unknown>;
    const options = Array.isArray(o.options)
      ? o.options.map((op) => {
          const x = (op ?? {}) as Record<string, unknown>;
          return { label: String(x.label ?? ''), description: typeof x.description === 'string' ? x.description : undefined };
        })
      : [];
    return {
      question: String(o.question ?? ''),
      header: typeof o.header === 'string' ? o.header : undefined,
      multiSelect: o.multiSelect === true,
      options,
    };
  });
}

/**
 * AskUserQuestion 选择框:从 transcript 的 tool_use.input 渲染问题与可点选项。
 * pending(无 result)可点选,点选经服务端闭环驱动原生 TUI;resolved 显已选答案。
 * 驱动失败时提示用下方按键条手动作答(永不卡死)。
 */
export function AskChoiceCard({
  input,
  result,
  state,
  onAnswer,
}: {
  input: unknown;
  result?: { content: string; isError?: boolean };
  state?: AskState;
  onAnswer: (picks: AskPick[]) => void;
}) {
  const questions = parseQuestions(input);
  const resolved = !!result;
  const driving = state?.status === 'driving';
  const failed = state?.status === 'failed';
  const [sel, setSel] = useState<Record<number, number[]>>({});

  if (questions.length === 0) return null;
  const singleShot = questions.length === 1 && !questions[0].multiSelect;

  const toggle = (qi: number, oi: number, multi: boolean) => {
    setSel((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        cur.has(oi) ? cur.delete(oi) : cur.add(oi);
      } else {
        cur.clear();
        cur.add(oi);
      }
      return { ...prev, [qi]: [...cur] };
    });
  };

  const submitAll = () => {
    const picks: AskPick[] = questions
      .map((_q, qi) => ({ questionIndex: qi, optionIndices: sel[qi] ?? [] }))
      .filter((p) => p.optionIndices.length > 0);
    if (picks.length === questions.length) onAnswer(picks);
  };

  const disabled = resolved || driving;
  const allAnswered = questions.every((_q, qi) => (sel[qi]?.length ?? 0) > 0);

  return (
    <div className={`askcard ${resolved ? 'resolved' : ''} ${failed ? 'failed' : ''}`}>
      {questions.map((q, qi) => (
        <div key={qi} className="ask-q">
          {q.header && <div className="ask-header">{q.header}</div>}
          <div className="ask-question">{q.question}</div>
          <div className="ask-options">
            {q.options.map((op, oi) => {
              const picked = (sel[qi] ?? []).includes(oi);
              const chosenInResult = resolved && result!.content.includes(op.label);
              return (
                <button
                  key={oi}
                  className={`ask-option ${picked || chosenInResult ? 'picked' : ''}`}
                  disabled={disabled}
                  onClick={() => (singleShot ? onAnswer([{ questionIndex: qi, optionIndices: [oi] }]) : toggle(qi, oi, !!q.multiSelect))}
                >
                  <span className="ask-mark" aria-hidden>
                    {q.multiSelect ? (picked ? '☑' : '☐') : picked || chosenInResult ? '◉' : '○'}
                  </span>
                  <span className="ask-option-text">
                    <span className="ask-option-label">{op.label}</span>
                    {op.description && <span className="ask-option-desc">{op.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {!resolved && !singleShot && (
        <button className="btn ask-submit" disabled={disabled || !allAnswered} onClick={submitAll}>
          发送选择
        </button>
      )}
      {driving && <div className="ask-note">作答中…</div>}
      {failed && <div className="ask-note err">作答失败({state?.error || '未知'})。可用下方按键条手动选择。</div>}
      {resolved && <div className="ask-note ok">✓ 已作答</div>}
    </div>
  );
}
