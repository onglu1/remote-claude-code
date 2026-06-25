/**
 * 一个聊天会话的运行时：在 tmux 里跑原生交互式 claude，
 * 以"读屏出流式预览 + transcript 出结构化消息"两路喂给前端。
 */
import type { AgentKind, AskPending, AskPick, ChatKey, ChatMessage, ChatHistorySnapshot, EffortLevel, Hud, RewindItem, RewindMode } from '@rcc/shared';
import { buildHistorySnapshot, getTurnSlice } from '@rcc/shared';
import type { PaneScrape } from './paneScraper';
// 启动命令不再硬调 buildClaudeCmd,改走 deps.adapter.buildLaunchCmd/buildResumeCmd
// (claude adapter 内部仍调 buildClaudeCmd,故输出与既有完全一致)。
// TranscriptLike 真身在 ./agent/adapter,这里同时本地用 + re-export 保对外 import 不破。
import type { AgentAdapter, TranscriptLike } from './agent/adapter';
import { RewindController, type RewindResult } from './rewind';
import { AskController, type AskResult } from './askController';
import { parseAskPickerLive } from './askScraper';
import { AskDriver, type AskDriverResult, type AskDriverTmux } from './askDriver';
import { readPendingAsk, toAskPending, type AskHookPending } from './askSidecar';
import { scrapeHud } from './hudScraper';
import { pickHud, readStatuslineSidecar, hudFromTranscript, type SidecarIO } from './hudSource';

/** ask 驱动状态(广播给所有镜像客户端)。 */
export interface AskStateEvent {
  toolUseId: string;
  status: 'driving' | 'done' | 'failed';
  error?: string;
}

/** 会话依赖的 rewind 控制器能力（便于注入 fake 测试）。 */
export interface RewindLike {
  open(): Promise<{ items: RewindItem[] }>;
  execute(index: number, mode: RewindMode): Promise<RewindResult>;
  cancel(): Promise<void>;
}

/** 会话依赖的 ask 控制器能力（便于注入 fake 测试）。 */
export interface AskLike {
  answer(picks: AskPick[]): Promise<AskResult>;
  answerCurrent(optionIndices: number[]): Promise<AskResult>;
}

/** 会话依赖的 ask 数字键驱动能力（便于注入 fake 测试）。 */
export interface AskDriverLike {
  answer(options: { label: string }[], optionIndices: number[], multiSelect: boolean): Promise<AskDriverResult>;
}

export interface ChatSpec {
  tmuxName: string;
  cwd: string;
  /** 项目 launchCommand（如 "Fable-yolo"）；会在其后追加 --session-id/--resume。 */
  launchCommand: string;
  /** claude 会话 UUID。 */
  sessionId: string;
  /** 会话级思考强度；空则默认 max。启动时拼 --effort。 */
  effort?: EffortLevel;
  cols: number;
  rows: number;
  /**
   * 多用户隔离设计 2026-06-23:拉起 tmux/claude 用的 unix 用户名。
   * 可选(老 spec 不带);chatRegistry 工厂缺则回 ServiceUser(单用户兼容)。
   */
  unixUser?: string;
  /** agent 类型(claude/codex);供路由/前端区分,本会话内部行为由 deps.adapter.capabilities 决定。 */
  agentKind: AgentKind;
  /**
   * codex 首次启动后扫到真实 UUID 时回调,通知路由层落盘(claude 预指定 UUID,永不触发)。
   * 仅在 adapter.capabilities.presetSessionId=false 时可能被调。
   */
  onSessionIdResolved?: (sessionId: string) => void;
}

export interface TmuxLike {
  hasSession(name: string): Promise<boolean>;
  newDetached(name: string, cwd: string, command: string, cols: number, rows: number): Promise<void>;
  sendKeys(name: string, keys: string[]): Promise<void>;
  /** 发送字面量字符（AskUserQuestion 绝对数字键作答用）。 */
  sendLiteralKeys(name: string, text: string): Promise<void>;
  pasteText(name: string, text: string, bracketed?: boolean): Promise<void>;
  capturePaneVisible(name: string): Promise<string>;
  /** 强制 tmux 会话窗口归位到给定尺寸（聊天 ensure/refresh 时用，避免被终端模式缩列）。可选实现。 */
  resizeWindow?(name: string, cols: number, rows: number): Promise<void>;
}

