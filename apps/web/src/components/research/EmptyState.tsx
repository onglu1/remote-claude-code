import { useState } from 'react';
import { researchApi } from '../../lib/researchApi';

export function EmptyState({ projectId, onInitialized }: { projectId: string; onInitialized: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const doInit = async (importLegacy: boolean) => {
    setBusy(true); setErr(null);
    try {
      await researchApi.init(projectId, {});
      if (importLegacy) {
        const r = await researchApi.importLegacy(projectId, {});
        const rep = r.report;
        alert(`导入完成:task ${rep.createdTasks.length} 个 / evidence ${rep.createdEvidence.length} 个 / 边 ${rep.linksAdded} 条`);
      }
      onInitialized();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="empty-state">
      <h3>研究图未初始化</h3>
      <p>这个项目还没有 research/ 目录。可以选择:</p>
      <ul className="empty-options">
        <li>仅初始化空目录结构(CLAUDE.md / docs/overview.md 模板)。</li>
        <li>初始化并尝试从旧 <code>docs/tasks/INDEX.md</code> + <code>docs/evidence/INDEX.md</code> 一次性导入为节点。</li>
      </ul>
      {err && <div className="empty-err">{err}</div>}
      <div className="empty-actions">
        <button className="primary" disabled={busy} onClick={() => doInit(false)}>
          {busy ? '初始化中…' : '仅初始化'}
        </button>
        <button className="primary outline" disabled={busy} onClick={() => doInit(true)}>
          {busy ? '导入中…' : '初始化并导入旧 INDEX'}
        </button>
      </div>
    </div>
  );
}
