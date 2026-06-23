import {
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import { SlashPalette } from './SlashPalette';

/**
 * 一个待发送附件:从加入队列到上传完毕的整个生命周期。
 * 用 status + progress 驱动 UI(上传中显进度条、完成显"已上传"、失败显错误)。
 */
type Attachment = {
  id: string; // 本地随机
  name: string;
  type: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  progress: number; // 0..100
  path?: string; // 上传完成后的服务端绝对路径(claude TUI 直接识别)
  thumb?: string; // FileReader 出的 data URL,用于本地预览缩略图
  error?: string;
  xhr?: XMLHttpRequest; // 删除附件时用来 abort 正在上传的请求
};

/**
 * 用 XHR 上传(不用 fetch:fetch 没原生上传进度回调)。
 * 返回 xhr 本身,调用方可以 abort。回调:进度/完成/错误。
 */
function startUpload(
  projectId: string,
  convId: string,
  file: File,
  onProgress: (pct: number) => void,
  onDone: (data: { path: string }) => void,
  onError: (msg: string) => void,
): XMLHttpRequest {
  const xhr = new XMLHttpRequest();
  const qs = new URLSearchParams({
    name: file.name || 'image',
    mime: file.type || 'image/png',
  });
  xhr.open(
    'POST',
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(convId)}/uploads?${qs}`,
  );
  // **始终用 octet-stream**:后端 /uploads 只给这一种注册了 body parser,直接发 image/png
  // 会被 Fastify 当成 unknown 415 掉。真实 mime 走 query `?mime=` 传(后端拿这个起文件扩展名)。
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.withCredentials = true;
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText) as { path: string };
        if (!data?.path) return onError('服务端没返回路径');
        onDone(data);
      } catch {
        onError('响应格式错误');
      }
    } else {
      let msg = `HTTP ${xhr.status}`;
      try {
        const j = JSON.parse(xhr.responseText) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* 忽略 */
      }
      onError(msg);
    }
  };
  xhr.onerror = () => onError('网络错误');
  xhr.onabort = () => onError('已取消');
  // arrayBuffer 是异步的,等拿到再 send;Promise.catch 兜底防 send 前出错。
  file
    .arrayBuffer()
    .then((buf) => xhr.send(buf))
    .catch((e) => onError(e instanceof Error ? e.message : '读取文件失败'));
  return xhr;
}

export function Composer({
  projectId,
  convId,
  onSend,
}: {
  projectId: string;
  convId: string;
  /** text 可空(只发图);attachments 是已上传完毕的图片(path 服务端绝对路径,name 原文件名,只用作 alt)。 */
  onSend: (text: string, attachments: { path: string; name: string }[]) => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // dragenter/dragleave 在子元素之间穿梭时会乱触发,用计数器抵消子元素切换的"假离开"。
  const dragDepth = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  /** 把一个图片 File 加进上传队列;非图片忽略。同时启动 XHR 上传。 */
  const enqueueFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // 占位条目立即入列,UI 马上能看到"准备上传";thumb 等 FileReader 异步补。
    const initial: Attachment = {
      id,
      name: file.name || 'image',
      type: file.type || 'image/png',
      size: file.size,
      status: 'uploading',
      progress: 0,
    };
    setAttachments((prev) => [...prev, initial]);

    // 本地预览(不阻塞上传)。
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, thumb: url } : a)));
    };
    reader.readAsDataURL(file);

    const xhr = startUpload(
      projectId,
      convId,
      file,
      (pct) => setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, progress: pct } : a))),
      (data) =>
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, status: 'done', progress: 100, path: data.path } : a,
          ),
        ),
      (err) =>
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: 'error', error: err } : a)),
        ),
    );
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, xhr } : a)));
  };

  /** 删一个附件:正在上传就 abort。 */
  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      if (item?.xhr && item.status === 'uploading') {
        try {
          item.xhr.abort();
        } catch {
          /* 已结束:忽略 */
        }
      }
      return prev.filter((a) => a.id !== id);
    });
  };

  /** 失败的附件用户可以重传(用同一个 file 不可能,所以这里只能让用户重新选/粘)。简化:直接移除。 */
  const dismissAttachment = removeAttachment;

  /** 文件选择:支持多选,逐个入队。 */
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const f of files) enqueueFile(f);
  };

  /**
   * 粘贴:从 clipboardData.items 取所有 image/*,逐个入队。
   * 用 preventDefault 阻止粘贴板的文本（如截图工具同时塞了"file://...png"那种）也进 textarea。
   * 非图片粘贴(纯文本)走默认行为不拦,正常贴进输入框。
   */
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length === 0) return; // 没图片,让默认粘贴行为继续
    e.preventDefault();
    for (const f of imgs) enqueueFile(f);
  };

  /**
   * 拖拽进入/移出/落下:dragenter/leave 会在父→子穿梭时连发,用计数器抵消「假离开」,
   * 保证整段拖拽过程 dragOver 状态稳定。dragover 必须 preventDefault 否则浏览器默认会拒绝 drop。
   */
  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return; // 拖文本/链接不是文件,不响应
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const f of files) enqueueFile(f);
  };

  const anyUploading = attachments.some((a) => a.status === 'uploading');
  const doneAttachments = attachments.filter((a) => a.status === 'done');
  const canSend = !anyUploading && (text.trim().length > 0 || doneAttachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    const t = text.trim();
    onSend(
      t,
      doneAttachments.map((a) => ({ path: a.path!, name: a.name })),
    );
    setText('');
    setAttachments([]);
    requestAnimationFrame(grow);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const showSlash = text.startsWith('/') && !text.includes(' ') && !text.includes('\n');

  return (
    <div
      className={`composer${dragOver ? ' dragover' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="composer-dropzone" aria-hidden>
          松开手把图片放进对话
        </div>
      )}
      {showSlash && (
        <SlashPalette
          filter={text}
          onPick={(cmd) => {
            setText(cmd + ' ');
            taRef.current?.focus();
          }}
        />
      )}

      {attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((a) => (
            <div key={a.id} className={`attach-chip ${a.status}`}>
              <div className="attach-thumb">
                {a.thumb ? (
                  <img src={a.thumb} alt={a.name} />
                ) : (
                  <span className="attach-thumb-fallback">图</span>
                )}
              </div>
              <div className="attach-meta">
                <div className="attach-name" title={a.name}>
                  {a.name}
                </div>
                {a.status === 'uploading' && (
                  <>
                    <div className="attach-progress-bar">
                      <div className="attach-progress-fill" style={{ width: `${a.progress}%` }} />
                    </div>
                    <div className="attach-progress-text">{a.progress}%</div>
                  </>
                )}
                {a.status === 'done' && <div className="attach-status">已上传</div>}
                {a.status === 'error' && (
                  <div className="attach-status err" title={a.error}>
                    失败:{a.error}
                  </div>
                )}
              </div>
              <button
                className="attach-remove"
                onClick={() => (a.status === 'error' ? dismissAttachment(a.id) : removeAttachment(a.id))}
                aria-label="移除"
                title={a.status === 'uploading' ? '取消上传' : '移除'}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-row">
        <button
          className="icon-btn"
          onClick={() => fileRef.current?.click()}
          aria-label="选择图片"
          title="选择图片(也可直接 Ctrl/Cmd+V 粘贴)"
        >
          图片
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
        <textarea
          ref={taRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder="给 Claude Code 发消息…（/命令、@文件、Ctrl+V 粘图、可拖图）"
          onChange={(e) => {
            setText(e.target.value);
            grow();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          className="btn primary send"
          onClick={submit}
          disabled={!canSend}
          title={anyUploading ? '等图片上传完再发' : ''}
        >
          {anyUploading ? '上传中' : '发送'}
        </button>
      </div>
    </div>
  );
}
