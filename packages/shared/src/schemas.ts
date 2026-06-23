import { z } from 'zod';

/** 项目类型：开发 / 科研。手动设定，不靠探测。 */
export const ProjectTypeSchema = z.enum(['dev', 'research']);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

/**
 * 用户角色：管理员看全部+管理用户；普通用户只看自己的项目/会话。
 * 这是「应用层账号」分类（为视图干净），非安全边界。
 */
export const RoleSchema = z.enum(['admin', 'user']);
export type Role = z.infer<typeof RoleSchema>;

/** 应用层用户（存 config/users.json，不进 git）。passwordHash 为 argon2id。 */
export const UserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  role: RoleSchema,
  createdAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

/** 脱敏的「当前用户」：给前端与鉴权挂载用，绝不含 passwordHash。 */
export const AuthUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  role: RoleSchema,
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/** 思考强度级别（claude --effort / 会话内 /effort 的取值）。 */
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

/** 项目注册条目（来自 config/projects.json，显式登记，零扫描）。 */
export const ProjectSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'id 只能是小写字母数字与 -_，且非空'),
  name: z.string().min(1),
  path: z.string().min(1),
  type: ProjectTypeSchema,
  /** 自定义启动命令；默认 "Fable-yolo"（用户的 bash 别名）。工作目录即 path。 */
  launchCommand: z.string().min(1).default('Fable-yolo'),
  /** 可选：限制可浏览的子目录白名单（相对 path）。空 = 整个项目根可浏览。 */
  browseRoots: z.array(z.string()).optional(),
  /**
   * 拥有者用户 id。为兼容存量项目设为可选；context 启动时把缺失的回填为 admin。
   * 可见性：admin 看全部，普通用户仅看 ownerId === 自己 的项目。
   */
  ownerId: z.string().optional(),
  notes: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** 创建项目入参（id 可省略，由后端按 name 生成）。 */
export const ProjectCreateSchema = ProjectSchema.partial({ id: true, launchCommand: true });
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

/**
 * 视图（前端展现方式，非会话固有属性）：
 * 终端（xterm 直传 TUI）/ 聊天（原生交互式 + 结构化渲染）。
 * 同一个会话两种视图通用，可随时切换。
 */
export const SessionViewSchema = z.enum(['terminal', 'chat']);
export type SessionView = z.infer<typeof SessionViewSchema>;

/**
 * 一个会话 = 一个 tmux 会话内的原生 claude 进程。
 * 不再固定"终端/聊天"——两者只是同一会话的不同视图。
 * 所有会话都以 --session-id <sessionId> 启动，故两种视图都能用。
 */
export const ConversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  tmuxName: z.string().min(1),
  /** claude 会话 UUID：确定性定位 transcript 与 --resume；所有会话都有。 */
  sessionId: z.string().min(1),
  /** 会话级思考强度：启动 --effort、运行中 /effort 切换；默认 max。 */
  effort: EffortLevelSchema.default('max'),
  alive: z.boolean(),
  createdAt: z.string(),
  /** 软删除时间(ISO);存在 = 在垃圾箱里(不出现在常规列表,可恢复或彻底删)。 */
  deletedAt: z.string().optional(),
  /** 文件夹归属;null/缺省 = 未分类。 */
  folderId: z.string().nullable().optional(),
  /** 标星;默认 false。标星会话拒绝软删除。 */
  starred: z.boolean().default(false),
  /** 最近活跃时间(ISO),由活动探测器维护。 */
  lastActivityAt: z.string().optional(),
  /** 空闲自动关闭时间戳(ISO);存在=休眠中,resume 后清空。 */
  closedAt: z.string().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** 会话文件夹;按项目+用户隔离,平铺一层(不嵌套)。 */
export const FolderSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(40),
  sortOrder: z.number().int().default(0),
  createdAt: z.string(),
});
export type Folder = z.infer<typeof FolderSchema>;

/** 文件浏览条目。 */
export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(), // 相对项目根
  kind: z.enum(['dir', 'file']),
  size: z.number().optional(),
  mime: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

/** task / evidence 状态。 */
export const TaskStatusSchema = z.enum(['todo', 'doing', 'done', 'dropped']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskItemSchema = z.object({
  number: z.string(),
  title: z.string(),
  file: z.string(),
  status: TaskStatusSchema,
  priority: z.string().optional(),
  source: z.string().optional(),
  evidenceLinks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

export const EvidenceItemSchema = z.object({
  number: z.string(),
  title: z.string(),
  file: z.string(),
  conclusion: z.string().optional(),
  taskLinks: z.array(z.string()).default([]),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/* ---- 服务器资源面板（CPU / GPU / 内存 / 磁盘）实时快照 ---- */

/** 占用某块 GPU 的一个计算进程（谁在跑）。 */
export const MetricsGpuProcessSchema = z.object({
  pid: z.number(),
  /** 进程属主用户名（取自 ps，避免列宽截断取完整名）。未知时为空串。 */
  user: z.string(),
  /** 进程命令名（ps comm，短名如 python）。 */
  command: z.string(),
  memMiB: z.number(),
});
export type MetricsGpuProcess = z.infer<typeof MetricsGpuProcessSchema>;

/** 单块 GPU 的瞬时状态 + 其上的进程归属。 */
export const MetricsGpuSchema = z.object({
  index: z.number(),
  name: z.string(),
  utilPct: z.number(),
  memUsedMiB: z.number(),
  memTotalMiB: z.number(),
  tempC: z.number(),
  /** 空闲：利用率为 0 且无计算进程（有进程占显存即视为繁忙，别人不该上）。 */
  idle: z.boolean(),
  processes: z.array(MetricsGpuProcessSchema),
});
export type MetricsGpu = z.infer<typeof MetricsGpuSchema>;

export const MetricsCpuSchema = z.object({
  cores: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  /** 负载率 ≈ load1 / cores（可能 >1，前端按 100% 封顶展示）。 */
  loadPct: z.number(),
});
export type MetricsCpu = z.infer<typeof MetricsCpuSchema>;

export const MetricsMemSchema = z.object({
  totalMiB: z.number(),
  usedMiB: z.number(),
  availMiB: z.number(),
});
export type MetricsMem = z.infer<typeof MetricsMemSchema>;

/** 一个真实挂载点（伪文件系统 tmpfs/udev/… 已过滤）。 */
export const MetricsDiskSchema = z.object({
  mount: z.string(),
  totalKiB: z.number(),
  usedKiB: z.number(),
  availKiB: z.number(),
  usedPct: z.number(),
});
export type MetricsDisk = z.infer<typeof MetricsDiskSchema>;

/** 整机资源快照（GET /api/metrics 返回）。 */
export const MetricsSnapshotSchema = z.object({
  gpus: z.array(MetricsGpuSchema),
  /** 无 nvidia-smi（或采集失败）时 false 且 gpus 为空；CPU/内存/磁盘照常。 */
  gpuAvailable: z.boolean(),
  cpu: MetricsCpuSchema,
  mem: MetricsMemSchema,
  disks: z.array(MetricsDiskSchema),
  /** 采样毫秒时间戳。 */
  ts: z.number(),
});
export type MetricsSnapshot = z.infer<typeof MetricsSnapshotSchema>;

/** 终端历史阅读层一窗数据：真实屏字符(已 trimEnd)，nextBefore=下一更早窗游标(到顶为 0)。 */
export const ScrollbackChunkSchema = z.object({
  lines: z.array(z.string()),
  nextBefore: z.number().int().nullable(),
  atTop: z.boolean(),
});
export type ScrollbackChunk = z.infer<typeof ScrollbackChunkSchema>;
