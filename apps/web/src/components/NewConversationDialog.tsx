import { useState, useEffect } from 'react';
import type { AgentKind, Project } from '@rcc/shared';

interface Props {
  project: Project;
  /** 提交回调:父组件用返回的 opts 调 api.createConversation。 */
  onCreate: (opts: {
    name?: string;
    agentKind: AgentKind;
    launchCommand?: string;
    sessionId?: string;
  }) => void;
  onCancel: () => void;
}

/** 标准 UUID 36 字符 hex 格式(claude v4 / codex v7 都通过)。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const [sessionId, setSessionId] = useState('');

  // 切换 agent 时清空 launchCommand,让 placeholder 显示新 agent 的默认值
  // (避免把 claude 的命令残留带进 codex 会话)。sessionId 也清,语义跨 agent 不同。
  useEffect(() => {
    setLaunchCommand('');
    setSessionId('');
  }, [agentKind]);

  const placeholder = agentKind === 'claude' ? project.launchCommand : CODEX_DEFAULT;
  const sidTrim = sessionId.trim();
  const sidValid = sidTrim === '' || UUID_RE.test(sidTrim);

  function submit() {
    if (!sidValid) return;  // 防御:format 不对直接拒,避免后端 400
    onCreate({
      name: name.trim() || undefined,
      agentKind,
      launchCommand: launchCommand.trim() || undefined,
      sessionId: sidTrim || undefined,
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

        <div className="nc-row">
          <label htmlFor="nc-sid">续接已有会话 UUID(可选)</label>
          <input
            id="nc-sid"
            type="text"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder={agentKind === 'codex' ? '019efe8e-2420-78a3-9d86-0bbd0df7c530' : '11111111-1111-1111-1111-111111111111'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={!sidValid}
          />
          <p className="nc-hint">
            {agentKind === 'codex'
              ? '填入 codex 真实 session UUID(可从 ~/.codex/sessions/ 或 /status 取),首次启动即以 codex resume --yolo 接续。'
              : '填入 claude session UUID,首次启动以 --resume 接续那段对话。留空 = 新建。'}
            {!sidValid && <span className="nc-error">  · 格式应为标准 UUID(8-4-4-4-12 hex)</span>}
          </p>
        </div>

        <div className="nc-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" onClick={submit} disabled={!sidValid}>
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
