import type {
  Project,
  Conversation,
  FileEntry,
  TaskItem,
  EvidenceItem,
  TaskStatus,
  AuthUser,
  Role,
  MetricsSnapshot,
  ScrollbackChunk,
  Folder,
} from '@rcc/shared';

export interface FileContent {
  kind: 'text' | 'image' | 'binary';
  path: string;
  mime: string;
  content?: string;
  truncated?: boolean;
  size: number;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  authState: () => req<{ user: AuthUser | null }>('GET', '/api/auth/state'),
  login: (username: string, password: string) =>
    req<{ user: AuthUser }>('POST', '/api/auth/login', { username, password }),
  /** 兼容别名：只发口令，按管理员处理（旧前端路径）。 */
  unlock: (password: string) =>
    req<{ user: AuthUser }>('POST', '/api/auth/unlock', { password }),
  lock: () => req<{ user: null }>('POST', '/api/auth/lock'),

  // 用户管理（仅管理员可成功调用）。
  adminListUsers: () => req<{ users: AuthUser[] }>('GET', '/api/admin/users'),
  adminAddUser: (u: { username: string; password: string; role: Role }) =>
    req<{ user: AuthUser }>('POST', '/api/admin/users', u),
  adminSetPassword: (id: string, password: string) =>
    req<{ user: AuthUser }>('PATCH', `/api/admin/users/${id}`, { password }),
  adminDeleteUser: (id: string) => req<{ ok: true }>('DELETE', `/api/admin/users/${id}`),

  /** 服务器全局资源快照（GPU/CPU/内存/磁盘）；任意登录用户可见。 */
  getMetrics: () => req<{ metrics: MetricsSnapshot }>('GET', '/api/metrics'),

  listProjects: () => req<{ projects: Project[] }>('GET', '/api/projects'),
  getProject: (id: string) => req<{ project: Project }>('GET', `/api/projects/${id}`),
  addProject: (p: {
    name: string;
    path: string;
    type: 'dev' | 'research';
    launchCommand?: string;
    notes?: string;
    ownerId?: string;
  }) => req<{ project: Project }>('POST', '/api/projects', p),
  deleteProject: (id: string) => req<{ ok: true }>('DELETE', `/api/projects/${id}`),

  listDirs: (path = '') =>
    req<{ root: string; absolute: string; path: string; dirs: { name: string; path: string }[] }>(
      'GET',
      `/api/fs/dirs?path=${encodeURIComponent(path)}`,
    ),

  listConversations: (pid: string) =>
    req<{ conversations: Conversation[] }>('GET', `/api/projects/${pid}/conversations`),
  /** 列出该项目的垃圾箱(已软删除的会话)。 */
  listTrash: (pid: string) =>
    req<{ conversations: Conversation[] }>('GET', `/api/projects/${pid}/conversations/trash`),
  /**
   * 新建会话。
   * @param opts.sessionId 给定时:用这个 claude session UUID 起会话,首次拉起即 --resume 接续。
   */
  createConversation: (pid: string, opts: { name?: string; sessionId?: string } = {}) =>
    req<{ conversation: Conversation }>('POST', `/api/projects/${pid}/conversations`, opts),
  renameConversation: (pid: string, cid: string, name: string) =>
    req<{ conversation: Conversation }>('PATCH', `/api/projects/${pid}/conversations/${cid}`, {
      name,
    }),
  /**
   * 关闭会话。默认软删除(进垃圾箱,可恢复);hard=true 时从存储抹掉(不可恢复)。
   * 两种都会先杀 tmux 释放 claude TUI,transcript 文件不动(仍可 resume)。
   */
  deleteConversation: (pid: string, cid: string, hard = false) =>
    req<{ ok: true; hard: boolean }>(
      'DELETE',
      `/api/projects/${pid}/conversations/${cid}${hard ? '?hard=1' : ''}`,
    ),
  /** 从垃圾箱恢复:清 deletedAt。tmux 不主动重启,进入会话时 ensure 按 --resume 拉起。 */
  restoreConversation: (pid: string, cid: string) =>
    req<{ conversation: Conversation }>('POST', `/api/projects/${pid}/conversations/${cid}/restore`),

