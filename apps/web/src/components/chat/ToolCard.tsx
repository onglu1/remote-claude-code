import { useState } from 'react';

interface ToolResult {
  content: string;
  isError?: boolean;
}

/** 提取工具调用的一行摘要（常见工具特化，其余回退到首个输入值）。 */
function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  switch (name) {
    case 'Bash':
      return s(i.command);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return s(i.file_path ?? i.path ?? i.notebook_path);
    case 'Grep':
      return s(i.pattern);
    case 'Glob':
      return s(i.pattern);
    case 'WebFetch':
      return s(i.url);
    case 'Task':
      return s(i.description ?? i.subagent_type);
    default: {
      const first = Object.values(i)[0];
      return s(first);
    }
  }
}

export function ToolCard({
  name,
  input,
  result,
}: {
  name: string;
  input: unknown;
  result?: ToolResult;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarize(name, input);
  const i = (input ?? {}) as Record<string, unknown>;

  return (
    <div className={`toolcard ${result?.isError ? 'err' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-ico">🔧</span>
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-sum">{summary}</span>}
        <span className="tool-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {name === 'Bash' ? (
            <pre className="tool-pre">$ {String(i.command ?? '')}</pre>
          ) : (
            <pre className="tool-pre">{JSON.stringify(input, null, 2)}</pre>
          )}
          {result && (
            <pre className={`tool-pre out ${result.isError ? 'err' : ''}`}>
              {result.content || '(无输出)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
