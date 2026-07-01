/**
 * AgentAdapter：把 claude/codex 等不同 agent 在"启动命令拼接 / transcript 定位 /
 * jsonl 解析 / 首次 sessionId 发现 / 活动信号"这些点上的差异封装到一个对象后面，
 * ChatSession 与路由层不再硬编码 agent 字样。
 */
import type { AgentKind, ChatMessage, EffortLevel } from '@rcc/shared';
// ToolUseEvent 复用 activity.ts 的既有定义（单一真相源；activity.ts 是无依赖叶子模块，
// 这里 import type 不会触发循环）。后续 claudeAdapter 也会 import activity.parseToolUseEvents。
import type { ToolUseEvent } from '../../activity';
export type { ToolUseEvent };

/** 拼"首次启动"命令的入参（无 transcript 时）。 */
export interface LaunchOpts {
  launchCommand: string;
  sessionId: string;
  effort?: EffortLevel;
  /** AskHook env+settings 注入；仅 claude adapter 读，codex 忽略。 */
  askLaunch?: { envExport: string; settingsArg: string };
}

/** 拼"resume 续接"命令的入参（有 transcript 时）。 */
export interface ResumeOpts {
  launchCommand: string;
  sessionId: string;
  effort?: EffortLevel;
  askLaunch?: { envExport: string; settingsArg: string };
}

/**
 * transcript tail 的统一接口。adapter.makeTranscriptTail 返回它,ChatSession 直接消费。
 * 真身在此(Task 8 完成时从 chatSession.ts 上移过来,消掉同形副本)。
 */
export interface TranscriptLike {
  /** 当前活动分支(claude 按 parentUuid 回溯,codex 线性按时间顺序);正序的可渲染消息。 */
  activeChain(): ChatMessage[];
  /** 最后写入的主线 assistant 条目的 message.usage(HUD transcript 兜底数据源用);无则 null。 */
  lastAssistantUsage?(): Record<string, unknown> | null;
  /** 重置偏移与累积树(重连/全量重读用)。 */
  reset(): void;
  /**
   * 切换 tail 指向的 sessionId(codex 首次启动后发现真实 UUID 时由 ChatSession 调)。
   * claude tail 不实现(claude 是预指定 UUID,不需要切换)。
   */
  setSessionId?(sessionId: string): void;
}

/** discoverSessionId 入参（codex 首次启动后扫文件抓 UUID）。 */
export interface DiscoverSessionIdOpts {
  /** 创建会话时预生成的占位 UUID（主要用于派生 tmuxName 等本地用途）。 */
  tentativeSessionId: string;
  /** 已登记给其它会话的 sessionId；发现新 codex rollout 时必须排除。 */
  excludeSessionIds?: string[];
  unixUser: string;
  cwd: string;
  timeoutMs: number;
  /** 启动时刻 ms 时间戳；只接受本次启动后创建的文件，避免抓到老 session。 */
  startedAt: number;
}

export interface AgentAdapter {
  readonly kind: AgentKind;

  /** capabilities：chatSession 据此跳过/打开横切逻辑。 */
  readonly capabilities: {
    /** `--effort` 思考强度切换。 */
    effort: boolean;
    /** AskUserQuestion hook + 富卡片。 */
    askHook: boolean;
    /** HUD 用量识别（5h/周/context%）。 */
    hud: boolean;
    /** `/rewind` 原生回退。 */
    rewind: boolean;
    /** 创建会话时预生成 sessionId（claude=true；codex=false 需启动后抓取）。 */
    presetSessionId: boolean;
    /**
     * 读屏能可靠识别"生成中/已完成"(spinner、完成态图案)。claude=true。
     * codex(或其它 TUI 不一样的 agent)=false 时,ChatSession.tick() 的 running
     * 状态判定完全没有 spinner/done 兜底,只能靠"有没有新 transcript 消息"续命——
     * 据此把空闲判定阈值放宽(见 context.ts 组装 ChatSessionDeps 时对 idleLimit 的选取),
     * 否则一次思考/工具调用中间隔稍长没落盘新消息,就会被误判成"已完成"。
     */
    paneRunningSignal: boolean;
  };

  /** 拼"首次启动"命令（无 transcript 时）。 */
  buildLaunchCmd(opts: LaunchOpts): string;

  /** 拼"resume 续接"命令（有 transcript 时）。 */
  buildResumeCmd(opts: ResumeOpts): string;

  /** transcript jsonl 文件定位；null = 还不存在。 */
  locateTranscript(sessionId: string, unixUser: string, cwd: string): string | null;

  /** 构造 transcript tail（实现 TranscriptLike，供 ChatSession 直接用）。 */
  makeTranscriptTail(sessionId: string, unixUser: string, cwd: string): TranscriptLike;

  /**
   * 首次启动后发现真实 sessionId。
   * claude 实现：直接返回 tentativeSessionId（claude 是预指定的）。
   * codex 实现：轮询 ~/.codex/sessions/YYYY/MM/DD/ 找最新 rollout-*-<uuid>.jsonl，
   * 超时返回 null。
   */
  discoverSessionId(opts: DiscoverSessionIdOpts): Promise<string | null>;

  /** 解析"未配对工具调用"事件（给 IdleSweeper 五信号的信号 ① 用）。codex 实现可返回空。 */
  parseToolUseEvents(text: string): ToolUseEvent[];

  /**
   * 一次性解析 transcript 全文 → 主线消息(activeChain 等价)。
   * 索引层用,与 TranscriptTail 共享同一份解析逻辑(避免双实现漂移)。
   * 工具调用/工具结果块不出现在结果里(只保留主线 user/assistant 文本)。
   */
  parseTranscriptText(
    text: string,
    sessionId: string,
  ): Array<{ role: 'user' | 'assistant'; ts: string; content: string }>;
}
