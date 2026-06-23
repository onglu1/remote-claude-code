import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Project, Conversation } from '@rcc/shared';
import { stripMouseTracking } from '@rcc/shared';
import { connectTerminal, type TerminalSocket } from '../lib/ws';
import { api } from '../lib/api';
import { ScrollbackReader } from './ScrollbackReader';

/** 终端「刷新」时分辨率/字模/列宽都要重算,fit + resize + Ctrl-L 三连保证 TUI 重画到当前尺寸。 */

const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^O', seq: '\x0f' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];

/** 手机端用更小字号:列数更多、不挤,字也不那么大;桌面维持 15。 */
function fontFor(): number {
  return typeof window !== 'undefined' && window.innerWidth <= 700 ? 12 : 15;
}

export function Terminal({
  project,
  conversation,
  onBack,
  onSwitchView,
}: {
  project: Project;
  conversation: Conversation;
  onBack: () => void;
  onSwitchView?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const sockRef = useRef<TerminalSocket | null>(null);
  // 刷新按钮要复用 useEffect 里的 doFit:把它放 ref 而不是再写一份(列宽/行数算法只此一处)。
  const fitFnRef = useRef<(() => void) | null>(null);
  const [connected, setConnected] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);

  useEffect(() => {
    const term = new Xterm({
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: fontFor(),
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#211d18',
        foreground: '#e8e1d3',
        cursor: '#a24e34',
        selectionBackground: '#4a443b',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    // WebGL 渲染器(GPU)让实时滚动顺滑；构造或上下文丢失则静默回退默认渲染器。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* 回退 DOM 渲染器 */
    }
    termRef.current = term;

    // 有选区时 Cmd/Ctrl+C 复制到剪贴板并拦截(不发 ^C)；无选区照常透传给会话。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
        const sel = term.getSelection();
        if (sel && sel.length > 0) {
          void navigator.clipboard.writeText(sel);
          return false;
        }
      }
      return true;
    });

    // 滚轮:用 xterm 官方钩子彻底接管——返回 false,xterm 不滚动、也绝不把滚轮转成鼠标转义发给会话。
    // 向上累计到阈值即打开原生阅读层。
    let wheelAcc = 0;
    term.attachCustomWheelEventHandler((e) => {
      if (e.deltaY < 0) {
        wheelAcc += e.deltaY;
        if (wheelAcc < -80) {
          wheelAcc = 0;
          setReaderOpen(true);
        }
      } else {
        wheelAcc = 0;
      }
      return false;
    });

    const doFit = () => {
      try {
        const fs = fontFor();
        if (term.options.fontSize !== fs) term.options.fontSize = fs; // 旋转/改窗时跟随
        fit.fit();
        sockRef.current?.send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    };
    fitFnRef.current = doFit;
    // 防抖重适配:移动端键盘/地址栏变化会连发事件,合并成一次 fit,避免 tmux 尺寸抖动。
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleFit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(doFit, 120);
    };
    doFit();
    // 首次布局/字体可能尚未稳定,延迟再兜底 fit 一次。
    const initialFit = setTimeout(doFit, 300);

    const sock = connectTerminal(
      project.id,
      conversation.id,
      { cols: term.cols, rows: term.rows },
      {
        onData: (d) => term.write(stripMouseTracking(d)),
        onOpen: () => {
          setConnected(true);
          doFit();
        },
        onClose: () => setConnected(false),
        onExit: () => term.write('\r\n[会话已结束]\r\n'),
      },
    );
    sockRef.current = sock;

    term.onData((d) => sock.send({ type: 'input', data: d }));

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(hostRef.current!);
    window.addEventListener('orientationchange', scheduleFit);
    window.addEventListener('resize', scheduleFit);
    // 移动端键盘/地址栏显隐改变的是「可视视口」,用 visualViewport 才抓得到 → 收键盘后把底部空白补满。
    const vv = window.visualViewport;
    vv?.addEventListener('resize', scheduleFit);
    vv?.addEventListener('scroll', scheduleFit);

    // 向上触摸滑动手势 → 打开原生阅读层(滚轮已由上面的 xterm 钩子处理)。
    const host = hostRef.current!;
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y - touchY > 56) setReaderOpen(true);
    };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: true });

    return () => {
      clearTimeout(fitTimer);
      clearTimeout(initialFit);
      ro.disconnect();
      window.removeEventListener('orientationchange', scheduleFit);
      window.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('resize', scheduleFit);
      vv?.removeEventListener('scroll', scheduleFit);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      fitFnRef.current = null;
      sock.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, conversation.id]);

  const sendKey = (seq: string) => {
    sockRef.current?.send({ type: 'input', data: seq });
    // 触屏设备上不聚焦终端,否则会唤起软键盘(功能键已直接发送、无需聚焦);
    // 桌面端保留聚焦,方便接着用物理键盘打字。要键盘时点 ⌨ 键。
    if (!window.matchMedia('(pointer: coarse)').matches) {
      termRef.current?.focus();
    }
  };

  // 「刷新」:重 fit(xterm 行列重算 + 把新尺寸 resize 给 tmux)→ 发 Ctrl-L 让 TUI 自身重画。
  // 只刷当前屏,不动 scrollback;阅读端默认关着无须联动。
  const refreshTerminal = () => {
    fitFnRef.current?.();
    sockRef.current?.send({ type: 'input', data: '\x0c' });
  };

  // 「重排」= 杀 tmux + claude --resume,新 pane 按当前 xterm 实际尺寸起。**必然中断当前 AI 任务**——
  // 按下时先 confirm 警告。WS 收到 exit 后自动重连 attach 到新 pane。
  const [reflowBusy, setReflowBusy] = useState(false);
  const reflowTerminal = async () => {
    if (reflowBusy) return;
    const ok = window.confirm(
      '重排会中断当前 AI 会话:\n' +
        '· 正在执行的工具调用 / 生成 / AskUserQuestion 全部丢失\n' +
        '· 旧 scrollback 一起清空,但对话历史保留在 transcript 文件里\n' +
        '· 新 pane 启动后会 --resume 接续对话,后续输出按当前宽度\n\n' +
        '确定重排吗?',
    );
    if (!ok) return;
    setReflowBusy(true);
    try {
      // 先 fit 保证 term.cols/term.rows 是当前真实尺寸,后端按这个起新 pane → scrollback 也是新宽度。
      fitFnRef.current?.();
      const term = termRef.current;
      const cols = term?.cols ?? 120;
      const rows = term?.rows ?? 40;
      await api.reflowSession(project.id, conversation.id, { cols, rows });
      // pty bridge 收到 exit → ws 自动重连 → newOrAttach 新 tmux → 新 claude UI。
    } catch (e) {
      alert(e instanceof Error ? e.message : '重排失败');
    } finally {
      setReflowBusy(false);
    }
  };

  // 复制：优先当前选区，否则复制可见屏(去尾部空白)。移动端没有修饰键，靠这个按钮。
  const copyTerminal = () => {
    const term = termRef.current;
    if (!term) return;
    let text = term.getSelection();
    if (!text) {
      const buf = term.buffer.active;
      const rows: string[] = [];
      for (let i = 0; i < term.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        rows.push(line ? line.translateToString(true) : '');
      }
      text = rows.join('\n').replace(/\s+$/, '');
    }
    if (text) void navigator.clipboard.writeText(text);
  };

  return (
    <div className="app term-view">
      <div className="topbar">
        <button className="btn ghost sm" onClick={onBack} aria-label="返回">
          返回
        </button>
        <div className="title">
          {conversation.name}
          <small>
            <span className={`dot ${connected ? 'alive' : ''}`} style={{ display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />
            {connected ? '已连接' : '重连中…'} · {project.name}
          </small>
        </div>
        {onSwitchView && (
          <button className="btn ghost sm" onClick={onSwitchView} title="切换到聊天视图">
            聊天
          </button>
        )}
        <button
          className="btn ghost sm"
          onClick={refreshTerminal}
          title="刷新当前屏(重算字号/列宽 + 让 TUI 重画;不打断对话)"
        >
          刷新
        </button>
        <button
          className="btn ghost sm"
          onClick={reflowTerminal}
          disabled={reflowBusy}
          title="重排(杀 tmux+claude --resume;按当前宽度重起;⚠️ 会中断当前 AI 任务)"
        >
          {reflowBusy ? '重启中…' : '重排'}
        </button>
      </div>

      <div className="term-host" ref={hostRef} onClick={() => termRef.current?.focus()} />

      <div className="keybar">
        {KEYS.map((k) => (
          <button key={k.label} className="keycap" onClick={() => sendKey(k.seq)}>
            {k.label}
          </button>
        ))}
        <button className="keycap" onClick={copyTerminal} title="复制选区或可见屏">
          复制
        </button>
      </div>

      {readerOpen && (
        <ScrollbackReader
          projectId={project.id}
          convId={conversation.id}
          onClose={() => setReaderOpen(false)}
        />
      )}
    </div>
  );
}
