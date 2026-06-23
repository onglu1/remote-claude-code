import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 助手消息的 Markdown 渲染：代码块/表格/列表，文字可选可复制。 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
