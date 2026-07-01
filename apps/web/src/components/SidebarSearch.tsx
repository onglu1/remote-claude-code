/**
 * Sidebar 顶部跨会话搜索框 + 扁平结果列表。
 * - 空 query 时不渲染结果(SidebarTree 保持原有分组列表)
 * - debounce 300ms,避免每按一键就发请求
 * - 结果点击:onSelect(projectId, convId) 由父组件负责跳转
 * - 命中片段含 <mark>,经 sanitizeSnippet 过白名单后用 dangerouslySetInnerHTML 渲染高亮
 */
import { useEffect, useRef, useState } from 'react';
import { api, type SessionSearchResult } from '../lib/api';
import { useRoute } from '../lib/router';

interface Props {
  /** 可选:把搜索作用域限制在某项目内(传 projectId);默认跨项目 */
  projectId?: string;
  /** 可选:结果点击时的额外回调(在跳转前调,用于父级清状态等)。 */
  onSelect?: (projectId: string, convId: string) => void;
}

export function SidebarSearch({ projectId, onSelect }: Props) {
  const { navigate } = useRoute();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SessionSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults(null);
      return;
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        // 默认 visibility 会排除休眠/垃圾箱——但下面结果卡片本来就有"· 休眠"/"· 垃圾箱"
        // 标签要渲染,搜索理应覆盖全部三态,不能只让"找回旧会话"这个最常见诉求落空。
        const { results } = await api.searchSessions({ q, projectId, visibility: 'all' });
        setResults(results);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [q, projectId]);

  return (
    <div className="sidebar-search">
      <input
        type="search"
        className="input sidebar-search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索会话(跨项目/跨 agent)…"
        aria-label="搜索会话"
      />
      {results !== null && (
        <div className="sidebar-search-results">
          {loading && <div className="sidebar-search-hint">搜索中…</div>}
          {!loading && results.length === 0 && (
            <div className="sidebar-search-hint">无匹配</div>
          )}
          {results.map((r) => (
            <button
              key={r.sessionKey}
              className="sidebar-search-row"
              onClick={() => {
                onSelect?.(r.projectId, r.convId);
                navigate(`/projects/${r.projectId}/conversations/${r.convId}`);
                setQ('');
                setResults(null);
              }}
            >
              <div className="sidebar-search-row-head">
                <span className={`sidebar-search-badge agent-${r.agentKind}`}>
                  {r.agentKind === 'codex' ? 'X' : 'C'}
                </span>
                <span className="sidebar-search-row-name">{r.name}</span>
                {r.starred && <span className="sidebar-search-row-star">★</span>}
              </div>
              {r.matchSnippet ? (
                <div
                  className="sidebar-search-snippet"
                  dangerouslySetInnerHTML={{ __html: sanitizeSnippet(r.matchSnippet) }}
                />
              ) : r.firstUserMessage ? (
                <div className="sidebar-search-snippet">{r.firstUserMessage}</div>
              ) : null}
              <div className="sidebar-search-row-meta">
                {r.projectId}
                {r.closedAt && <span className="sidebar-search-tag"> · 休眠</span>}
                {r.deletedAt && <span className="sidebar-search-tag"> · 垃圾箱</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 只允许 <mark>...</mark>,其他 HTML 全部 escape;防止 transcript 里混入恶意 HTML 被执行。
 * 后端 FTS5 snippet 内嵌 <mark> 标记是已知白名单。
 */
function sanitizeSnippet(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}
