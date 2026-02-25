import { useState, useCallback, useEffect, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { useProjectContext } from '../hooks/useProjectContext';
import type { ScheduleEntry } from '../types';
import EmptyState from '../components/shared/EmptyState';
import { formatDateOnly } from '../utils/date';

interface FolderNode {
  name: string;
  path: string;
  expanded: boolean;
  children: string[];
  childrenLoaded: boolean;
}

function parseMarkdownLines(content: string) {
  const lines = content.split('\n');
  const result: { type: string; content: string }[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) { result.push({ type: 'code-end', content: '' }); inCodeBlock = false; }
      else { result.push({ type: 'code-start', content: line.trim().slice(3) }); inCodeBlock = true; }
      continue;
    }
    if (inCodeBlock) { result.push({ type: 'code', content: line }); continue; }
    const t = line.trim();
    if (!t) result.push({ type: 'empty', content: '' });
    else if (t.startsWith('#### ')) result.push({ type: 'h4', content: t.slice(5) });
    else if (t.startsWith('### ')) result.push({ type: 'h3', content: t.slice(4) });
    else if (t.startsWith('## ')) result.push({ type: 'h2', content: t.slice(3) });
    else if (t.startsWith('# ')) result.push({ type: 'h1', content: t.slice(2) });
    else if (/^[-*+]\s/.test(t)) result.push({ type: 'list', content: t.slice(2) });
    else if (/^\d+\.\s/.test(t)) result.push({ type: 'list', content: t.replace(/^\d+\.\s/, '') });
    else result.push({ type: 'text', content: t });
  }
  return result;
}

function RenderedMarkdown({ content }: { content: string }) {
  const lines = useMemo(() => parseMarkdownLines(content), [content]);
  const elements: React.ReactNode[] = [];
  let codeLines: string[] = [];
  let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    switch (line.type) {
      case 'h1': elements.push(<h1 key={i} className="text-lg font-bold text-white mt-4 mb-2 first:mt-0">{line.content}</h1>); break;
      case 'h2': elements.push(<h2 key={i} className="text-base font-semibold text-white mt-3 mb-1.5">{line.content}</h2>); break;
      case 'h3': elements.push(<h3 key={i} className="text-sm font-semibold text-surface-200 mt-2 mb-1">{line.content}</h3>); break;
      case 'h4': elements.push(<h4 key={i} className="text-sm font-medium text-surface-300 mt-2 mb-1">{line.content}</h4>); break;
      case 'list': elements.push(<div key={i} className="flex items-start gap-2 ml-2 text-sm text-surface-300"><span className="text-surface-500 flex-shrink-0 mt-0.5">&bull;</span><span>{line.content}</span></div>); break;
      case 'code-start': codeLines = []; codeKey = i; break;
      case 'code': codeLines.push(line.content); break;
      case 'code-end': elements.push(<pre key={codeKey} className="bg-surface-800 border border-surface-700 rounded p-2 my-2 text-xs text-surface-300 overflow-x-auto"><code>{codeLines.join('\n')}</code></pre>); codeLines = []; break;
      case 'empty': elements.push(<div key={i} className="h-2" />); break;
      case 'text': elements.push(<p key={i} className="text-sm text-surface-300 leading-relaxed">{line.content}</p>); break;
    }
  }
  if (codeLines.length > 0) {
    elements.push(<pre key={`uc-${codeKey}`} className="bg-surface-800 border border-surface-700 rounded p-2 my-2 text-xs text-surface-300 overflow-x-auto"><code>{codeLines.join('\n')}</code></pre>);
  }
  return <div>{elements}</div>;
}

