import { useCallback, useEffect, useState } from 'react';
import { parseRoute, buildRoute, type Route, type SessionView } from '@rcc/shared';

/** 每个会话「上次所用视图」的 localStorage key（聊天/终端记忆）。 */
const viewKey = (convId: string) => `rcc:view:${convId}`;

/** 读会话记忆视图；缺省/异常一律默认 chat（与原 ProjectDetail 行为一致）。 */
export function rememberedView(convId: string): SessionView {
  try {
    return localStorage.getItem(viewKey(convId)) === 'terminal' ? 'terminal' : 'chat';
  } catch {
    return 'chat';
  }
}

/** 记住会话视图，供下次打开/规范化无后缀 URL 时恢复。 */
export function rememberView(convId: string, view: SessionView): void {
  try {
    localStorage.setItem(viewKey(convId), view);
  } catch {
    /* localStorage 不可用时忽略，不影响导航 */
  }
}

/**
 * 极简前端路由钩子（不引 react-router）。
 *
 * 把 window.location.pathname 当作单一真相，经 shared 的 parseRoute 解析成 Route；
 * navigate 用 history.pushState/replaceState 改地址并同步内部 state 触发重渲，
 * 同时监听 popstate（浏览器前进/后退）保持一致。
 */
export function useRoute(): {
  route: Route;
  navigate: (to: Route | string, opts?: { replace?: boolean }) => void;
} {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback(
    (to: Route | string, opts?: { replace?: boolean }) => {
      const path = typeof to === 'string' ? to : buildRoute(to);
      // 同一地址不入栈，避免后退要按多次。
      if (path === window.location.pathname && !opts?.replace) return;
      if (opts?.replace) window.history.replaceState(null, '', path);
      else window.history.pushState(null, '', path);
      setPathname(path);
    },
    [],
  );

  return { route: parseRoute(pathname), navigate };
}
