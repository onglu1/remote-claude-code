import type { Project, Conversation, SessionView } from '@rcc/shared';
import { Terminal } from './Terminal';
import { ChatView } from './chat/ChatView';

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
  return view === 'chat' ? <ChatView {...common} /> : <Terminal {...common} />;
}
