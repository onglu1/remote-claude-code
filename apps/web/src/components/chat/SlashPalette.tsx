/** 常用斜杠命令的便捷面板（命令以文本原样发给真·Claude Code，原生生效）。 */
const COMMON: { cmd: string; desc: string }[] = [
  { cmd: '/clear', desc: '清空上下文' },
  { cmd: '/compact', desc: '压缩对话' },
  { cmd: '/resume', desc: '恢复会话' },
  { cmd: '/model', desc: '切换模型' },
  { cmd: '/context', desc: '查看上下文用量' },
  { cmd: '/cost', desc: '查看花费' },
  { cmd: '/help', desc: '帮助' },
];

export function SlashPalette({ filter, onPick }: { filter: string; onPick: (cmd: string) => void }) {
  const f = filter.toLowerCase();
  const items = COMMON.filter((c) => c.cmd.toLowerCase().startsWith(f));
  if (items.length === 0) return null;
  return (
    <div className="slash-palette">
      {items.map((c) => (
        <button key={c.cmd} className="slash-item" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c.cmd)}>
          <span className="slash-cmd">{c.cmd}</span>
          <span className="slash-desc">{c.desc}</span>
        </button>
      ))}
    </div>
  );
}
