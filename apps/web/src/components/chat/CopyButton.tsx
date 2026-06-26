import { useEffect, useRef, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

async function fallbackCopyText(text: string): Promise<void> {
  if (typeof document === 'undefined') throw new Error('clipboard unavailable');
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed');
  } finally {
    document.body.removeChild(textarea);
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await fallbackCopyText(text);
}

export function CopyButton({ text, title = '复制消息' }: { text: string; title?: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<number | null>(null);
  const value = text.trim();

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!value) return null;

  const mark = (next: CopyState) => {
    setState(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 1400);
  };

  const onCopy = async () => {
    try {
      await writeClipboard(value);
      mark('copied');
    } catch {
      mark('failed');
    }
  };

  return (
    <button className={`turn-copy ${state}`} type="button" title={title} aria-label={title} onClick={onCopy}>
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : '复制'}
    </button>
  );
}
