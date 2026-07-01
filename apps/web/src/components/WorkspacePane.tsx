import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry, Project } from '@rcc/shared';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { api, type FileContent } from '../lib/api';
import { languageForPath, setupMonaco } from '../lib/monaco';

type EntriesByDir = Record<string, FileEntry[]>;
type FloatFrame = { x: number; y: number; w: number; h: number };

const MIN_W = 360;
const MIN_H = 300;
const MIN_TREE_W = 140;
const MIN_EDITOR_W = 240;
const PREFETCH_CONCURRENCY = 3;
const MAX_PREFETCH_DEPTH = 3;
const MAX_PREFETCH_DIRS = 220;
const MAX_PREFETCH_CHILDREN_PER_DIR = 60;
const MAX_PREFETCH_DIR_BYTES = 96 * 1024;
const MAX_PREFETCH_CACHE_BYTES = 1024 * 1024;

type PrefetchJob = { path: string; depth: number };

function initialFrame(): FloatFrame {
  if (typeof window === 'undefined') return { x: 120, y: 80, w: 720, h: 520 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(Math.max(640, vw * 0.52), vw - 24);
  const h = Math.min(Math.max(460, vh * 0.68), vh - 24);
  return {
    x: Math.max(12, vw - w - 28),
    y: Math.max(12, (vh - h) * 0.18),
    w,
    h,
  };
}

function clampFrame(frame: FloatFrame): FloatFrame {
  if (typeof window === 'undefined') return frame;
  const minW = Math.min(MIN_W, Math.max(300, window.innerWidth - 16));
  const minH = Math.min(MIN_H, Math.max(260, window.innerHeight - 16));
  const maxW = Math.max(minW, window.innerWidth - 16);
  const maxH = Math.max(minH, window.innerHeight - 16);
  const w = Math.min(Math.max(minW, frame.w), maxW);
  const h = Math.min(Math.max(minH, frame.h), maxH);
  return {
    x: Math.min(Math.max(8, frame.x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, frame.y), Math.max(8, window.innerHeight - h - 8)),
    w,
    h,
  };
}

function clampTreeWidth(width: number, frameWidth: number): number {
  const min = Math.min(MIN_TREE_W, Math.max(96, frameWidth * 0.35));
  const max = Math.max(min, frameWidth - Math.min(MIN_EDITOR_W, frameWidth * 0.5));
  return Math.min(Math.max(width, min), max);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function dirname(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? '' : filePath.slice(0, i);
}

function basename(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? filePath : filePath.slice(i + 1);
}

function formatSize(size?: number): string {
  if (size == null) return '';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function depthOf(path: string): number {
  return path ? path.split('/').length : 0;
}

function estimateEntriesBytes(entries: FileEntry[]): number {
  return entries.reduce((sum, e) => sum + e.name.length + e.path.length + (e.mime?.length ?? 0) + 48, 0);
}

export function WorkspacePane({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const [entriesByDir, setEntriesByDir] = useState<EntriesByDir>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(['']));
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [activeFile, setActiveFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [treeOpen, setTreeOpen] = useState(true);
  const [frame, setFrame] = useState<FloatFrame>(() => clampFrame(initialFrame()));
  const [treeWidth, setTreeWidth] = useState(240);
  const [monacoApi, setMonacoApi] = useState<typeof import('monaco-editor') | null>(null);
  const entriesRef = useRef<EntriesByDir>({});
  const cacheBytesRef = useRef<Record<string, number>>({});
  const totalPrefetchBytesRef = useRef(0);
  const depthByDirRef = useRef<Record<string, number>>({});
  const loadingRef = useRef<Set<string>>(new Set());
  const requestsRef = useRef<Map<string, Promise<FileEntry[]>>>(new Map());
  const prefetchQueueRef = useRef<PrefetchJob[]>([]);
  const prefetchQueuedRef = useRef<Set<string>>(new Set());
  const prefetchSeenRef = useRef<Set<string>>(new Set());
  const prefetchActiveRef = useRef(0);
  const projectIdRef = useRef(project.id);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<MonacoEditor.ITextModel | null>(null);
  const savedRef = useRef({ path: '', content: '' });
  const dragRef = useRef<
    | { kind: 'move'; sx: number; sy: number; start: FloatFrame }
    | { kind: 'resize'; sx: number; sy: number; start: FloatFrame }
    | { kind: 'split'; sx: number; startWidth: number; frameWidth: number }
    | null
  >(null);

  const cacheEntries = useCallback((path: string, entries: FileEntry[], background: boolean) => {
    const bytes = estimateEntriesBytes(entries);
    if (background) {
      const previousBytes = cacheBytesRef.current[path] ?? 0;
      const nextTotal = totalPrefetchBytesRef.current - previousBytes + bytes;
      const nextCount = Object.keys(entriesRef.current).length + (entriesRef.current[path] ? 0 : 1);
      if (
        bytes > MAX_PREFETCH_DIR_BYTES ||
        nextTotal > MAX_PREFETCH_CACHE_BYTES ||
        nextCount > MAX_PREFETCH_DIRS
      ) {
        return false;
      }
      cacheBytesRef.current[path] = bytes;
      totalPrefetchBytesRef.current = nextTotal;
    }

    const next = { ...entriesRef.current, [path]: entries };
    entriesRef.current = next;
    setEntriesByDir(next);
    return true;
  }, []);

  const setDirLoading = useCallback((path: string, loading: boolean) => {
    const next = new Set(loadingRef.current);
    if (loading) next.add(path);
    else next.delete(path);
    loadingRef.current = next;
    setLoadingDirs(next);
  }, []);

  const schedulePrefetchRef = useRef<(path: string, entries: FileEntry[], depth: number) => void>(
    () => {},
  );
  const pumpPrefetchRef = useRef<() => void>(() => {});

  const fetchDir = useCallback(
    async (
      path: string,
      opts: { background?: boolean; prefetchChildren?: boolean; depth?: number } = {},
    ): Promise<FileEntry[]> => {
      const cached = entriesRef.current[path];
      if (cached) return cached;

      const visible = !opts.background;
      if (visible) {
        setDirLoading(path, true);
        setError('');
      }

      const existing = requestsRef.current.get(path);
      if (existing) {
        try {
          const entries = await existing;
          if (visible && !entriesRef.current[path]) {
            cacheEntries(path, entries, false);
            depthByDirRef.current[path] = opts.depth ?? depthByDirRef.current[path] ?? depthOf(path);
            if (opts.prefetchChildren) {
              schedulePrefetchRef.current(path, entries, depthByDirRef.current[path] ?? depthOf(path));
            }
          }
          return entries;
        } catch (e) {
          if (visible) setError(e instanceof Error ? e.message : '读取目录失败');
          return [];
        } finally {
          if (visible) setDirLoading(path, false);
        }
      }

      const requestProjectId = project.id;
      const background = !!opts.background;
      const depth = opts.depth ?? depthByDirRef.current[path] ?? depthOf(path);
      const request = api.listFiles(project.id, path).then((r) => {
        if (projectIdRef.current !== requestProjectId) return [];
        const cached = cacheEntries(path, r.entries, background);
        if (cached) {
          depthByDirRef.current[path] = depth;
          if (opts.prefetchChildren) schedulePrefetchRef.current(path, r.entries, depth);
        }
        return r.entries;
      });
      requestsRef.current.set(path, request);

      try {
        return await request;
      } catch (e) {
        if (visible) setError(e instanceof Error ? e.message : '读取目录失败');
        return [];
      } finally {
        if (requestsRef.current.get(path) === request) requestsRef.current.delete(path);
        if (visible) setDirLoading(path, false);
      }
    },
    [cacheEntries, project.id, setDirLoading],
  );

  const pumpPrefetch = useCallback(() => {
    while (
      prefetchActiveRef.current < PREFETCH_CONCURRENCY &&
      prefetchQueueRef.current.length > 0
    ) {
      const job = prefetchQueueRef.current.shift();
      if (!job) break;
      prefetchQueuedRef.current.delete(job.path);
      if (entriesRef.current[job.path] || requestsRef.current.has(job.path)) continue;

      prefetchActiveRef.current += 1;
      void fetchDir(job.path, {
        background: true,
        prefetchChildren: true,
        depth: job.depth,
      })
        .catch(() => {
          /* background prefetch is best-effort */
        })
        .finally(() => {
          prefetchActiveRef.current = Math.max(0, prefetchActiveRef.current - 1);
          pumpPrefetchRef.current();
        });
    }
  }, [fetchDir]);

  useEffect(() => {
    pumpPrefetchRef.current = pumpPrefetch;
  }, [pumpPrefetch]);

  const schedulePrefetch = useCallback((path: string, entries: FileEntry[], depth: number) => {
    if (depth >= MAX_PREFETCH_DEPTH) return;
    const childDepth = depth + 1;
    const childDirs = entries
      .filter((entry) => entry.kind === 'dir')
      .map((entry) => joinPath(path, entry.name))
      .filter((childPath) => !entriesRef.current[childPath] && !requestsRef.current.has(childPath))
      .slice(0, MAX_PREFETCH_CHILDREN_PER_DIR);

    for (const childPath of childDirs) {
      if (
        prefetchSeenRef.current.size >= MAX_PREFETCH_DIRS ||
        prefetchQueuedRef.current.has(childPath) ||
        prefetchSeenRef.current.has(childPath)
      ) {
        continue;
      }
      prefetchQueuedRef.current.add(childPath);
      prefetchSeenRef.current.add(childPath);
      prefetchQueueRef.current.push({ path: childPath, depth: childDepth });
    }
    pumpPrefetchRef.current();
  }, []);

  useEffect(() => {
    schedulePrefetchRef.current = schedulePrefetch;
  }, [schedulePrefetch]);

  useEffect(() => {
    projectIdRef.current = project.id;
    entriesRef.current = {};
    cacheBytesRef.current = {};
    totalPrefetchBytesRef.current = 0;
    depthByDirRef.current = {};
    loadingRef.current = new Set();
    requestsRef.current.clear();
    prefetchQueueRef.current = [];
    prefetchQueuedRef.current.clear();
    prefetchSeenRef.current.clear();
    prefetchActiveRef.current = 0;
    setEntriesByDir({});
    setOpenDirs(new Set(['']));
    setLoadingDirs(new Set());
    setActiveFile(null);
    setDraft('');
    setDirty(false);
    void fetchDir('', { prefetchChildren: true, depth: 0 });
  }, [project.id, fetchDir]);

  useEffect(() => {
    if (!editorHostRef.current || editorRef.current) return;
    let disposed = false;
    void setupMonaco()
      .then((monaco) => {
        if (disposed || !editorHostRef.current) return;
        const editor = monaco.editor.create(editorHostRef.current, {
          automaticLayout: true,
          fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          theme: 'vs-dark',
          readOnly: true,
        });
        editor.onDidChangeModelContent(() => {
          const value = editor.getValue();
          setDraft(value);
          setDirty(value !== savedRef.current.content);
          setStatus('');
        });
        editorRef.current = editor;
        setMonacoApi(monaco);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '编辑器加载失败');
      });
    return () => {
      disposed = true;
      modelRef.current?.dispose();
      editorRef.current?.dispose();
      modelRef.current = null;
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !monacoApi) return;
    modelRef.current?.dispose();
    modelRef.current = null;

    if (!activeFile || activeFile.kind !== 'text') {
      editor.setModel(null);
      editor.updateOptions({ readOnly: true });
      return;
    }

    const content = activeFile.content ?? '';
    const model = monacoApi.editor.createModel(content, languageForPath(activeFile.path));
    modelRef.current = model;
    savedRef.current = { path: activeFile.path, content };
    editor.setModel(model);
    editor.updateOptions({ readOnly: !!activeFile.truncated });
    setDraft(content);
    setDirty(false);
    setStatus(activeFile.truncated ? '文件较大，仅载入前 512KB，不能完整编辑。' : '');
  }, [activeFile, monacoApi]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const op = dragRef.current;
      if (!op) return;
      const dx = e.clientX - op.sx;
      if (op.kind === 'move') {
        const dy = e.clientY - op.sy;
        setFrame(clampFrame({ ...op.start, x: op.start.x + dx, y: op.start.y + dy }));
      } else if (op.kind === 'resize') {
        const dy = e.clientY - op.sy;
        setFrame(clampFrame({ ...op.start, w: op.start.w + dx, h: op.start.h + dy }));
      } else {
        setTreeWidth(clampTreeWidth(op.startWidth + dx, op.frameWidth));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.classList.remove('ws-dragging');
    };
    const onResize = () => setFrame((f) => clampFrame(f));
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', onResize);
      document.body.classList.remove('ws-dragging');
    };
  }, []);

  useEffect(() => {
    setTreeWidth((w) => clampTreeWidth(w, frame.w));
  }, [frame.w]);

  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(id);
  }, [open, treeOpen, treeWidth, frame.w, frame.h]);

  const activeDir = useMemo(() => (activeFile ? dirname(activeFile.path) : ''), [activeFile]);

  const toggleDir = async (path: string) => {
    const next = new Set(openDirs);
    if (next.has(path)) {
      next.delete(path);
      setOpenDirs(next);
      return;
    }
    next.add(path);
    setOpenDirs(next);
    const cached = entriesRef.current[path];
    if (cached) {
      schedulePrefetchRef.current(path, cached, depthByDirRef.current[path] ?? depthOf(path));
      return;
    }
    await fetchDir(path, {
      prefetchChildren: true,
      depth: depthByDirRef.current[path] ?? depthOf(path),
    });
  };

  const openFile = async (path: string) => {
    if (dirty && !window.confirm('当前文件还没保存，要放弃修改并打开其他文件吗？')) return;
    setError('');
    setStatus('读取中...');
    try {
      const r = await api.readFile(project.id, path);
      setActiveFile(r.file);
      if (r.file.kind !== 'text') {
        setDraft('');
        setDirty(false);
      }
      setStatus('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取文件失败');
      setStatus('');
    }
  };

  const saveFile = useCallback(async () => {
    if (!activeFile || activeFile.kind !== 'text' || activeFile.truncated) return;
    setError('');
    setStatus('保存中...');
    try {
      const content = editorRef.current?.getValue() ?? draft;
      const r = await api.writeFile(project.id, activeFile.path, content);
      setActiveFile(r.file);
      savedRef.current = { path: r.file.path, content };
      setDraft(content);
      setDirty(false);
      setStatus('已保存');
      const dir = dirname(activeFile.path);
      const nextEntries = { ...entriesRef.current };
      delete nextEntries[dir];
      entriesRef.current = nextEntries;
      const previousBytes = cacheBytesRef.current[dir] ?? 0;
      delete cacheBytesRef.current[dir];
      totalPrefetchBytesRef.current = Math.max(0, totalPrefetchBytesRef.current - previousBytes);
      setEntriesByDir(nextEntries);
      void fetchDir(dir, {
        prefetchChildren: true,
        depth: depthByDirRef.current[dir] ?? depthOf(dir),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      setStatus('');
    }
  }, [activeFile, draft, fetchDir, project.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      void saveFile();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveFile]);

  const startMove = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { kind: 'move', sx: e.clientX, sy: e.clientY, start: frame };
    document.body.classList.add('ws-dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const startResize = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { kind: 'resize', sx: e.clientX, sy: e.clientY, start: frame };
    document.body.classList.add('ws-dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const startSplit = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { kind: 'split', sx: e.clientX, startWidth: treeWidth, frameWidth: frame.w };
    document.body.classList.add('ws-dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };

  const renderDir = (path: string, depth: number) => {
    const entries = entriesByDir[path] ?? [];
    return (
      <div className="ws-tree-group" key={path}>
        {entries.map((entry) => {
          const childPath = joinPath(path, entry.name);
          const isDir = entry.kind === 'dir';
          const expanded = openDirs.has(childPath);
          const selected = activeFile?.path === childPath;
          return (
            <div key={childPath}>
              <button
                className={`ws-tree-row ${selected ? 'active' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => (isDir ? void toggleDir(childPath) : void openFile(childPath))}
                title={childPath}
              >
                <span className={`ws-tree-toggle ${isDir ? (expanded ? 'expanded' : 'collapsed') : 'file'}`} aria-hidden>
                  {isDir ? (expanded ? '-' : '+') : ''}
                </span>
                <span className="ws-tree-name">{entry.name}</span>
                {!isDir && <span className="ws-tree-meta">{formatSize(entry.size)}</span>}
              </button>
              {isDir && expanded && (
                <>
                  {loadingDirs.has(childPath) && (
                    <div className="ws-tree-loading" style={{ paddingLeft: 24 + depth * 14 }}>
                      读取中...
                    </div>
                  )}
                  {renderDir(childPath, depth + 1)}
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      className={`workspace-pane ${open ? 'open' : ''} ${treeOpen ? '' : 'tree-collapsed'}`}
      aria-label="文件编辑器"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.w,
        height: frame.h,
      }}
    >
      <div className="ws-head">
        <button
          className="ws-icon-btn"
          onClick={() => setTreeOpen((v) => !v)}
          title={treeOpen ? '隐藏文件树' : '显示文件树'}
          aria-label={treeOpen ? '隐藏文件树' : '显示文件树'}
        >
          ☰
        </button>
        <div className="ws-title ws-drag-region" onPointerDown={startMove}>
          文件
          <small>{project.name}</small>
        </div>
        <button className="ws-icon-btn" onClick={onClose} title="隐藏文件编辑器" aria-label="关闭">
          ×
        </button>
      </div>

      <div
        className="ws-body"
        style={{
          gridTemplateColumns: treeOpen ? `${treeWidth}px 6px minmax(0, 1fr)` : 'minmax(0, 1fr)',
        }}
      >
        <div className="ws-tree">
          <button
            className={`ws-tree-row root ${activeDir === '' ? 'context' : ''}`}
            onClick={() => void toggleDir('')}
            title={project.path}
          >
            <span className={`ws-tree-toggle ${openDirs.has('') ? 'expanded' : 'collapsed'}`} aria-hidden>
              {openDirs.has('') ? '-' : '+'}
            </span>
            <span className="ws-tree-name">{basename(project.path) || project.name}</span>
          </button>
          {loadingDirs.has('') && <div className="ws-tree-loading">读取中...</div>}
          {openDirs.has('') && renderDir('', 1)}
        </div>

        {treeOpen && <div className="ws-splitter" onPointerDown={startSplit} title="拖动调整文件树宽度" />}

        <div className="ws-editor">
          <div className="ws-editorbar">
            <div className="ws-file-title" title={activeFile?.path ?? ''}>
              {activeFile ? activeFile.path : '未打开文件'}
              {dirty && <span className="ws-dirty">●</span>}
            </div>
            <button
              className="btn sm primary"
              disabled={!activeFile || activeFile.kind !== 'text' || activeFile.truncated || !dirty}
              onClick={() => void saveFile()}
            >
              保存
            </button>
          </div>

          <div className="ws-editor-host" ref={editorHostRef} />

          {activeFile?.kind === 'image' && activeFile.content && (
            <div className="ws-preview">
              <img src={activeFile.content} alt={activeFile.path} />
            </div>
          )}
          {activeFile?.kind === 'binary' && (
            <div className="ws-placeholder">二进制文件不能在这里编辑。</div>
          )}
          {!activeFile && <div className="ws-placeholder">从左侧选择一个文本文件。</div>}
        </div>
      </div>

      {(status || error) && (
        <div className={`ws-status ${error ? 'err' : ''}`}>{error || status}</div>
      )}
      <div className="ws-resize-handle" onPointerDown={startResize} aria-hidden />
    </aside>
  );
}
