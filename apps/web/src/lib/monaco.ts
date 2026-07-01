type MonacoApi = typeof import('monaco-editor');
type WorkerCtor = new () => Worker;

let monacoPromise: Promise<MonacoApi> | null = null;

export function setupMonaco(): Promise<MonacoApi> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const [editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('monaco-editor/esm/vs/language/json/json.worker?worker'),
        import('monaco-editor/esm/vs/language/css/css.worker?worker'),
        import('monaco-editor/esm/vs/language/html/html.worker?worker'),
        import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
      ]);
      const EditorWorker = editorWorker.default as WorkerCtor;
      const JsonWorker = jsonWorker.default as WorkerCtor;
      const CssWorker = cssWorker.default as WorkerCtor;
      const HtmlWorker = htmlWorker.default as WorkerCtor;
      const TsWorker = tsWorker.default as WorkerCtor;

      (
        self as unknown as {
          MonacoEnvironment?: { getWorker: (_workerId: string, label: string) => Worker };
        }
      ).MonacoEnvironment = {
        getWorker(_workerId, label) {
          if (label === 'json') return new JsonWorker();
          if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
          if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
          if (label === 'typescript' || label === 'javascript') return new TsWorker();
          return new EditorWorker();
        },
      };

      return import('monaco-editor');
    })();
  }
  return monacoPromise;
}

export function languageForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'css':
    case 'html':
    case 'json':
    case 'less':
    case 'scss':
    case 'typescript':
    case 'xml':
    case 'yaml':
      return ext;
    case 'cjs':
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'javascript';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'yml':
      return 'yaml';
    default:
      return 'plaintext';
  }
}
