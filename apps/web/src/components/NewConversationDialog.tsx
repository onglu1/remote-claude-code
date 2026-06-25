import { useState, useEffect } from 'react';
import type { AgentKind, Project } from '@rcc/shared';

interface Props {
  project: Project;
  /** 提交回调:父组件用返回的 opts 调 api.createConversation。 */
  onCreate: (opts: { name?: string; agentKind: AgentKind; launchCommand?: string }) => void;
  onCancel: () => void;
}

/** codex 全局默认启动命令(与后端 CODEX_DEFAULT_LAUNCH 常量保持一致)。 */
const CODEX_DEFAULT = 'codex --yolo';

/**
 * 新建会话弹窗:选 agent(Claude/Codex)+ 可选改名 + 可选自定义启动命令。
 * 留空的字段交给后端 adapter 兜底默认,故 placeholder 只作提示、不强制填。
 */
export function NewConversationDialog({ project, onCreate, onCancel }: Props) {
  const [agentKind, setAgentKind] = useState<AgentKind>('claude');
  const [name, setName] = useState('');
  const [launchCommand, setLaunchCommand] = useState('');

  // 切换 agent 时清空 launchCommand,让 placeholder 显示新 agent 的默认值
  // (避免把 claude 的命令残留带进 codex 会话)。
  useEffect(() => {
    setLaunchCommand('');
  }, [agentKind]);

  const placeholder = agentKind === 'claude' ? project.launchCommand : CODEX_DEFAULT;

  function submit() {
    onCreate({
      name: name.trim() || undefined,
      agentKind,
      launchCommand: launchCommand.trim() || undefined,
    });
  }

  return (
    <div className="nc-overlay" onClick={onCancel}>
      <div
        className="nc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="nc-title">新建会话</h3>

        <div className="nc-row">
          <label>Agent</label>
          <div className="nc-pill-toggle">
            <button
              type="button"
              className={agentKind === 'claude' ? 'active' : ''}
              onClick={() => setAgentKind('claude')}
            >
              Claude
            </button>
            <button
              type="button"
              className={agentKind === 'codex' ? 'active' : ''}
              onClick={() => setAgentKind('codex')}
            >
              Codex
            </button>
          </div>
        </div>

        <div className="nc-row">
          <label htmlFor="nc-name">名称(可选)</label>
          <input
            id="nc-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="留空自动生成"
            maxLength={60}
          />
        </div>

        <div className="nc-row">
          <label htmlFor="nc-launch">启动命令</label>
          <input
            id="nc-launch"
            type="text"
            value={launchCommand}
            onChange={(e) => setLaunchCommand(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {agentKind === 'codex' && (
          <p className="nc-note">
            注:resume 固定 <code>codex resume --yolo &lt;UUID&gt;</code>,自定义启动命令仅影响首次启动。
          </p>
        )}

        <div className="nc-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={submit}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