// TranscriptLike 真身已上移到 ./agent/adapter(顶部 import + 此处 re-export 让既有路径不破)。
export type { TranscriptLike };

export interface ChatSessionDeps {
  tmux: TmuxLike;
  scrape: (pane: string) => PaneScrape;
  tail: TranscriptLike;
  /** 是否已存在该 sessionId 的 transcript（决定 --resume 还是 --session-id）。 */
  hasTranscript: () => boolean;
  /**
   * agent 适配器（必填）。ChatSession 据 adapter.capabilities.* 决定走哪些横切分支
   * （effort/askHook/hud/rewind/presetSessionId）；buildLaunchCmd/buildResumeCmd 供 ensure 拼启动命令。
   * claude adapter 全能力 true 且命令输出与既有 buildClaudeCmd 一字不差，故 claude 路径行为零变化。
   */
  adapter: AgentAdapter;
  /** 读屏轮询间隔（ms），默认 250。 */
  pollMs?: number;
  /** 预览无变化多少 tick 后判定空闲（running=false），默认 8。 */
  idleLimit?: number;
  /** 构造 rewind 控制器（默认用 RewindController）；便于测试注入 fake。 */
  makeRewind?: (tmuxName: string, tmux: TmuxLike) => RewindLike;
  /** 构造 ask 控制器（默认用 AskController）；便于测试注入 fake。 */
  makeAsk?: (tmuxName: string, tmux: TmuxLike) => AskLike;
  /** statusLine 捕获器 sidecar 目录（HUD 独立数据源）；缺省则不读 sidecar、退回 transcript/读屏。 */
  statuslineDir?: string;
  /** 读 sidecar 文件的注入 IO（便于测试）；缺省则不读 sidecar。 */
  readSidecar?: SidecarIO['read'];
  /**
   * AskUserQuestion hook sidecar 目录（RCC_ASK_DIR）。**设了即启用 hook 真值路径**：
   * 待答检测/取选项/作答全走 hook，读屏 parseAskPickerLive 不再参与（仅 askDir 未设时兜底）。
   */
  askDir?: string;
  /** launch 注入串（来自 askLaunchExtra）：env 导出 + --settings；ensure() 拼进启动命令。 */
  askLaunch?: { envExport: string; settingsArg: string };
  /** 读 hook sidecar（便于测试注入）；缺省用真实 readPendingAsk。 */
  readAskSidecar?: (dir: string, sessionId: string) => AskHookPending | null;
  /** 清掉 hook sidecar（ensure 时清残留;便于测试注入）。 */
  cleanAskSidecar?: (dir: string, sessionId: string) => void;
  /** 构造数字键作答驱动（默认 AskDriver）；便于测试注入 fake。 */
  makeAskDriver?: (tmuxName: string, tmux: TmuxLike) => AskDriverLike;
}

export interface ChatSessionEvents {
  onMessage: (m: ChatMessage) => void;
  onHistory: (snapshot: ChatHistorySnapshot) => void;
  onPreview: (text: string) => void;
  onTurnState: (running: boolean) => void;
  onAskState: (s: AskStateEvent) => void;
  /** 实时读屏检测到待答选择题(菜单刚打开/题目变化)。 */
  onAskPending: (a: AskPending) => void;
  /** 待答菜单消失(已作答/取消)。 */
  onAskPendingClear: () => void;
  /** 自动作答失败(前端复位卡片并提示改用终端/按键条)。 */
  onAskPendingFailed: (error?: string) => void;
  /** 顶部 HUD(statusLine/claude-hud)读屏变化(模型/上下文/限额)。 */
  onHud: (h: Hud) => void;
}

