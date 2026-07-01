import { lazy, Suspense, useEffect, useState } from 'react';
import type { Project, Conversation, SessionView } from '@rcc/shared';
import { Terminal } from './Terminal';
import { ChatView } from './chat/ChatView';
import { VscodeFrame } from './VscodeFrame';
import { api } from '../lib/api';

const WorkspacePane = lazy(() =>
  import('./WorkspacePane').then((m) => ({ default: m.WorkspacePane })),
);

/**
 * 会话视图分发器：按 view 渲染聊天或终端。
 *
 * 这两种展现是「同一个原生 tmux 会话」的不同视图（项目硬要求），
 * 故 ChatView / Terminal 共用同一组 props，签名不变。
 * onBack / onSwitchView 由上层（App 路由总线）注入：返回回到项目，
 * 切换视图走 replace 导航 + 记忆，避免后退在两视图间反复横跳。
 */
export function ConversationView({
  project,
  conversation,
  view,
  onBack,
  onSwitchView,
}: {
  project: Project;
  conversation: Conversation;
  view: SessionView;
  onBack: () => void;
  onSwitchView: () => void;
}) {
  const common = { project, conversation, onBack, onSwitchView };
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [vscodeOpen, setVscodeOpen] = useState(false);
  const [vscodeUrl, setVscodeUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setVscodeUrl(null);
    api
      .getVscode(project.id)
      .then((r) => {
        if (alive) setVscodeUrl(r.enabled ? r.url : null);
      })
      .catch(() => {
        if (alive) setVscodeUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

  return (
    <div className={`conversation-shell ${workspaceOpen ? 'workspace-open' : ''}`}>
      <div className="conversation-main">
        {view === 'chat' ? <ChatView {...common} /> : <Terminal {...common} />}
      </div>
      <Suspense fallback={null}>
        <WorkspacePane
          project={project}
          open={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
        />
      </Suspense>
      <button
        className={`workspace-fab ${workspaceOpen ? 'active' : ''}`}
        onClick={() => {
          setWorkspaceOpen((v) => !v);
        }}
        title={workspaceOpen ? '隐藏文件编辑器' : '打开文件编辑器'}
        aria-label={workspaceOpen ? '隐藏文件编辑器' : '打开文件编辑器'}
      >
        文件
      </button>
      {vscodeUrl && !vscodeOpen && (
        <button
          className="vscode-fab"
          onClick={() => setVscodeOpen(true)}
          title="打开 VSCode Web"
          aria-label="打开 VSCode Web"
        >
          VSCode
        </button>
      )}
      {vscodeUrl && vscodeOpen && (
        <VscodeFrame project={project} url={vscodeUrl} onClose={() => setVscodeOpen(false)} />
      )}
    </div>
  );
}
