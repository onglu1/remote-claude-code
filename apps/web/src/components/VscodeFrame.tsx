import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Project } from '@rcc/shared';

type Frame = { x: number; y: number; w: number; h: number };

function initialFrame(): Frame {
  if (typeof window === 'undefined') return { x: 80, y: 56, w: 980, h: 680 };
  const w = Math.min(Math.max(820, window.innerWidth * 0.72), window.innerWidth - 24);
  const h = Math.min(Math.max(560, window.innerHeight * 0.78), window.innerHeight - 24);
  return { x: Math.max(12, (window.innerWidth - w) / 2), y: Math.max(12, (window.innerHeight - h) / 2), w, h };
}

function clampFrame(f: Frame): Frame {
  if (typeof window === 'undefined') return f;
  const minW = Math.min(520, Math.max(320, window.innerWidth - 16));
  const minH = Math.min(360, Math.max(260, window.innerHeight - 16));
  const maxW = Math.max(minW, window.innerWidth - 16);
  const maxH = Math.max(minH, window.innerHeight - 16);
  const w = Math.min(Math.max(minW, f.w), maxW);
  const h = Math.min(Math.max(minH, f.h), maxH);
  return {
    x: Math.min(Math.max(8, f.x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, f.y), Math.max(8, window.innerHeight - h - 8)),
    w,
    h,
  };
}

export function VscodeFrame({
  project,
  url,
  onClose,
}: {
  project: Project;
  url: string;
  onClose: () => void;
}) {
  const [frame, setFrame] = useState<Frame>(() => clampFrame(initialFrame()));
  const [loaded, setLoaded] = useState(false);
  const dragRef = useRef<
    | { kind: 'move'; sx: number; sy: number; start: Frame }
    | { kind: 'resize'; sx: number; sy: number; start: Frame }
    | null
  >(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const op = dragRef.current;
      if (!op) return;
      const dx = e.clientX - op.sx;
      const dy = e.clientY - op.sy;
      if (op.kind === 'move') setFrame(clampFrame({ ...op.start, x: op.start.x + dx, y: op.start.y + dy }));
      else setFrame(clampFrame({ ...op.start, w: op.start.w + dx, h: op.start.h + dy }));
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove('vs-dragging');
    };
    const onResize = () => setFrame((f) => clampFrame(f));
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('vs-dragging');
    };
  }, []);

  const start = (kind: 'move' | 'resize', e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { kind, sx: e.clientX, sy: e.clientY, start: frame };
    document.body.classList.add('vs-dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <section
      className="vscode-frame"
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
      aria-label="VSCode Web"
    >
      <div className="vs-head">
        <div className="vs-title" onPointerDown={(e) => start('move', e)}>
          VSCode
          <small>{project.name}</small>
        </div>
        <a className="vs-icon-btn" href={url} target="_blank" rel="noreferrer" title="新窗口打开" aria-label="新窗口打开">
          ↗
        </a>
        <button className="vs-icon-btn" onClick={onClose} title="关闭 VSCode" aria-label="关闭 VSCode">
          ×
        </button>
      </div>
      {!loaded && <div className="vs-loading">载入 VSCode Web...</div>}
      <iframe
        className="vs-iframe"
        src={url}
        title={`VSCode - ${project.name}`}
        onLoad={() => setLoaded(true)}
        allow="clipboard-read; clipboard-write"
      />
      <div className="vs-resize-handle" onPointerDown={(e) => start('resize', e)} aria-hidden />
    </section>
  );
}
