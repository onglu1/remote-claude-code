import type {
  ResearchNode,
  NextItem,
  AffectedReport,
  GraphStats,
  NodeType,
  EvidenceResult,
  Edge,
} from '@rcc/shared';

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `GET ${url} → ${r.status}`);
  }
  return r.json() as Promise<T>;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `POST ${url} → ${r.status}`);
  }
  return r.json() as Promise<T>;
}

const base = (pid: string) => `/api/projects/${encodeURIComponent(pid)}/research`;

export const researchApi = {
  // ---- 读 ----
  initStatus: (pid: string) =>
    get<{ initialized: boolean; root: string }>(`${base(pid)}/init-status`),
  graph: (pid: string) => get<{ nodes: ResearchNode[] }>(`${base(pid)}/graph`),
  brief: (pid: string, rich = false, maxBytes?: number) => {
    const qs = new URLSearchParams();
    if (rich) qs.set('rich', '1');
    if (maxBytes !== undefined) qs.set('max-bytes', String(maxBytes));
    const s = qs.toString();
    return get<{ text: string }>(`${base(pid)}/brief${s ? '?' + s : ''}`);
  },
  next: (pid: string, opts?: { staleDays?: number; kinds?: string[] }) => {
    const qs = new URLSearchParams();
    if (opts?.staleDays !== undefined) qs.set('stale-days', String(opts.staleDays));
    if (opts?.kinds?.length) qs.set('kinds', opts.kinds.join(','));
    const s = qs.toString();
    return get<{ items: NextItem[] }>(`${base(pid)}/next${s ? '?' + s : ''}`);
  },
  analyze: (pid: string) => get<{ stats: GraphStats }>(`${base(pid)}/analyze`),
  affectedBy: (pid: string, id: string) =>
    get<{ report: AffectedReport }>(`${base(pid)}/affected-by/${encodeURIComponent(id)}`),
  node: (pid: string, id: string) =>
    get<{ node: ResearchNode; inEdges: { from: string; edge: Edge }[] }>(
      `${base(pid)}/node/${encodeURIComponent(id)}`,
    ),
  /** 读 research/text/<id>.md(或 node.text 显式指向的 path)的原始 markdown 内容。 */
  nodeText: (pid: string, id: string) =>
    get<{ exists: boolean; path: string; content: string | null }>(
      `${base(pid)}/text/${encodeURIComponent(id)}`,
    ),

  // ---- 写 ----
  init: (pid: string, payload: { name?: string; force?: boolean }) =>
    post<{ ok: true; report?: unknown }>(`${base(pid)}/init`, payload),
  add: (
    pid: string,
    payload: {
      type: NodeType;
      title: string;
      as?: string;
      parent?: string;
      summary?: string;
      expectation?: string;
      result?: EvidenceResult;
      url?: string;
    },
  ) => post<{ ok: true; node: ResearchNode }>(`${base(pid)}/add`, payload),
  set: (
    pid: string,
    payload: {
      id: string;
      title?: string;
      summary?: string;
      expectation?: string;
      text?: string;
    },
  ) => post<{ ok: true; node: ResearchNode }>(`${base(pid)}/set`, payload),
  link: (pid: string, payload: { from: string; to: string; label: string; note?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/link`, payload),
  unlink: (pid: string, payload: { from: string; to: string; label?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/unlink`, payload),
  contain: (pid: string, payload: { child: string; parent?: string | null }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/contain`, payload),
  split: (pid: string, payload: { id: string; into: string[] }) =>
    post<{ ok: true; nodes: ResearchNode[] }>(`${base(pid)}/split`, payload),
  merge: (pid: string, payload: { ids: string[]; title: string }) =>
    post<{ ok: true; task: ResearchNode }>(`${base(pid)}/merge`, payload),
  conclude: (
    pid: string,
    payload: {
      task: string;
      result: EvidenceResult;
      summary?: string;
      manifest?: string;
      output?: string[];
    },
  ) =>
    post<{ ok: true; task: ResearchNode; evidence: ResearchNode }>(
      `${base(pid)}/conclude`,
      payload,
    ),
  supersede: (pid: string, payload: { id: string; by: string; reason?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/supersede`, payload),
  invalidate: (pid: string, payload: { id: string; reason: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/invalidate`, payload),
  drop: (pid: string, payload: { id: string; reason: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/drop`, payload),
  block: (pid: string, payload: { id: string; on: string[] }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/block`, payload),
  unblock: (pid: string, payload: { id: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/unblock`, payload),
  contradict: (pid: string, payload: { a: string; b: string; note?: string }) =>
    post<{ ok: true; a: ResearchNode; b: ResearchNode }>(`${base(pid)}/contradict`, payload),
  resolve: (pid: string, payload: { a: string; b: string; by?: string }) =>
    post<{ ok: true; a: ResearchNode; b: ResearchNode }>(`${base(pid)}/resolve`, payload),
  alias: (pid: string, payload: { id: string; name: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/alias`, payload),
  status: (pid: string, payload: { id: string; set: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/status`, payload),
  linkCode: (pid: string, payload: { id: string; path: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/link-code`, payload),
  linkOutput: (pid: string, payload: { id: string; path: string; manifest?: string }) =>
    post<{ ok: true; node: ResearchNode }>(`${base(pid)}/link-output`, payload),
  importLegacy: (pid: string, payload: { docsDir?: string } = {}) =>
    post<{ ok: true; report: { createdTasks: string[]; createdEvidence: string[]; skipped: string[]; linksAdded: number; warnings: string[] } }>(`${base(pid)}/import-legacy`, payload),
};