  /**
   * 「重排」:杀 tmux + claude --resume,新 pane 按传入 cols/rows 起。
   * **必然中断当前 claude 任务**(工具调用/思考/AskUserQuestion 全保不住);调用方应先 confirm。
   * transcript 文件不动,resume 后历史依然可见。
   */
  reflowSession: (pid: string, cid: string, size?: { cols: number; rows: number }) => {
    const qs = size ? `?cols=${size.cols}&rows=${size.rows}` : '';
    return req<{ ok: true; cols: number; rows: number }>(
      'POST',
      `/api/projects/${pid}/conversations/${cid}/reflow${qs}`,
    );
  },

  /** 终端历史阅读层：取一窗真实屏字符。before 省略=最新一窗，否则取更早一窗。 */
  getScrollback: (pid: string, cid: string, before?: number, limit = 800) => {
    const params = new URLSearchParams();
    if (before != null) params.set('before', String(before));
    params.set('limit', String(limit));
    return req<ScrollbackChunk>(
      'GET',
      `/api/projects/${pid}/conversations/${cid}/scrollback?${params.toString()}`,
    );
  },

  listFiles: (pid: string, path = '') =>
    req<{ entries: FileEntry[]; path: string }>(
      'GET',
      `/api/projects/${pid}/files?path=${encodeURIComponent(path)}`,
    ),
  readFile: (pid: string, path: string) =>
    req<{ file: FileContent }>(
      'GET',
      `/api/projects/${pid}/file?path=${encodeURIComponent(path)}`,
    ),

  getTasks: (pid: string) =>
    req<{ tasks: TaskItem[]; evidence: EvidenceItem[]; hasDocs: boolean }>(
      'GET',
      `/api/projects/${pid}/tasks`,
    ),
  patchTask: (
    pid: string,
    num: string,
    patch: { status?: TaskStatus; evidenceLinks?: string[]; tags?: string[] },
  ) => req<{ ok: true; task: TaskItem }>('PATCH', `/api/projects/${pid}/tasks/${num}`, patch),

  // ---- 文件夹 CRUD(按项目+用户隔离,平铺一层) ----
  listFolders: (pid: string) =>
    req<{ folders: Folder[] }>('GET', `/api/projects/${pid}/folders`),
  createFolder: (pid: string, name: string) =>
    req<{ folder: Folder }>('POST', `/api/projects/${pid}/folders`, { name }),
  renameFolder: (pid: string, fid: string, name: string) =>
    req<{ folder: Folder }>('PATCH', `/api/projects/${pid}/folders/${fid}`, { name }),
  removeFolder: (pid: string, fid: string) =>
    req<{ reassigned: number }>('DELETE', `/api/projects/${pid}/folders/${fid}`),

  // ---- 会话 patch / 休眠恢复 / 批量 ----
  /** 通用 patch:支持 name / folderId(null=未分类) / starred。 */
  patchConversation: (
    pid: string,
    cid: string,
    patch: { name?: string; folderId?: string | null; starred?: boolean },
  ) =>
    req<{ conversation: Conversation }>(
      'PATCH',
      `/api/projects/${pid}/conversations/${cid}`,
      patch,
    ),
  /** 手动关闭(写 closedAt + 杀 tmux);不进垃圾箱,仍可恢复。 */
  closeConversation: (pid: string, cid: string) =>
    req<{ conversation: Conversation }>(
      'POST',
      `/api/projects/${pid}/conversations/${cid}/close`,
    ),
  /** 从休眠恢复:重起 tmux + --resume + 清 closedAt。 */
  resumeConversation: (pid: string, cid: string) =>
    req<{ conversation: Conversation }>(
      'POST',
      `/api/projects/${pid}/conversations/${cid}/resume`,
    ),
  /**
   * 批量动作:move/star/unstar/close/softDelete。
   * 后端"尽力而为":单条失败不阻断,在 failed 数组里给原因(如 starred_locked)。
   */
  batchConversations: (
    pid: string,
    body: {
      ids: string[];
      action: 'move' | 'star' | 'unstar' | 'close' | 'softDelete';
      payload?: { folderId?: string | null };
    },
  ) =>
    req<{ succeeded: string[]; failed: { id: string; reason: string }[] }>(
      'POST',
      `/api/projects/${pid}/conversations/batch`,
      body,
    ),

  // ---- 用户自身设置(目前只有 idleCloseHours) ----
  getSettings: () => req<{ idleCloseHours: number }>('GET', '/api/me/settings'),
  updateSettings: (s: { idleCloseHours: number }) =>
    req<{ idleCloseHours: number }>('PATCH', '/api/me/settings', s),
};

export { ApiError };