const KEYMAP: Record<ChatKey, string> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  enter: 'Enter',
  esc: 'Escape',
  'ctrl-c': 'C-c',
};

export class ChatSession {
  private messages: ChatMessage[] = [];
  private running = false;
  private lastPreview = '';
  private idleTicks = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** 刚发送后短暂屏蔽预览，直到屏幕反映新一轮（出现 spinner 或回显清空），
   * 避免把上一轮残留回复误当作本轮预览。 */
  private holdPreview = false;
  /** rewind 进行中：tick 期间跳过读屏预览/消息，避免 picker chrome 污染聊天。 */
  private rewindActive = false;
  private rewindCtl?: RewindLike;
  /** ask 驱动进行中:tick 静默,避免菜单 chrome 污染聊天。 */
  private askActive = false;
  private askCtl?: AskLike;
  private askDriver?: AskDriverLike;
  /** hook 模式多问题:当前题序(0 起)。作答推进,sidecar 消失归零。 */
  private askQIndex = 0;
  /** 实时待答态:当前屏选项签名(去重,避免每 tick 重发)与投影(重连补发)。 */
  private lastAskSig = '';
  private lastAsk: AskPending | null = null;
  /** HUD 态:整体签名(去重,百分比变才重发)与投影(重连补发)。 */
  private lastHudSig = '';
  private lastHud: Hud | null = null;
  /**
   * rewind 后的「边界」：被回退的用户消息 uuid。transcript 此刻未变（下一条消息才分叉），
   * 只要该消息仍在活动链上就把链截到它之前（维持回退显示）；一旦它离开活动链
   * （用户发了新消息→分叉）即清除，恢复正常渲染。
   */
  private rewoundBeforeUuid?: string;

  constructor(
    private readonly spec: ChatSpec,
    private readonly deps: ChatSessionDeps,
    private readonly events: ChatSessionEvents,
  ) {}

  /** 确保 tmux 会话存在：不存在则按是否已有 transcript 决定 resume/new（命令经 adapter 拼）。 */
  async ensure(): Promise<void> {
    if (!(await this.deps.tmux.hasSession(this.spec.tmuxName))) {
      const hasTranscript = this.deps.hasTranscript();
      // claude adapter 内部仍调 buildClaudeCmd（hasTranscript 决定 --resume/--session-id），
      // 输出与改造前完全一致；codex adapter 各自拼自己的启动/resume 命令。
      const cmd = hasTranscript
        ? this.deps.adapter.buildResumeCmd({
            launchCommand: this.spec.launchCommand,
            sessionId: this.spec.sessionId,
            effort: this.spec.effort,
            askLaunch: this.deps.askLaunch,
          })
        : this.deps.adapter.buildLaunchCmd({
            launchCommand: this.spec.launchCommand,
            sessionId: this.spec.sessionId,
            effort: this.spec.effort,
            askLaunch: this.deps.askLaunch,
          });
      await this.deps.tmux.newDetached(
        this.spec.tmuxName,
        this.spec.cwd,
        cmd,
        this.spec.cols,
        this.spec.rows,
      );

      // codex 不能预指定 UUID（presetSessionId=false）：首次启动后异步扫真实 UUID 并回写。
      // claude（presetSessionId=true）跳过——它的 UUID 启动时已经 --session-id 传死。
      if (!this.deps.adapter.capabilities.presetSessionId) {
        // .catch 防静默:onSessionIdResolved 会触发路由层落盘 I/O(Task 11),将来若抛
        // 而无人 await,会变成 unhandled rejection 且"sessionId 未回写→tail 永远指占位
        // →聊天历史空白"无任何日志。这里至少留 stderr 一行排障线索。
        void this.discoverAndPersistSessionId().catch((e) => {
          // eslint-disable-next-line no-console
          console.warn('[chatSession] discoverAndPersistSessionId 失败:', e instanceof Error ? e.message : e);
        });
      }
    }
    // 故意不 resize-window 强制归位:多 client(手机/电脑同时连)情况下,tmux 跟最小 attached client 走,
    // 强制设固定尺寸会和 attached client 抢,屏边出现一片 dots 协调中标记。
    // scrollback 错位由 ↺ 重排路径(SIGSTOP/CONT)解决,不该由 ensure 副作用碰 tmux 尺寸。

    // 清掉本会话的旧 ask sidecar:上次崩溃 / 用户在终端 Ctrl-C / claude 被 kill,
    // PreToolUse 写了但 PostToolUse 没机会删 → 文件残留 → tick 误判为"待答中"显示假卡片。
    // 真有待答时菜单还在 TUI 里,用户经 KeyBar/终端模式可作答;宁可漏报不要假报。
    // askHook 关闭(codex)时整段跳过——它没 hook,无 sidecar 概念。
    if (this.deps.adapter.capabilities.askHook && this.deps.askDir && this.deps.cleanAskSidecar) {
      try {
        this.deps.cleanAskSidecar(this.deps.askDir, this.spec.sessionId);
      } catch {
        /* 没文件 / 权限问题:忽略 */
      }
    }
    this.messages = this.deps.tail.activeChain();
  }

