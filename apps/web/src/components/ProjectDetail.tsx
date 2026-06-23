import type { Project, Conversation, ProjectTab } from '@rcc/shared';
import { ConversationList } from './ConversationList';
import { FileBrowser } from './FileBrowser';
import { ResearchView } from './research/ResearchView';

/**
 * 项目级页面（仅项目层：顶栏 + tab + 各 tab 内容）。
 *
 * tab 由 URL 决定（prop），切 tab / 打开会话 / 返回都通过上层注入的导航回调，
 * 会话视图本身已移到 ConversationView（由 App 路由总线按 id 解析后渲染）。
 * 改名同步顶栏标题的逻辑随会话视图一并移走，列表改名由 ConversationList 内部刷新即可。
 *
 * 历史:旧的 'Task / Evidence' tab 已并入「研究」(研究图覆盖 task/evidence 的全部职责
 * 且更结构化);旧 URL /projects/<id>/tasks 由 routes.ts 自动重定向为 research tab。
 */
export function ProjectDetail({
  project,
  tab,
  onBack,
  onChangeTab,
  onOpenConversation,
}: {
  project: Project;
  tab: ProjectTab;
  onBack: () => void;
  onChangeTab: (tab: ProjectTab) => void;
  onOpenConversation: (c: Conversation) => void;
}) {
  const tabs: { key: ProjectTab; label: string }[] = [
    { key: 'sessions', label: '会话' },
    { key: 'files', label: '文件' },
  ];
  if (project.type === 'research') tabs.push({ key: 'research', label: '研究' });

  return (
    <div className="app">
      <div className="topbar">
        <button className="back" onClick={onBack} aria-label="返回">
          ‹
        </button>
        <div className="title">
          {project.name}
          <small>
            {project.type === 'research' ? '科研项目' : '开发项目'} · {project.path}
          </small>
        </div>
      </div>

      <div className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tabbtn ${tab === t.key ? 'active' : ''}`}
            onClick={() => onChangeTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="content">
        {tab === 'sessions' && <ConversationList project={project} onOpen={onOpenConversation} />}
        {tab === 'files' && <FileBrowser project={project} />}
        {tab === 'research' && <ResearchView project={project} />}
      </div>
    </div>
  );
}
