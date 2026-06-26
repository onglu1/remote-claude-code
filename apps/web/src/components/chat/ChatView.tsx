import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Project, Conversation, ChatMessage, ChatSkeletonItem, ChatKey, EffortLevel, RewindItem, AskPick, AskPending, Hud as HudData } from '@rcc/shared';
import { groupTurns, collectToolResults } from '@rcc/shared';
import { connectChat, type ChatSocket } from '../../lib/chatWs';
import { api } from '../../lib/api';
import { TurnList } from './TurnList';
import { ChatHistory } from './ChatHistory';
import { Composer } from './Composer';
import { KeyBar } from './KeyBar';
import { EffortPill } from './EffortPill';
import { RewindPanel } from './RewindPanel';
import { Markdown } from './markdown';
import { LiveAskCard, type LiveAskState } from './LiveAskCard';
import { Hud } from './Hud';

function textOf(m: ChatMessage): string {
  return m.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

export function ChatView({
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
  // 历史拆三态:骨架(折叠) + 已展开正文 + 本次连接的实时新消息(沿用原流式逻辑)。
  const [history, setHistory] = useState<ChatSkeletonItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, ChatMessage[]>>({});
  const [loadingTurns, setLoadingTurns] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState<ChatMessage[]>([]);
  const [preview, setPreview] = useState('');
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reflowBusy, setReflowBusy] = useState(false);
  const [effort, setEffort] = useState<EffortLevel>('max');
  const [rewindItems, setRewindItems] = useState<RewindItem[] | null>(null);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [askStates, setAskStates] = useState<Record<string, { status: 'driving' | 'done' | 'failed'; error?: string }>>({});
  const [livePending, setLivePending] = useState<AskPending | null>(null);
  const [liveState, setLiveState] = useState<LiveAskState>('open');
  const [liveError, setLiveError] = useState<string | undefined>(undefined);
  const [hud, setHud] = useState<HudData | null>(null);
  const sockRef = useRef<ChatSocket | null>(null);
  const localSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 展开旧回合时锚定该行,展开前后补偿 scrollTop 差值,保持视图不跳。
  const pendingAnchor = useRef<{ id: string; top: number } | null>(null);

  useEffect(() => {
    const sock = connectChat(project.id, conversation.id, {
      onHistory: (snap) => {
        setHistory(snap.items);
        setLive(snap.live);
        // 重连/分叉:保留已展开正文,仅剪枝到仍存在的 turnId(无需重拉,体验不被打断)。
        setExpanded((prev) => {
          const ids = new Set(
            snap.items.filter((i) => i.kind === 'assistant').map((i) => (i as { turnId: string }).turnId),
          );
          const next: Record<string, ChatMessage[]> = {};
          for (const k of Object.keys(prev)) if (ids.has(k)) next[k] = prev[k];
          return next;
        });
      },
      onTurnBody: (turnId, msgs) => {
        // 记下展开前该行的视口位置(此刻 DOM 仍是折叠态),供 layout effect 补偿。
        const el = document.getElementById(`turn-${turnId}`);
        if (el && scrollRef.current) pendingAnchor.current = { id: turnId, top: el.getBoundingClientRect().top };
        setExpanded((p) => ({ ...p, [turnId]: msgs }));
        setLoadingTurns((p) => ({ ...p, [turnId]: false }));
      },
      onMessage: (m) => {
        // 助手消息已落到 transcript（干净版）→ 立即清掉流式预览，避免与最终气泡重影
        if (m.role === 'assistant') setPreview('');
        setLive((prev) => {
          if (prev.some((x) => x.uuid === m.uuid)) return prev;
          // 回显去重：移除文本相同的本地乐观用户消息
          if (m.role === 'user') {
            const t = textOf(m);
            const idx = prev.findIndex((x) => x.uuid.startsWith('local:') && textOf(x) === t);
            if (idx !== -1) {
              const next = prev.slice();
              next.splice(idx, 1);
              return [...next, m];
            }
          }
          return [...prev, m];
        });
      },
      onPreview: (t) => setPreview(t),
      onTurnState: (r) => {
        setRunning(r);
        if (!r) setPreview('');
      },
      onEffort: (level) => setEffort(level),
      onRewindList: (items) => {
        setRewindItems(items);
        setRewindBusy(false);
      },
      onRewindDone: () => {
        setRewindBusy(false);
        setRewindItems(null);
      },
      onAskState: (s) => setAskStates((prev) => ({ ...prev, [s.toolUseId]: { status: s.status, error: s.error } })),
      onAskPending: (a) => {
        setLivePending(a);
        setLiveState('open');
        setLiveError(undefined);
      },
      onAskPendingClear: () => setLivePending(null),
      onAskPendingFailed: (err) => {
        setLiveState('failed');
        setLiveError(err);
      },
      onHud: (h) => setHud(h),
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    sockRef.current = sock;
    return () => sock.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, conversation.id]);

  // 置底:历史(重连/分叉)、实时新消息、预览、运行态、待答变化时回到底部。
  // 注意 expanded 不在依赖里——展开旧回合内容向下生长,不应把视图拽到底。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, live, preview, running, livePending]);

  // 展开旧回合后:把被点的那一行钉回展开前的视口位置(上方插入内容不致把视图推走)。
  useLayoutEffect(() => {
    const a = pendingAnchor.current;
    const container = scrollRef.current;
    if (!a || !container) return;
    pendingAnchor.current = null;
    const el = document.getElementById(`turn-${a.id}`);
    if (el) container.scrollTop += el.getBoundingClientRect().top - a.top;
  }, [expanded]);

  // 去重:transcript 落地后(live 已含该 AskUserQuestion 的 tool_use),
  // 由 transcript 卡片接管,清掉实时卡——任何时刻只存在一张选择卡。
  useEffect(() => {
    if (
      livePending &&
      live.some((m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion'))
    ) {
      setLivePending(null);
    }
  }, [live, livePending]);

  // claude 专属能力开关:Hud / EffortPill / RewindPanel / LiveAskCard 仅 claude 会话渲染。
  // codex 会话这些横切能力(用量 HUD、effort、rewind、AskUserQuestion hook)不适用,故隐藏;
  // Composer / KeyBar / 消息列表 / SlashPalette 为通用能力,对 codex 仍保留。
  const isClaude = conversation.agentKind === 'claude';
  const agentLabel = isClaude ? 'Claude Code' : 'Codex';
  const assistantLabel = isClaude ? 'Claude' : 'Codex';
  const resumeLabel = isClaude ? '--resume' : 'codex resume';

  // 实时缓冲的工具配对(展开的历史回合各自配对,见 ChatHistory)。
  const toolResults = useMemo(() => collectToolResults(live), [live]);

  // 角色归属与工具配对已在服务端净化;此处把实时逐条消息折叠成回合(单一助手回合)。
  const turns = useMemo(() => groupTurns(live), [live]);
  // 存在未作答的 AskUserQuestion → claude 在等待输入,抑制流式预览/思考中,避免菜单文字漏成助手预览。
  const hasPendingAsk = useMemo(
    () =>
      live.some(
        (m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion' && !toolResults[b.id]),
      ),
    [live, toolResults],
  );

  /**
   * 发一条用户消息,可以带 0..N 张已上传完毕的图片附件。
   * 本地乐观显示:text 块 + 多个 image 块,等 transcript 落地后被去重替换成真消息。
   *
   * 发到 claude 的最终格式(整段作为「一条」用户消息,服务端走 bracketed paste 保证不被拆):
   *   <用户文本>
   *   uploaded images:
   *   <path1>
   *   <path2>
   *   ...
   * claude TUI 识别每行的本地绝对路径,自动渲染到 transcript;明确的「uploaded images:」标签让
   * AI 知道下面那些是这条消息附带的图片,而不是文本的一部分。
   */
  const sendText = (text: string, attachments: { path: string; name: string }[] = []) => {
    const blocks: ChatMessage['blocks'] = [];
    if (text) blocks.push({ type: 'text', text });
    for (const a of attachments) blocks.push({ type: 'image', alt: a.name });
    setLive((prev) => [
      ...prev,
      { uuid: `local:${++localSeq.current}`, role: 'user', blocks },
    ]);
    let finalText = text;
    if (attachments.length > 0) {
      const block = ['uploaded images:', ...attachments.map((a) => a.path)].join('\n');
      finalText = finalText ? `${finalText}\n${block}` : block;
    }
    sockRef.current?.send({ type: 'user_text', text: finalText });
  };
  const sendKey = (key: ChatKey) => sockRef.current?.send({ type: 'key', key });
  const interrupt = () => sockRef.current?.send({ type: 'interrupt' });
  const sendAskAnswer = (toolUseId: string, picks: AskPick[]) => sockRef.current?.send({ type: 'ask_answer', toolUseId, picks });
  const sendPendingAnswer = (optionIndices: number[]) => {
    setLiveState('driving');
    sockRef.current?.send({ type: 'ask_pending_answer', optionIndices });
  };
  // 折叠的旧回合:点击才向服务器取正文(load_turn),展开后就地渲染完整回合。
  const handleExpand = (turnId: string) => {
    if (expanded[turnId] || loadingTurns[turnId]) return;
    setLoadingTurns((p) => ({ ...p, [turnId]: true }));
    sockRef.current?.send({ type: 'load_turn', turnId });
  };

  return (
    <div className="app chat-view">
      <div className="topbar">
        <button className="btn ghost sm" onClick={onBack} aria-label="返回">
          返回
        </button>
        <div className="title">
          {conversation.name}
          <small>
            <span className={`dot ${connected ? 'alive' : ''}`} /> {connected ? '已连接' : '重连中…'} ·{' '}
            {project.name}
          </small>
        </div>
        {isClaude && (
          <EffortPill
            level={effort}
            onPick={(l) => {
              setEffort(l);
              sockRef.current?.send({ type: 'set_effort', level: l });
            }}
          />
        )}
        {isClaude && (
          <button
            className="btn ghost sm"
            disabled={running}
            title="回退到检查点"
            onClick={() => sockRef.current?.send({ type: 'rewind_open' })}
          >
            回退
          </button>
        )}
        {running && (
          <button className="btn ghost sm" onClick={interrupt}>
            停止
          </button>
        )}
        <button
          className="btn ghost sm"
          title="刷新当前屏(让 TUI 重画;不打断对话)"
          onClick={() => sockRef.current?.send({ type: 'refresh' })}
        >
          刷新
        </button>
        <button
          className="btn ghost sm"
          disabled={reflowBusy}
          title={`重排(杀 tmux+${assistantLabel} resume;按 detached 默认 120×40 重起;⚠️ 会中断当前 ${agentLabel} 任务)`}
          onClick={async () => {
            if (reflowBusy) return;
            const ok = window.confirm(
              `重排会中断当前 ${agentLabel} 会话:\n` +
                '· 正在执行的工具调用 / 生成 / 待答选择全部丢失\n' +
                '· 旧 scrollback 一起清空,但对话历史保留在 transcript 文件里\n' +
                `· 新 pane 启动后会用 ${resumeLabel} 接续对话\n\n` +
                '确定重排吗?',
            );
            if (!ok) return;
            setReflowBusy(true);
            try {
              // 聊天端没有 xterm 拿不到精确尺寸,用 detached 默认 120×40;
              // 后续从终端模式连进来会自动跟 attached client 调整。
              await api.reflowSession(project.id, conversation.id);
            } catch (e) {
              alert(e instanceof Error ? e.message : '重排失败');
            } finally {
              setReflowBusy(false);
            }
          }}
        >
          {reflowBusy ? '重启中…' : '重排'}
        </button>
        {onSwitchView && (
          <button className="btn ghost sm" onClick={onSwitchView} title="切换到终端视图">
            终端
          </button>
        )}
      </div>

      {isClaude && hud && <Hud {...hud} />}

      <div className="chat-scroll" ref={scrollRef}>
        {history.length === 0 && turns.length === 0 && !preview && !running && (
          <div className="empty">{`原生 ${agentLabel} 会话已就绪。发条消息开始吧。`}</div>
        )}
        <ChatHistory
          items={history}
          expanded={expanded}
          loading={loadingTurns}
          assistantLabel={assistantLabel}
          onExpand={handleExpand}
          askStates={askStates}
          onAnswerAsk={sendAskAnswer}
        />
        <TurnList turns={turns} toolResults={toolResults} askStates={askStates} onAnswerAsk={sendAskAnswer} />
        {isClaude && livePending && (
          <LiveAskCard
            options={livePending.options}
            multiSelect={livePending.multiSelect}
            question={livePending.question}
            header={livePending.header}
            qIndex={livePending.qIndex}
            qTotal={livePending.qTotal}
            state={liveState}
            error={liveError}
            onAnswer={sendPendingAnswer}
          />
        )}
        {running && preview && !hasPendingAsk && !livePending && (
          <div className="turn assistant-turn streaming">
            <span className="assistant-marker" aria-hidden>
              ⏺
            </span>
            <div className="assistant-body">
              <Markdown>{preview}</Markdown>
              <span className="cursor" />
            </div>
          </div>
        )}
        {running && !preview && !hasPendingAsk && !livePending && (
          <div className="turn assistant-turn">
            <span className="assistant-marker" aria-hidden>
              ⏺
            </span>
            <div className="assistant-body working">
              {assistantLabel} 正在思考
              <span className="dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        )}
      </div>

      <Composer projectId={project.id} convId={conversation.id} agentLabel={agentLabel} onSend={sendText} />
      <KeyBar onKey={sendKey} />

      {isClaude && rewindItems !== null && (
        <RewindPanel
          items={rewindItems}
          busy={rewindBusy}
          onExecute={(index, mode) => {
            setRewindBusy(true);
            sockRef.current?.send({ type: 'rewind_execute', index, mode });
          }}
          onClose={() => {
            setRewindItems(null);
            sockRef.current?.send({ type: 'rewind_cancel' });
          }}
        />
      )}
    </div>
  );
}
