import { useEffect, useState } from 'react';
import type { Project, FileEntry } from '@rcc/shared';
import { api, type FileContent } from '../lib/api';

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function fmtSize(n?: number): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileBrowser({ project }: { project: Project }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setFile(null);
    setError('');
    api
      .listFiles(project.id, path)
      .then((r) => setEntries(r.entries))
      .catch((e) => setError((e as Error).message));
  }, [project.id, path]);

  const openFile = async (entry: FileEntry) => {
    try {
      const { file } = await api.readFile(project.id, entry.path);
      setFile(file);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (file) {
    const lines = file.kind === 'text' ? (file.content ?? '').split('\n') : [];
    const gutter = String(Math.max(lines.length, 1)).length;
    return (
      <div>
        <button className="btn ghost sm" onClick={() => setFile(null)} style={{ marginBottom: 'var(--sp-3)' }}>
          ‹ 返回列表
        </button>
        <div className="filename">{file.path}</div>
        {file.kind === 'text' && (
          <div className="filecode">
            {lines.map((line, i) => (
              <div className="codeline" key={i}>
                <span className="ln" style={{ minWidth: `${gutter}ch` }}>
                  {i + 1}
                </span>
                <span className="lc">{line}</span>
              </div>
            ))}
            {file.truncated && <div className="filecode-note">… 文件过大，已截断 …</div>}
          </div>
        )}
        {file.kind === 'image' && <img className="fileimg" src={file.content} alt={file.path} />}
        {file.kind === 'binary' && (
          <div className="empty">
            二进制文件（{file.mime}，{fmtSize(file.size)}），不可预览。
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="crumb">
        <button className="btn ghost sm" disabled={path === ''} onClick={() => setPath(parentOf(path))}>
          ‹ 上级
        </button>
        <span className="crumb-path">/{path}</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="list" style={{ gap: 'var(--sp-2)' }}>
        {entries.map((e) => (
          <button
            key={e.path}
            className="row"
            style={{ padding: 'var(--sp-3) var(--sp-4)' }}
            onClick={() => (e.kind === 'dir' ? setPath(e.path) : openFile(e))}
          >
            <span style={{ width: 22 }}>{e.kind === 'dir' ? '📁' : '📄'}</span>
            <div className="grow">
              <div className="name">{e.name}</div>
            </div>
            <span className="sub">{e.kind === 'dir' ? '' : fmtSize(e.size)}</span>
            {e.kind === 'dir' && <span className="chev">›</span>}
          </button>
        ))}
        {entries.length === 0 && !error && <div className="empty">空目录</div>}
      </div>
    </div>
  );
}
