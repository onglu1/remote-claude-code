/**
 * 前端 URL 路由的纯函数层（解析 / 构造）。
 *
 * URL 镜像 API 路径、自解释；与 React/DOM 完全解耦，便于单测。
 * React 侧的 useRoute 钩子（apps/web/src/lib/router.ts）只负责把
 * window.location 与 history 接到这两个纯函数上。
 */

export type ProjectTab = 'sessions' | 'files' | 'research';
export type ConversationView = 'chat' | 'terminal';

/** 应用的全部「位置」。判别联合，调用方按 name 渲染 / 重定向。 */
export type Route =
  | { name: 'projects' }
  | { name: 'project'; projectId: string; tab: ProjectTab }
  | {
      name: 'conversation';
      projectId: string;
      convId: string;
      /** 无视图后缀时为 null，由调用方据记忆规范化成 chat/terminal。 */
      view: ConversationView | null;
    }
  | { name: 'resources' }
  | { name: 'users' }
  | { name: 'unknown' };

/** 把 pathname 切成已解码、去空段、去尾斜杠的段数组。 */
function segments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
}

/** 解析 location.pathname → Route。无法匹配的一律 unknown（调用方重定向 /）。 */
export function parseRoute(pathname: string): Route {
  const seg = segments(pathname);

  // /
  if (seg.length === 0) return { name: 'projects' };

  // /resources
  if (seg.length === 1 && seg[0] === 'resources') return { name: 'resources' };

  // /users
  if (seg.length === 1 && seg[0] === 'users') return { name: 'users' };

  // /projects/...
  if (seg[0] === 'projects') {
    const projectId = seg[1];
    if (!projectId) return { name: 'unknown' };

    // /projects/:id
    if (seg.length === 2) return { name: 'project', projectId, tab: 'sessions' };

    // /projects/:id/files | /research(旧 /tasks 重定向到 /research,保持外链兼容)
    if (seg.length === 3) {
      if (seg[2] === 'files') return { name: 'project', projectId, tab: 'files' };
      if (seg[2] === 'research') return { name: 'project', projectId, tab: 'research' };
      if (seg[2] === 'tasks') return { name: 'project', projectId, tab: 'research' }; // legacy alias
      return { name: 'unknown' };
    }

    // /projects/:id/conversations/:cid[/chat|/terminal]
    if (seg[2] === 'conversations') {
      const convId = seg[3];
      if (!convId) return { name: 'unknown' };
      if (seg.length === 4) return { name: 'conversation', projectId, convId, view: null };
      if (seg.length === 5) {
        if (seg[4] === 'chat') return { name: 'conversation', projectId, convId, view: 'chat' };
        if (seg[4] === 'terminal')
          return { name: 'conversation', projectId, convId, view: 'terminal' };
      }
      return { name: 'unknown' };
    }

    return { name: 'unknown' };
  }

  return { name: 'unknown' };
}

const enc = encodeURIComponent;

/** 反向构造规范 URL：始终以 / 开头、无尾斜杠。unknown → /。 */
export function buildRoute(route: Route): string {
  switch (route.name) {
    case 'projects':
      return '/';
    case 'resources':
      return '/resources';
    case 'users':
      return '/users';
    case 'project': {
      const base = `/projects/${enc(route.projectId)}`;
      return route.tab === 'sessions' ? base : `${base}/${route.tab}`;
    }
    case 'conversation': {
      const base = `/projects/${enc(route.projectId)}/conversations/${enc(route.convId)}`;
      return route.view ? `${base}/${route.view}` : base;
    }
    case 'unknown':
      return '/';
  }
}