  /**
   * codex 首次启动后发现真实 sessionId 并回写。
   * 扫到且与占位不同 → 回调路由层落盘 + 调 tail.setSessionId 让 tail 切到真实文件。
   * claude 路径永不进这里(ensure 仅在 !presetSessionId 时调)。
   */
  private async discoverAndPersistSessionId(): Promise<void> {
    const startedAt = Date.now();
    const real = await this.deps.adapter.discoverSessionId({
      tentativeSessionId: this.spec.sessionId,
      unixUser: this.spec.unixUser ?? '',
      cwd: this.spec.cwd,
      timeoutMs: 5000,
      startedAt,
    });
    if (real && real !== this.spec.sessionId) {
      this.spec.onSessionIdResolved?.(real);
      // tail 经 setSessionId 钩子切换路径(可选接口成员;codex tail 有,claude tail 没有)。
      this.deps.tail.setSessionId?.(real);
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** 历史骨架快照(订阅/重连/分叉下发):用户全文 + 助手折叠占位 + 最后一轮 tail。 */
  getSkeleton(): ChatHistorySnapshot {
    return buildHistorySnapshot(this.messages, { running: this.running });
  }

  /** 按 turnId 取某助手回合完整正文(load_turn 展开用);未命中 null。 */
  getTurnBody(turnId: string): ChatMessage[] | null {
    return getTurnSlice(this.messages, turnId);
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendText(text: string): Promise<void> {
    if (!text) return;
    // 含换行(图文混合时的"文本 + uploaded images: + 路径"那种)必须走 bracketed paste,
    // 否则 \n 会被 claude TUI 当成 Enter 触发提交,一条消息被拆成 N 条。
    const multiline = text.includes('\n');
    await this.deps.tmux.pasteText(this.spec.tmuxName, text, multiline);
    // bracketed paste 后紧跟 Enter 字节,ink 在 \x1b[201~ 退出 paste mode 的同一 tick 里
    // 可能把 \r 当成 paste tail 吞掉(实测:文本进了输入框但没提交,要切到 tmux 手动回车)。
    // 单行也加这个延迟无所谓——本来 Enter 立即到也没人发觉。
    if (multiline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    await this.deps.tmux.sendKeys(this.spec.tmuxName, ['Enter']);
    this.holdPreview = true;
    this.setRunning(true);
  }

  async sendKey(key: ChatKey): Promise<void> {
    await this.deps.tmux.sendKeys(this.spec.tmuxName, [KEYMAP[key]]);
    if (key === 'enter') {
      this.holdPreview = true;
      this.setRunning(true);
    }
  }

  async interrupt(): Promise<void> {
    await this.sendKey('esc');
  }

  /**
   * 让 TUI 重画当前屏:只发 Ctrl-L,**不动 tmux 窗口尺寸**——主动 resize-window 会跟
   * 当前 attached client 抢尺寸(屏边出现一片 dots 协调中标记);让 tmux 按 attached client 自然跟随。
   * scrollback 错位由 ↺ 重排(SIGSTOP/CONT)解决,不在这里碰。
   * 不动 running/holdPreview/askActive——刷新只是重绘像素,不打断对话/思考。
   */
  async refresh(): Promise<void> {
    await this.deps.tmux.sendKeys(this.spec.tmuxName, ['C-l']);
  }

  /**
   * 运行中即时切换思考强度：发原生 /effort 命令（非交互、即时生效）。
   * 故意不置 holdPreview/running——/effort 不是一轮生成，不该显示"思考中"。
   */
  async setEffort(level: EffortLevel): Promise<void> {
    if (!this.deps.adapter.capabilities.effort) return; // codex 无 /effort,静默 noop
    await this.deps.tmux.pasteText(this.spec.tmuxName, `/effort ${level}`);
    await this.deps.tmux.sendKeys(this.spec.tmuxName, ['Enter']);
  }

  private ensureRewind(): RewindLike {
    if (!this.rewindCtl) {
      this.rewindCtl = this.deps.makeRewind
        ? this.deps.makeRewind(this.spec.tmuxName, this.deps.tmux)
        : new RewindController(this.spec.tmuxName, this.deps.tmux);
    }
    return this.rewindCtl;
  }

  /** 打开原生 rewind picker 并返回可回退点；期间 tick 静默。 */
  async rewindOpen(): Promise<RewindItem[]> {
    if (!this.deps.adapter.capabilities.rewind) return []; // codex 无 /rewind,返回空列表
    this.rewindActive = true;
    try {
      return (await this.ensureRewind().open()).items;
    } catch (e) {
      this.rewindActive = false;
      throw e;
    }
  }

  /**
   * 执行回退。成功后即时整屏：transcript 此刻尚未变（下一条消息才分叉），
   * 故按所选行序号截到「第 index 个用户文本消息」之前并广播 onHistory。
   */
  async rewindExecute(index: number, mode: RewindMode): Promise<RewindResult> {
    if (!this.deps.adapter.capabilities.rewind) return { ok: false, error: 'rewind 不支持' };
    let r: RewindResult;
    try {
      r = await this.ensureRewind().execute(index, mode);
    } finally {
      this.rewindActive = false;
    }
    if (r.ok) {
      const userTextIdx = this.messages
        .map((m, i) => ({ m, i }))
        .filter((x) => x.m.role === 'user' && x.m.blocks.some((b) => b.type === 'text'))
        .map((x) => x.i);
      const cut = userTextIdx[index];
      if (cut !== undefined) {
        this.rewoundBeforeUuid = this.messages[cut]?.uuid;
        this.messages = this.messages.slice(0, cut);
        this.events.onHistory(buildHistorySnapshot(this.messages, { running: this.running }));
      }
    }
    return r;
  }

  /** 关闭 rewind picker（取消）。 */
  async rewindCancel(): Promise<void> {
    if (!this.deps.adapter.capabilities.rewind) return; // codex 无 rewind,静默 noop
    try {
      await this.ensureRewind().cancel();
    } finally {
      this.rewindActive = false;
    }
  }

  private ensureAsk(): AskLike {
    if (!this.askCtl) {
      this.askCtl = this.deps.makeAsk
        ? this.deps.makeAsk(this.spec.tmuxName, this.deps.tmux)
        : new AskController(this.spec.tmuxName, this.deps.tmux);
    }
    return this.askCtl;
  }

  /**
   * 作答 AskUserQuestion:闭环驱动原生菜单。期间 tick 静默,避免菜单 chrome 污染。
   * 广播 driving→done/failed;成功后答案经 transcript 落地使选择框转「已作答」。
   */
  async answerAsk(toolUseId: string, picks: AskPick[]): Promise<void> {
    if (!this.deps.adapter.capabilities.askHook) {
      // codex 无 AskHook:广播 failed 让前端兜底(留终端/按键条手动作答)。
      this.events.onAskState({ toolUseId, status: 'failed', error: 'askHook 不支持' });
      return;
    }
    this.askActive = true;
    this.events.onAskState({ toolUseId, status: 'driving' });
    try {
      const r = await this.ensureAsk().answer(picks);
      this.events.onAskState(r.ok ? { toolUseId, status: 'done' } : { toolUseId, status: 'failed', error: r.error });
    } catch (e) {
      this.events.onAskState({ toolUseId, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.askActive = false;
    }
  }

  private ensureAskDriver(): AskDriverLike {
    if (!this.askDriver) {
      this.askDriver = this.deps.makeAskDriver
        ? this.deps.makeAskDriver(this.spec.tmuxName, this.deps.tmux)
        : new AskDriver(this.spec.tmuxName, this.deps.tmux as AskDriverTmux);
    }
    return this.askDriver;
  }

  /** 答完当前题后推进题序(多问题);非末题则置空签名以便下个 tick 重发下一题。 */
  private advanceQuestion(pending: AskHookPending): void {
    if (this.askQIndex + 1 < pending.questions.length) {
      this.askQIndex += 1;
      this.lastAskSig = '';
    }
    // 末题:等 PostToolUse 删 sidecar → tick 发 onAskPendingClear。
  }

  /**
   * 作答当前待答选择题(逐题)。驱动期 askActive=true 使 tick 静默。
   * hook 模式:用 AskDriver 绝对数字键作答(安全、不点歪),数字键不适用(多选/多项/>9/按前确认不过)
   * 则降级既有 AskController.answerCurrent。非 hook 模式:沿用既有 answerCurrent。
   * 成功后菜单关闭由 tick(sidecar 消失)发 onAskPendingClear;失败广播以便前端兜底(留菜单可手动答)。
   */
  async answerPendingAsk(optionIndices: number[]): Promise<void> {
    if (!this.deps.adapter.capabilities.askHook) {
      this.events.onAskPendingFailed('askHook 不支持'); // codex:前端复位卡片
      return;
    }
    this.askActive = true;
    try {
      if (this.deps.askDir) {
        const read = this.deps.readAskSidecar ?? readPendingAsk;
        const pending = read(this.deps.askDir, this.spec.sessionId);
        if (!pending || pending.questions.length === 0) {
          this.events.onAskPendingFailed('no-pending');
          return;
        }
        const qi = Math.min(this.askQIndex, pending.questions.length - 1);
        const q = pending.questions[qi];
        const r = await this.ensureAskDriver().answer(q.options, optionIndices, q.multiSelect);
        if (r.fallback) {
          const r2 = await this.ensureAsk().answerCurrent(optionIndices);
          if (!r2.ok) this.events.onAskPendingFailed(r2.error);
          else this.advanceQuestion(pending);
        } else if (!r.ok) {
          this.events.onAskPendingFailed(r.error);
        } else {
          this.advanceQuestion(pending);
        }
      } else {
        const r = await this.ensureAsk().answerCurrent(optionIndices);
        if (!r.ok) this.events.onAskPendingFailed(r.error);
      }
    } catch (e) {
      this.events.onAskPendingFailed(e instanceof Error ? e.message : String(e));
    } finally {
      this.askActive = false;
    }
  }

  /** 当前待答态(重连/新订阅补发用;待答态不在 transcript 历史里)。无则 null。 */
  getLiveAsk(): AskPending | null {
    if (!this.deps.adapter.capabilities.askHook) return null; // codex 无待答卡片
    if (this.deps.askDir) {
      const read = this.deps.readAskSidecar ?? readPendingAsk;
      const p = read(this.deps.askDir, this.spec.sessionId);
      if (!p || p.questions.length === 0) return null;
      return toAskPending(p, Math.min(this.askQIndex, p.questions.length - 1));
    }
    return this.lastAsk;
  }

  /** 当前 HUD 态(重连/新订阅补发用;HUD 是当前态、不在 transcript 里)。无则 null。 */
  getLiveHud(): Hud | null {
    if (!this.deps.adapter.capabilities.hud) return null; // codex 不识别用量 HUD
    return this.lastHud;
  }

  /** 抓当前原始可见屏（供前端 TerminalPeek 兜底看 TUI 菜单）。 */
  async capturePeek(): Promise<string> {
    return this.deps.tmux.capturePaneVisible(this.spec.tmuxName);
  }

  /** 一次轮询：先收 transcript 新消息，再读屏更新预览/运行态。 */
  async tick(): Promise<void> {
    if (this.ticking || this.rewindActive || this.askActive) return;
    this.ticking = true;
    try {
      // transcript 是 parentUuid 树：取活动分支与上次比较——前缀扩展则增量逐条广播，
      // 链头变化（rewind 分叉/缩短）则整屏 onHistory。
      let chain = this.deps.tail.activeChain();
      // rewind 边界：被回退消息仍在活动链上 → 维持截断；已分叉离开 → 解除边界。
      if (this.rewoundBeforeUuid) {
        const i = chain.findIndex((m) => m.uuid === this.rewoundBeforeUuid);
        if (i !== -1) chain = chain.slice(0, i);
        else this.rewoundBeforeUuid = undefined;
      }
      const prevU = this.messages.map((m) => m.uuid);
      const curU = chain.map((m) => m.uuid);
      const isPrefix = prevU.length <= curU.length && prevU.every((u, i) => u === curU[i]);
      let addedCount = 0;
      if (prevU.length === curU.length && isPrefix) {
        // 无变化
      } else if (isPrefix) {
        const added = chain.slice(prevU.length);
        addedCount = added.length;
        this.messages = chain;
        for (const m of added) this.events.onMessage(m);
      } else {
        this.messages = chain;
        this.events.onHistory(buildHistorySnapshot(chain, { running: this.running }));
      }

      const pane = await this.deps.tmux.capturePaneVisible(this.spec.tmuxName);

      // HUD:分层数据源(优先级递减),独立于预览/ask,故在 ask 早返回之前先广播
      // (待答期 HUD 仍应更新)。签名去重,变化才重发。
      //   1) sidecar(statusLine 捕获器,最完整:5h/周用量 + 原生 context%)——不依赖 claude-hud
      //   2) transcript 末条 assistant.usage 推 context(窗口未知则近似)
      //   3) 读屏 scrapeHud(pane)(旧路径,兜底)
      // pickHud 按此优先级合并(sidecar 缺 git 从 pane 补;transcript 叠加 pane 的用量)。
      // capabilities.hud 关闭(codex)整段跳过:codex 屏不是 claude 的 HUD 格式,识别没意义。
      if (this.deps.adapter.capabilities.hud) {
        const slHud =
          this.deps.statuslineDir && this.deps.readSidecar
            ? readStatuslineSidecar({ read: this.deps.readSidecar }, this.deps.statuslineDir, this.spec.sessionId)
            : null;
        const usage = this.deps.tail.lastAssistantUsage?.() ?? null;
        const trHud = !slHud && usage ? hudFromTranscript(usage) : null;
        const paneHud = scrapeHud(pane);
        const hud = pickHud({ statusline: slHud, transcript: trHud, pane: paneHud });
        if (hud) {
          const hudSig = JSON.stringify(hud);
          if (hudSig !== this.lastHudSig) {
            this.lastHudSig = hudSig;
            this.lastHud = hud;
            this.events.onHud(hud);
          }
        }
      }

      // 选择题待答。优先 hook 真值(askDir 设了即启用):sidecar 有→发待答(全结构)、抑制预览/运行、
      // 跳过其余读屏。hook 不可用(askDir 未设)时退回既有「读屏专属签名」检测,行为一字不改。
      // ——transcript 在待答期拿不到 tool_use,故 hook sidecar / 读屏是仅有的实时信号源。
      // capabilities.askHook 关闭(codex)时整段跳过:既有 hook 分支与读屏 parseAskPickerLive
      // 分支都不跑(codex 的待答交互由用户走终端/按键条手动处理)。
      if (this.deps.adapter.capabilities.askHook) {
        if (this.deps.askDir) {
          const read = this.deps.readAskSidecar ?? readPendingAsk;
          const pending = read(this.deps.askDir, this.spec.sessionId);
          if (pending && pending.questions.length > 0) {
            const qi = Math.min(this.askQIndex, pending.questions.length - 1);
            const ap = toAskPending(pending, qi);
            const sig = `${pending.toolUseId}#${qi}`;
            if (sig !== this.lastAskSig) {
              this.lastAskSig = sig;
              this.lastAsk = ap;
              this.events.onAskPending(ap);
            }
            if (this.running) this.setRunning(false); // 等输入,不是"思考中"
            this.holdPreview = false;
            return; // 跳过下方既有预览/运行逻辑
          }
          if (this.lastAskSig) {
            this.lastAskSig = '';
            this.lastAsk = null;
            this.askQIndex = 0;
            this.events.onAskPendingClear();
          }
          // hook 模式无待答:继续走下方既有预览/运行逻辑(不跑 parseAskPickerLive)。
        } else {
          const ask = parseAskPickerLive(pane);
          if (ask.open) {
            const sig = JSON.stringify(ask.options.map((o) => o.label)) + (ask.multiSelect ? '#m' : '');
            if (sig !== this.lastAskSig) {
              this.lastAskSig = sig;
              this.lastAsk = { options: ask.options, multiSelect: ask.multiSelect };
              this.events.onAskPending(this.lastAsk);
            }
            if (this.running) this.setRunning(false); // 等输入,不是"思考中"
            this.holdPreview = false;
            return; // 跳过下方既有预览/运行逻辑(完全不改其行为)
          }
          if (this.lastAskSig) {
            this.lastAskSig = '';
            this.lastAsk = null;
            this.events.onAskPendingClear();
          }
        }
      }

      const s = this.deps.scrape(pane);
      const idleLimit = this.deps.idleLimit ?? 8;
      const previewChanged = s.preview !== '' && s.preview !== this.lastPreview;

      // 发送后：屏幕出现 spinner 或回显已清空，说明新一轮已开始 → 解除预览屏蔽。
      if (this.holdPreview && (s.spinner || s.preview === '')) this.holdPreview = false;

      if (s.spinner) {
        // 明确在生成中
        this.idleTicks = 0;
        this.setRunning(true);
      } else if (s.done) {
        // 明确完成
        this.setRunning(false);
      } else if (this.running) {
        // 已在运行：靠"预览在变 / 有新消息"维持；否则累计空闲后判定结束。
        if (previewChanged || addedCount > 0) {
          this.idleTicks = 0;
        } else {
          this.idleTicks += 1;
          if (this.idleTicks >= idleLimit) this.setRunning(false);
        }
      }
      // 关键修复：running 不再由"屏幕上有静止内容"启动，只能由 spinner 或外部 sendText 启动。
      // 否则空闲时屏幕残留的上一轮回复会被反复当成新预览，导致 running 来回翻转（抽搐）。

      if (this.running && !this.holdPreview && previewChanged) {
        this.lastPreview = s.preview;
        this.events.onPreview(s.preview);
      }
    } finally {
      this.ticking = false;
    }
  }

  startPolling(): void {
    if (this.timer) return;
    const ms = this.deps.pollMs ?? 250;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 释放轮询，但不杀 tmux（会话后台续跑）。 */
  dispose(): void {
    this.stopPolling();
  }

  private setRunning(r: boolean): void {
    if (this.running === r) return;
    this.running = r;
    if (!r) {
      this.lastPreview = '';
      this.idleTicks = 0;
    }
    this.events.onTurnState(r);
  }
}
