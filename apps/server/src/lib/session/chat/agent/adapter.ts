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
 * chatSession.ts 既有 TranscriptLike 接口的同形声明。
 * 留在这里是为了避免 adapter.ts → chatSession.ts 的反向 import 在 Task 8
 * (chatSession 改用 adapter) 落地后形成循环。Task 8 时把真身上移到本文件、消掉副本。
 */
export interface TranscriptLike {
  /** 当前活动分支(claude 按 parentUuid 回溯,codex 线性按时间顺序);正序的可渲染消息。 */
  activeChain(): ChatMessage[];
  /** 最后写入的主线 assistant 条目的 message.usage(HUD transcript 兜底数据源用);无则 null。 */
  lastAssistantUsage?(): Record<string, unknown> | null;
  /** 重置偏移与累积树(重连/全量重读用)。 */
  reset(): void;
}

/** discoverSessionId 入参（codex 首次启动后扫文件抓 UUID）。 */
export interface DiscoverSessionIdOpts {
  /** 创建会话时预生成的占位 UUID（主要用于派生 tmuxName 等本地用途）。 */
  tentativeSessionId: string;
  unixUser: string;
  cwd: string;
  timeoutMs: number;
  /** 启动时刻 ms 时间戳；只接受 mtime ≥ startedAt 的文件，避免抓到老 session。 */
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
}
