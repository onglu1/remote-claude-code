import { useState } from 'react';
import type { EffortLevel } from '@rcc/shared';

const LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

/** 顶栏思考强度药丸：点开选级别，原生 /effort 即时生效并持久化。 */
export function EffortPill({ level, onPick }: { level: EffortLevel; onPick: (l: EffortLevel) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="effort-pill">
      <button className="btn ghost sm" onClick={() => setOpen((o) => !o)} title="思考强度">
        ⚙ {level} ▾
      </button>
      {open && (
        <div className="effort-menu">
          {LEVELS.map((l) => (
            <button
              key={l}
              className={`effort-item${l === level ? ' on' : ''}`}
              onClick={() => {
                onPick(l);
                setOpen(false);
              }}
            >
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