function ScheduleTimeline({ schedule }: { schedule: ScheduleEntry[] }) {
  if (schedule.length === 0) return <div className="text-sm text-surface-500 py-2">スケジュール情報が見つかりません</div>;
  return (
    <div className="space-y-1">
      {schedule.map((entry, idx) => (
        <div key={idx} className="flex items-start gap-3 py-1.5">
          <div className="flex flex-col items-center flex-shrink-0">
            <div className={`w-2 h-2 rounded-full mt-1.5 ${entry.status === 'file_activity' ? 'bg-surface-500' : 'bg-blue-500'}`} />
            {idx < schedule.length - 1 && <div className="w-px flex-1 bg-surface-700 mt-0.5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs text-surface-400 mb-0.5">
              {formatDateOnly(entry.date)}
              {entry.status && entry.status !== 'file_activity' && <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-700 text-surface-300">{entry.status}</span>}
              {entry.status === 'file_activity' && <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-800 text-surface-500">ファイル更新</span>}
            </div>
            <div className="text-sm text-surface-300 truncate">{entry.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ProjectView() {
  const { settings } = useAppContext();
  const { context, folders, loading, error, loadContext, listFolders } = useProjectContext();

  const [basePath, setBasePath] = useState(settings.projectFolderPath || '');
  const [pathInput, setPathInput] = useState(settings.projectFolderPath || '');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [treeNodes, setTreeNodes] = useState<Map<string, FolderNode>>(new Map());

  useEffect(() => {
    if (settings.projectFolderPath && settings.projectFolderPath !== basePath) {
      setBasePath(settings.projectFolderPath);
      setPathInput(settings.projectFolderPath);
    }
  }, [settings.projectFolderPath]);

  useEffect(() => {
    if (basePath) listFolders(basePath);
  }, [basePath, listFolders]);

  useEffect(() => {
    if (!basePath || folders.length === 0) return;
    setTreeNodes((prev) => {
      const next = new Map(prev);
      for (const name of folders) {
        const fullPath = basePath.endsWith('/') ? `${basePath}${name}` : `${basePath}/${name}`;
        if (!next.has(fullPath)) {
          next.set(fullPath, { name, path: fullPath, expanded: false, children: [], childrenLoaded: false });
        }
      }
      return next;
    });
  }, [folders, basePath]);

  const handleSetBasePath = useCallback(() => {
    const trimmed = pathInput.trim();
    if (trimmed) { setBasePath(trimmed); setSelectedFolder(null); setTreeNodes(new Map()); }
  }, [pathInput]);

  const handleToggleNode = useCallback(async (nodePath: string) => {
    setTreeNodes((prev) => {
      const next = new Map(prev);
      const node = next.get(nodePath);
      if (!node) return prev;
      next.set(nodePath, { ...node, expanded: !node.expanded });
      if (!node.expanded && !node.childrenLoaded) {
        window.electronAPI.listProjectFolders(nodePath).then((childNames) => {
          setTreeNodes((p) => {
            const n = new Map(p);
            const parent = n.get(nodePath);
            if (!parent) return p;
            const childPaths: string[] = [];
            for (const cn of childNames) {
              const cp = nodePath.endsWith('/') ? `${nodePath}${cn}` : `${nodePath}/${cn}`;
              childPaths.push(cp);
              if (!n.has(cp)) n.set(cp, { name: cn, path: cp, expanded: false, children: [], childrenLoaded: false });
            }
            n.set(nodePath, { ...parent, children: childPaths, childrenLoaded: true, expanded: true });
            return n;
          });
        }).catch(() => {
          setTreeNodes((p) => {
            const n = new Map(p);
            const parent = n.get(nodePath);
            if (!parent) return p;
            n.set(nodePath, { ...parent, children: [], childrenLoaded: true, expanded: true });
            return n;
          });
        });
      }
      return next;
    });
  }, []);

  const handleSelectFolder = useCallback((folderPath: string) => {
    setSelectedFolder(folderPath);
    loadContext(folderPath);
  }, [loadContext]);

  const rootFolderPaths = useMemo(() => {
    if (!basePath) return [];
    return folders.map((name) => basePath.endsWith('/') ? `${basePath}${name}` : `${basePath}/${name}`);
  }, [folders, basePath]);

  const renderTreeNodes = useCallback((paths: string[], depth: number): React.ReactNode => {
    return paths.map((nodePath) => {
      const node = treeNodes.get(nodePath);
      if (!node) return null;
      return (
        <div key={nodePath}>
          <div
            className={`flex items-center gap-1 py-1 px-2 cursor-pointer transition-colors text-sm ${
              selectedFolder === nodePath ? 'bg-blue-500/20 text-blue-400' : 'text-surface-300 hover:bg-surface-800'
            }`}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={() => handleSelectFolder(node.path)}
          >
            <button onClick={(e) => { e.stopPropagation(); handleToggleNode(node.path); }}
              className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-surface-500 hover:text-surface-300">
              {(node.children.length > 0 || !node.childrenLoaded) ? (
                <svg className={`w-3 h-3 transition-transform ${node.expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              ) : <span className="w-3" />}
            </button>
            <svg className={`w-4 h-4 flex-shrink-0 ${node.expanded ? 'text-yellow-500' : 'text-yellow-600'}`} fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
            <span className="truncate">{node.name}</span>
          </div>
          {node.expanded && node.children.length > 0 && renderTreeNodes(node.children, depth + 1)}
        </div>
      );
    });
  }, [treeNodes, selectedFolder, handleToggleNode, handleSelectFolder]);

  return (
    <div className="flex h-full">
      {/* Left: Folder tree */}
      <div className="w-[30%] flex flex-col border-r border-surface-700">
        <div className="p-3 border-b border-surface-700">
          <h2 className="text-base font-semibold mb-2">プロジェクト</h2>
          <div className="flex items-center gap-1.5">
            <input type="text" value={pathInput} onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSetBasePath(); }}
              placeholder="ベースパスを入力..."
              className="flex-1 bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white placeholder-surface-500 focus:outline-none focus:border-blue-500"
            />
            <button onClick={handleSetBasePath} disabled={!pathInput.trim()}
              className="px-2.5 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0">
              読込
            </button>
          </div>
          {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {!basePath ? (
            <EmptyState title="ベースパスを入力してフォルダを表示" />
          ) : loading && folders.length === 0 ? (
            <div className="p-4 space-y-2 animate-pulse">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-2">
                  <div className="w-4 h-4 bg-surface-700 rounded" />
                  <div className="h-4 bg-surface-700 rounded flex-1" />
                </div>
              ))}
            </div>
          ) : rootFolderPaths.length === 0 ? (
            <EmptyState title="フォルダが見つかりません" />
          ) : (
            <div className="py-1">{renderTreeNodes(rootFolderPaths, 0)}</div>
          )}
        </div>
      </div>

      {/* Right: Content */}
      <div className="w-[70%] flex flex-col">
        {!selectedFolder ? (
          <EmptyState
            title="プロジェクトフォルダを選択してください"
            icon={<svg className="w-12 h-12 text-surface-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>}
          />
        ) : loading ? (
          <div className="flex-1 p-4 space-y-4 animate-pulse">
            <div className="h-6 bg-surface-700 rounded w-1/3" />
            <div className="space-y-2">
              <div className="h-4 bg-surface-700 rounded w-full" />
              <div className="h-4 bg-surface-700 rounded w-5/6" />
              <div className="h-4 bg-surface-700 rounded w-3/4" />
            </div>
          </div>
        ) : context ? (
          <div className="flex-1 overflow-y-auto">
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white">{selectedFolder.split('/').filter(Boolean).pop() || selectedFolder}</h3>
              <p className="text-xs text-surface-500 mt-0.5 truncate">{selectedFolder}</p>
              {context.subfolders.length > 0 && <p className="text-xs text-surface-400 mt-1">サブフォルダ: {context.subfolders.length}件</p>}
            </div>
            <div className="p-3 border-b border-surface-700">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider">README</h4>
                {context.readmeContent
                  ? <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">検出済み</span>
                  : <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">未検出</span>}
              </div>
              {context.readmeContent ? (
                <div className="bg-surface-800 rounded border border-surface-700 p-3"><RenderedMarkdown content={context.readmeContent} /></div>
              ) : (
                <div className="bg-surface-800 rounded border border-surface-700 p-3">
                  <p className="text-sm text-yellow-400 mb-2">READMEが見つかりません</p>
                  {context.subfolders.length > 0 && (
                    <div>
                      <p className="text-xs text-surface-400 mb-1">フォルダ内容:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {context.subfolders.map((name) => <span key={name} className="text-xs bg-surface-700 text-surface-300 px-1.5 py-0.5 rounded">{name}/</span>)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-3 border-b border-surface-700">
              <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">スケジュール</h4>
              <ScheduleTimeline schedule={context.schedule} />
            </div>
            <div className="p-3">
              <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">関連 To-Do</h4>
              <div className="text-sm text-surface-500 py-2">プロジェクトに関連するTo-Do項目はTo-Doビューで確認できます</div>
            </div>
          </div>
        ) : (
          <EmptyState title={error || 'プロジェクトコンテキストの読み込みに失敗しました'} />
        )}
      </div>
    </div>
  );
}
