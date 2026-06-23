import { useState } from 'react';

export type LiveAskState = 'open' | 'driving' | 'failed';

/**
 * 待答选择题卡片。优先用 hook 真值（问题正文 + 每项说明 + 多问题进度），即原生卡片的样子；
 * hook 不可用时退化为读屏投影（仅选项标签）。单选点击即提交（服务端用绝对数字键作答，挪光标也不点歪），
 * 多选 toggle + 「发送选择」。与 transcript 落地后的 AskChoiceCard 互不影响：菜单关闭即由服务端清本卡。
 */
export function LiveAskCard({
  options,
  multiSelect,
  question,
  header,
  qIndex,
  qTotal,
  state,
  error,
  onAnswer,
}: {
  options: { index: number; label: string; description?: string }[];
  multiSelect: boolean;
  question?: string;
  header?: string;
  qIndex?: number;
  qTotal?: number;
  state: LiveAskState;
  error?: string;
  onAnswer: (optionIndices: number[]) => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const disabled = state === 'driving';
  if (options.length === 0) return null;

  const toggle = (i: number) => {
    setSel((prev) => {
      if (!multiSelect) return [i];
      const s = new Set(prev);
      s.has(i) ? s.delete(i) : s.add(i);
      return [...s];
    });
  };

  const multiQ = typeof qTotal === 'number' && qTotal > 1;

  return (
    <div className={`askcard ${state === 'failed' ? 'failed' : ''}`}>
      <div className="ask-q">
        <div className="ask-topline">
          {header && <span className="ask-tag">{header}</span>}
          {multiQ && (
            <span className="ask-progress">
              {(qIndex ?? 0) + 1}/{qTotal}
            </span>
          )}
          <span className="ask-waiting">Claude 正在等待你的选择</span>
        </div>
        {question && <div className="ask-question">{question}</div>}
        <div className="ask-options">
          {options.map((op) => {
            const picked = sel.includes(op.index);
            return (
              <button
                key={op.index}
                className={`ask-option ${picked ? 'picked' : ''}`}
                disabled={disabled}
                onClick={() => (multiSelect ? toggle(op.index) : onAnswer([op.index]))}
              >
                <span className="ask-mark" aria-hidden>
                  {multiSelect ? (picked ? '☑' : '☐') : picked ? '◉' : '○'}
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

      {multiSelect && (
        <button className="btn ask-submit" disabled={disabled || sel.length === 0} onClick={() => onAnswer(sel)}>
          发送选择
        </button>
      )}
      {state === 'driving' && <div className="ask-note">作答中…</div>}
      {state === 'failed' && (
        <div className="ask-note err">自动作答失败({error || '未知'})。可用下方按键条或终端作答。</div>
      )}
    </div>
  );
}
