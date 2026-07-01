import { useEffect, useState } from 'react';
import type { Project, Conversation, AuthUser, Route } from '@rcc/shared';
import { api } from './lib/api';
import { useRoute, rememberedView, rememberView } from './lib/router';
import { useTitle } from './lib/useTitle';
import { Login } from './components/Login';
import { ProjectList } from './components/ProjectList';
import { ProjectDetail } from './components/ProjectDetail';
import { ConversationView } from './components/ConversationView';
import { ResourcePanel } from './components/ResourcePanel';
import { UserAdmin } from './components/UserAdmin';
import { ProjectAdmin } from './components/ProjectAdmin';

type Nav = ReturnType<typeof useRoute>['navigate'];

export function App() {
  // undefined=加载中，null=未登录，AuthUser=已登录
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const { route, navigate } = useRoute();

  useEffect(() => {
    api
      .authState()
      .then((s) => setUser(s.user))
      .catch(() => setUser(null));
  }, []);

  // 标签页标题：项目/会话路由的标题由其子组件按解析出的名字设置（子 effect 先于父
  // effect 执行，这里跳过它们以免被覆盖）；其余路由在此统一回落。
  useEffect(() => {
    if (user && (route.name === 'project' || route.name === 'conversation')) return;
    const titles: Partial<Record<Route['name'], string>> = {
      resources: '资源',
      users: '用户管理',
      'admin-projects': '管理项目',
    };
    document.title = titles[route.name] ?? 'remote-cc';
  }, [route.name, user]);

  if (user === undefined) {
    return <div className="app" />;
  }

  // 未登录：渲染 Login，但停留在当前 URL（登录后原地重渲到目标位置）。
  if (!user) {
    return <Login onLoggedIn={(u) => setUser(u)} />;
  }

  switch (route.name) {
    case 'project':
      return <ProjectRoute route={route} navigate={navigate} />;
    case 'conversation':
      return <ConversationRoute route={route} navigate={navigate} />;
    case 'resources':
      return <ResourcePanel onBack={() => navigate({ name: 'projects' })} />;
    case 'users':
      // 仅 admin 可见；非 admin 直接退回项目列表。
      if (user.role !== 'admin') {
        navigate({ name: 'projects' }, { replace: true });
        return <div className="app" />;
      }
      return <UserAdmin me={user} onBack={() => navigate({ name: 'projects' })} />;
    case 'admin-projects':
      // 同 users:仅 admin 可见,非 admin 退回项目列表。
      // 管理员降级 2026-06-25:admin 跨 namespace 看/改/删项目的专用通道。
      if (user.role !== 'admin') {
        navigate({ name: 'projects' }, { replace: true });
        return <div className="app" />;
      }
      return <ProjectAdmin onBack={() => navigate({ name: 'projects' })} />;
    case 'projects':
      break;
    case 'unknown':
      navigate({ name: 'projects' }, { replace: true });
      return <div className="app" />;
  }

  return (
    <ProjectList
      user={user}
      onOpen={(project) => navigate({ name: 'project', projectId: project.id, tab: 'sessions' })}
      onOpenMetrics={() => navigate({ name: 'resources' })}
      onOpenUsers={() => navigate({ name: 'users' })}
      onOpenAdminProjects={() => navigate({ name: 'admin-projects' })}
      onLock={async () => {
        await api.lock().catch(() => {});
        setUser(null);
        navigate({ name: 'projects' }, { replace: true });
      }}
    />
  );
}

/** 按 projectId 解析项目实体后渲染 ProjectDetail；取不到则退回项目列表。 */
function ProjectRoute({
  route,
  navigate,
}: {
  route: Extract<Route, { name: 'project' }>;
  navigate: Nav;
}) {
  const { projectId, tab } = route;
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((r) => {
        if (alive) setProject(r.project);
      })
      .catch(() => {
        if (alive) navigate({ name: 'projects' }, { replace: true });
      });
    return () => {
      alive = false;
    };
  }, [projectId, navigate]);

  useTitle(project ? project.name : 'remote-cc');

  if (!project) return <div className="app" />;

  return (
    <ProjectDetail
      project={project}
      tab={tab}
      onBack={() => navigate({ name: 'projects' })}
      onChangeTab={(next) => navigate({ name: 'project', projectId, tab: next }, { replace: true })}
      onOpenConversation={(c) =>
        navigate({ name: 'conversation', projectId, convId: c.id, view: rememberedView(projectId, c.id) })
      }
    />
  );
}

type LoadedConversationRoute = {
  key: string;
  project: Project;
  conversation: Conversation;
};

/**
 * 按 id 解析项目 + 会话后渲染 ConversationView。
 * - 无视图后缀（view:null）→ 按记忆视图 replace 成规范 URL。
 * - 项目没了 → 退项目列表；会话没了 → 退该项目。
 */
function ConversationRoute({
  route,
  navigate,
}: {
  route: Extract<Route, { name: 'conversation' }>;
  navigate: Nav;
}) {
  const { projectId, convId, view } = route;
  const routeKey = `${projectId}:${convId}`;
  const [loaded, setLoaded] = useState<LoadedConversationRoute | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    Promise.all([api.getProject(projectId), api.listConversations(projectId)])
      .then(([pr, cr]) => {
        if (!alive) return;
        const conv = cr.conversations.find((c) => c.id === convId);
        if (!conv) {
          // 会话不存在/已删：退回该项目会话列表。
          navigate({ name: 'project', projectId, tab: 'sessions' }, { replace: true });
          return;
        }
        setLoaded({ key: routeKey, project: pr.project, conversation: conv });
      })
      .catch(() => {
        if (alive) navigate({ name: 'projects' }, { replace: true });
      });
    return () => {
      alive = false;
    };
  }, [projectId, convId, navigate]);

  // 无视图后缀：按记忆规范化成 chat/terminal（replace，不留历史）。
  useEffect(() => {
    if (view === null) {
      navigate(
        { name: 'conversation', projectId, convId, view: rememberedView(projectId, convId) },
        { replace: true },
      );
    }
  }, [view, projectId, convId, navigate]);

  const current = loaded?.key === routeKey ? loaded : null;
  useTitle(current ? current.conversation.name : 'remote-cc');

  if (view === null || !current) return <div className="app" />;

  return (
    <ConversationView
      key={current.key}
      project={current.project}
      conversation={current.conversation}
      view={view}
      onBack={() => navigate({ name: 'project', projectId, tab: 'sessions' })}
      onSwitchView={() => {
        const next = view === 'chat' ? 'terminal' : 'chat';
        rememberView(projectId, convId, next);
        // 视图切换用 replace：避免后退在两视图间反复横跳。
        navigate({ name: 'conversation', projectId, convId, view: next }, { replace: true });
      }}
    />
  );
}
