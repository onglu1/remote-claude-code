import type { ChatKey } from '@rcc/shared';

const KEYS: { label: string; key: ChatKey }[] = [
  { label: 'Esc', key: 'esc' },
  { label: '↑', key: 'up' },
  { label: '↓', key: 'down' },
  { label: '←', key: 'left' },
  { label: '→', key: 'right' },
  { label: '⏎', key: 'enter' },
  { label: '^C', key: 'ctrl-c' },
];

/** 常驻按键条：把真实按键发回 tmux pane，驱动 TUI 内的选择菜单/中断。 */
export function KeyBar({ onKey }: { onKey: (k: ChatKey) => void }) {
  return (
    <div className="keybar">
      {KEYS.map((k) => (
        <button key={k.key} className="keycap" onClick={() => onKey(k.key)}>
          {k.label}
        </button>
      ))}
    </div>
  );
}
