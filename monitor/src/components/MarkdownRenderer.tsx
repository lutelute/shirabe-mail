import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface Props {
  children: string;
  /** Compact mode for sidebar panels (smaller text/spacing) */
  compact?: boolean;
}

const compactComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-sm font-bold text-surface-100 border-b border-surface-700 pb-1.5 mb-3 mt-1">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[13px] font-semibold text-accent-400 mt-4 mb-2 flex items-center gap-1.5">
      <span className="w-1 h-4 bg-accent-500 rounded-full inline-block flex-shrink-0" />
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-xs font-semibold text-surface-200 mt-3 mb-1.5">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-[13px] text-surface-300 leading-relaxed mb-2">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="space-y-1 my-2 pl-0 list-none">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="space-y-1 my-2 pl-4 list-decimal marker:text-surface-500">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="text-[13px] text-surface-300 leading-relaxed">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="text-surface-100 font-semibold">{children}</strong>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-accent-400 hover:text-accent-300 underline underline-offset-2" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className={`block bg-surface-800 border border-surface-700 rounded p-2 text-xs text-accent-300 font-mono overflow-x-auto my-2 ${className || ''}`}>
          {children}
        </code>
      );
    }
    return (
      <code className="text-accent-300 bg-surface-800 px-1 py-0.5 rounded text-xs font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-surface-800 border border-surface-700 rounded-md p-2.5 overflow-x-auto my-2 text-xs">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="w-full text-xs border-collapse">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-800 text-surface-200">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 text-left text-[11px] font-semibold border border-surface-700 text-surface-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2.5 py-1.5 text-[11px] border border-surface-700 text-surface-400">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent-500/50 pl-3 my-2 text-surface-400 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-surface-700 my-3" />,
  input: (props) => {
    if (props.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={props.checked}
          readOnly
          className="mr-1.5 accent-accent-400 align-middle"
        />
      );
    }
    return <input {...props} />;
  },
};

const fullComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-surface-100 border-b border-surface-600 pb-2 mb-4 mt-2">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold text-accent-400 mt-6 mb-3 flex items-center gap-2">
      <span className="w-1 h-5 bg-accent-500 rounded-full inline-block flex-shrink-0" />
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-surface-200 mt-4 mb-2">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm text-surface-300 leading-relaxed mb-3">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="space-y-1.5 my-2 pl-0 list-none">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="space-y-1.5 my-2 pl-5 list-decimal marker:text-surface-500">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="text-sm text-surface-300 leading-relaxed">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="text-surface-100 font-semibold">{children}</strong>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-accent-400 hover:text-accent-300 underline underline-offset-2" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className={`block bg-surface-800 border border-surface-700 rounded p-3 text-xs text-accent-300 font-mono overflow-x-auto my-3 ${className || ''}`}>
          {children}
        </code>
      );
    }
    return (
      <code className="text-accent-300 bg-surface-800 px-1.5 py-0.5 rounded text-xs font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-surface-800 border border-surface-700 rounded-md p-3 overflow-x-auto my-3">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-4 rounded border border-surface-700">
      <table className="w-full text-sm border-collapse">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface-800 text-surface-200">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-xs font-semibold border-b border-surface-700 text-surface-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 text-sm border-b border-surface-800 text-surface-400">
      {children}
    </td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-3 border-accent-500/50 pl-4 my-3 text-surface-400 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-surface-700 my-4" />,
  input: (props) => {
    if (props.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={props.checked}
          readOnly
          className="mr-2 accent-accent-400 align-middle scale-110"
        />
      );
    }
    return <input {...props} />;
  },
};

export default function MarkdownRenderer({ children, compact = false }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={compact ? compactComponents : fullComponents}
    >
      {children}
    </ReactMarkdown>
  );
}
