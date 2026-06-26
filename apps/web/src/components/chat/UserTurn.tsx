import { copyableTextFromMessage, type ChatMessage } from '@rcc/shared';
import { CopyButton } from './CopyButton';

/** 用户回合:右侧强调色气泡,明显区分「我发送的」内容。 */
export function UserTurn({ message }: { message: ChatMessage }) {
  const copyText = copyableTextFromMessage(message);

  return (
    <div className="turn user-turn">
      <div className="bubble user-bubble">
        {copyText && (
          <div className="turn-actions">
            <CopyButton text={copyText} />
          </div>
        )}
        {message.blocks.map((b, i) =>
          b.type === 'text' ? (
            <div key={i} className="user-text">
              {b.text}
            </div>
          ) : b.type === 'image' ? (
            <div key={i} className="img-chip">
              🖼 {b.alt || '图片'}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
