import { useState, useCallback, useEffect, useMemo } from 'react';
import type { AppSettings, ScheduleEntry } from '../types';
import { useProjectContext } from '../hooks/useProjectContext';

interface ProjectViewProps {
  settings: AppSettings;
}

// --- Folder tree node ---

interface FolderNode {
  name: string;
  path: string;
  expanded: boolean;
  children: string[];
  childrenLoaded: boolean;
}

// --- Breadcrumb helpers ---

function pathSegments(folderPath: string): { name: string; path: string }[] {
  const parts = folderPath.split('/').filter(Boolean);
  const segments: { name: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    segments.push({
      name: parts[i],
      path: '/' + parts.slice(0, i + 1).join('/'),
    });
  }
  return segments;
}

// --- Simple markdown renderer ---

interface MarkdownLine {
  type: 'h1' | 'h2' | 'h3' | 'h4' | 'list' | 'code-start' | 'code-end' | 'code' | 'text' | 'empty';
  content: string;
}

function parseMarkdownLines(content: string): MarkdownLine[] {
  const lines = content.split('\n');
  const result: MarkdownLine[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        result.push({ type: 'code-end', content: '' });
        inCodeBlock = false;
      } else {
        result.push({ type: 'code-start', content: line.trim().slice(3) });
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      result.push({ type: 'code', content: line });
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      result.push({ type: 'empty', content: '' });
    } else if (trimmed.startsWith('#### ')) {
      result.push({ type: 'h4', content: trimmed.slice(5) });
    } else if (trimmed.startsWith('### ')) {
      result.push({ type: 'h3', content: trimmed.slice(4) });
    } else if (trimmed.startsWith('## ')) {
      result.push({ type: 'h2', content: trimmed.slice(3) });
    } else if (trimmed.startsWith('# ')) {
      result.push({ type: 'h1', content: trimmed.slice(2) });
    } else if (/^[-*+]\s/.test(trimmed)) {
      result.push({ type: 'list', content: trimmed.slice(2) });
    } else if (/^\d+\.\s/.test(trimmed)) {
      result.push({ type: 'list', content: trimmed.replace(/^\d+\.\s/, '') });
    } else {
      result.push({ type: 'text', content: trimmed });
    }
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
      case 'h1':
        elements.push(
          <h1 key={i} className="text-lg font-bold text-white mt-4 mb-2 first:mt-0">
            {line.content}
          </h1>
        );
        break;
      case 'h2':
        elements.push(
          <h2 key={i} className="text-base font-semibold text-white mt-3 mb-1.5">
            {line.content}
          </h2>
        );
        break;
      case 'h3':
        elements.push(
          <h3 key={i} className="text-sm font-semibold text-surface-200 mt-2 mb-1">
            {line.content}
          </h3>
        );
        break;
      case 'h4':
        elements.push(
          <h4 key={i} className="text-sm font-medium text-surface-300 mt-2 mb-1">
            {line.content}
          </h4>
        );
        break;
      case 'list':
        elements.push(
          <div key={i} className="flex items-start gap-2 ml-2 text-sm text-surface-300">
            <span className="text-surface-500 flex-shrink-0 mt-0.5">•</span>
            <span>{line.content}</span>
          </div>
        );
        break;
      case 'code-start':
        codeLines = [];
        codeKey = i;
        break;
      case 'code':
        codeLines.push(line.content);
        break;
      case 'code-end':
        elements.push(
          <pre
            key={codeKey}
            className="bg-surface-800 border border-surface-700 rounded p-2 my-2 text-xs text-surface-300 overflow-x-auto"
          >
            <code>{codeLines.join('\n')}</code>
          </pre>
        );
        codeLines = [];
        break;
      case 'empty':
        elements.push(<div key={i} className="h-2" />);
        break;
      case 'text':
        elements.push(
          <p key={i} className="text-sm text-surface-300 leading-relaxed">
            {line.content}
          </p>
        );
        break;
    }
  }

  // Handle unclosed code blocks
  if (codeLines.length > 0) {
    elements.push(
      <pre
        key={`code-unclosed-${codeKey}`}
        className="bg-surface-800 border border-surface-700 rounded p-2 my-2 text-xs text-surface-300 overflow-x-auto"
      >
        <code>{codeLines.join('\n')}</code>
      </pre>
    );
  }

  return <div>{elements}</div>;
}

// --- Schedule timeline ---

function formatScheduleDate(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function ScheduleTimeline({ schedule }: { schedule: ScheduleEntry[] }) {
  if (schedule.length === 0) {
    return (
      <div className="text-sm text-surface-500 py-2">
        スケジュール情報が見つかりません
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {schedule.map((entry, idx) => (
        <div key={idx} className="flex items-start gap-3 py-1.5">
          {/* Timeline dot and line */}
          <div className="flex flex-col items-center flex-shrink-0">
            <div
              className={`w-2 h-2 rounded-full mt-1.5 ${
                entry.status === 'file_activity'
                  ? 'bg-surface-500'
                  : 'bg-blue-500'
              }`}
            />
            {idx < schedule.length - 1 && (
              <div className="w-px flex-1 bg-surface-700 mt-0.5" />
            )}
          </div>
          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="text-xs text-surface-400 mb-0.5">
              {formatScheduleDate(entry.date)}
              {entry.status && entry.status !== 'file_activity' && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-700 text-surface-300">
                  {entry.status}
                </span>
              )}
              {entry.status === 'file_activity' && (
                <span className="ml-2 px-1.5 py-0.5 rounded bg-surface-800 text-surface-500">
                  ファイル更新
                </span>
              )}
            </div>
            <div className="text-sm text-surface-300 truncate">
              {entry.description}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// --- Folder tree item ---

function FolderTreeItem({
  node,
  depth,
  isSelected,
  onToggle,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  isSelected: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-1 py-1 px-2 cursor-pointer transition-colors text-sm ${
        isSelected
          ? 'bg-blue-500/20 text-blue-400'
          : 'text-surface-300 hover:bg-surface-800'
      }`}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={() => onSelect(node.path)}
    >
      {/* Expand/collapse arrow */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle(node.path);
        }}
        className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-surface-500 hover:text-surface-300"
      >
        {node.children.length > 0 || !node.childrenLoaded ? (
          <svg
            className={`w-3 h-3 transition-transform ${
              node.expanded ? 'rotate-90' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        ) : (
          <span className="w-3" />
        )}
      </button>

      {/* Folder icon */}
      <svg
        className={`w-4 h-4 flex-shrink-0 ${
          node.expanded ? 'text-yellow-500' : 'text-yellow-600'
        }`}
        fill="currentColor"
        viewBox="0 0 20 20"
      >
        {node.expanded ? (
          <path
            fillRule="evenodd"
            d="M2 6a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1H8a3 3 0 00-3 3v1.5a1.5 1.5 0 01-3 0V6z"
            clipRule="evenodd"
          />
        ) : (
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
        )}
      </svg>

      {/* Name */}
      <span className="truncate">{node.name}</span>
    </div>
  );
}

// --- Main Component ---

export default function ProjectView({ settings }: ProjectViewProps) {
  const { context, folders, loading, error, loadContext, listFolders } =
    useProjectContext();

  const [basePath, setBasePath] = useState(settings.projectFolderPath || '');
  const [pathInput, setPathInput] = useState(settings.projectFolderPath || '');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [treeNodes, setTreeNodes] = useState<Map<string, FolderNode>>(new Map());

  // Sync basePath when settings change
  useEffect(() => {
    if (settings.projectFolderPath && settings.projectFolderPath !== basePath) {
      setBasePath(settings.projectFolderPath);
      setPathInput(settings.projectFolderPath);
    }
    // Only react to settings changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.projectFolderPath]);

  // Load folder list when basePath changes
  useEffect(() => {
    if (basePath) {
      listFolders(basePath);
    }
  }, [basePath, listFolders]);

  // Build tree nodes from folders list
  useEffect(() => {
    if (!basePath || folders.length === 0) return;

    setTreeNodes((prev) => {
      const next = new Map(prev);
      for (const name of folders) {
        const fullPath = basePath.endsWith('/')
          ? `${basePath}${name}`
          : `${basePath}/${name}`;
        if (!next.has(fullPath)) {
          next.set(fullPath, {
            name,
            path: fullPath,
            expanded: false,
            children: [],
            childrenLoaded: false,
          });
        }
      }
      return next;
    });
  }, [folders, basePath]);

  const handleSetBasePath = useCallback(() => {
    const trimmed = pathInput.trim();
    if (trimmed) {
      setBasePath(trimmed);
      setSelectedFolder(null);
      setTreeNodes(new Map());
    }
  }, [pathInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSetBasePath();
      }
    },
    [handleSetBasePath]
  );

  const handleToggleNode = useCallback(
    async (nodePath: string) => {
      setTreeNodes((prev) => {
        const next = new Map(prev);
        const node = next.get(nodePath);
        if (!node) return prev;

        next.set(nodePath, { ...node, expanded: !node.expanded });

        // If expanding and children not loaded, trigger load
        if (!node.expanded && !node.childrenLoaded) {
          // Load children asynchronously
          window.electronAPI
            .listProjectFolders(nodePath)
            .then((childNames) => {
              setTreeNodes((prevInner) => {
                const innerNext = new Map(prevInner);
                const parentNode = innerNext.get(nodePath);
                if (!parentNode) return prevInner;

                const childPaths: string[] = [];
                for (const childName of childNames) {
                  const childPath = nodePath.endsWith('/')
                    ? `${nodePath}${childName}`
                    : `${nodePath}/${childName}`;
                  childPaths.push(childPath);
                  if (!innerNext.has(childPath)) {
                    innerNext.set(childPath, {
                      name: childName,
                      path: childPath,
                      expanded: false,
                      children: [],
                      childrenLoaded: false,
                    });
                  }
                }

                innerNext.set(nodePath, {
                  ...parentNode,
                  children: childPaths,
                  childrenLoaded: true,
                  expanded: true,
                });

                return innerNext;
              });
            })
            .catch(() => {
              // Mark as loaded with no children on error
              setTreeNodes((prevInner) => {
                const innerNext = new Map(prevInner);
                const parentNode = innerNext.get(nodePath);
                if (!parentNode) return prevInner;
                innerNext.set(nodePath, {
                  ...parentNode,
                  children: [],
                  childrenLoaded: true,
                  expanded: true,
                });
                return innerNext;
              });
            });
        }

        return next;
      });
    },
    []
  );

  const handleSelectFolder = useCallback(
    (folderPath: string) => {
      setSelectedFolder(folderPath);
      loadContext(folderPath);
    },
    [loadContext]
  );

  const handleBreadcrumbNavigate = useCallback(
    (targetPath: string) => {
      setBasePath(targetPath);
      setPathInput(targetPath);
      setSelectedFolder(null);
      setTreeNodes(new Map());
    },
    []
  );

  // Compute root-level folder paths for tree rendering
  const rootFolderPaths = useMemo(() => {
    if (!basePath) return [];
    return folders.map((name) =>
      basePath.endsWith('/') ? `${basePath}${name}` : `${basePath}/${name}`
    );
  }, [folders, basePath]);

  // Recursive tree renderer
  const renderTreeNodes = useCallback(
    (paths: string[], depth: number): React.ReactNode => {
      return paths.map((nodePath) => {
        const node = treeNodes.get(nodePath);
        if (!node) return null;

        return (
          <div key={nodePath}>
            <FolderTreeItem
              node={node}
              depth={depth}
              isSelected={selectedFolder === nodePath}
              onToggle={handleToggleNode}
              onSelect={handleSelectFolder}
            />
            {node.expanded &&
              node.children.length > 0 &&
              renderTreeNodes(node.children, depth + 1)}
          </div>
        );
      });
    },
    [treeNodes, selectedFolder, handleToggleNode, handleSelectFolder]
  );

  // Breadcrumb segments for the base path
  const breadcrumbs = useMemo(
    () => (basePath ? pathSegments(basePath) : []),
    [basePath]
  );

  return (
    <div className="flex h-full">
      {/* Left pane: Folder tree (30%) */}
      <div className="w-[30%] flex flex-col border-r border-surface-700">
        {/* Header */}
        <div className="p-3 border-b border-surface-700">
          <h2 className="text-base font-semibold mb-2">プロジェクト</h2>

          {/* Path input */}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="ベースパスを入力..."
              className="flex-1 bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white placeholder-surface-500 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSetBasePath}
              disabled={!pathInput.trim()}
              className="px-2.5 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            >
              フォルダ選択
            </button>
          </div>

          {/* Breadcrumb navigation */}
          {breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1 mt-2 text-xs text-surface-400 overflow-x-auto">
              {breadcrumbs.map((seg, idx) => {
                const isLast = idx === breadcrumbs.length - 1;
                // Only show last 3 segments to avoid overflow
                if (idx < breadcrumbs.length - 3) {
                  if (idx === 0) {
                    return (
                      <span key={seg.path} className="flex items-center gap-1">
                        <button
                          onClick={() => handleBreadcrumbNavigate(seg.path)}
                          className="hover:text-blue-400 transition-colors"
                          title={seg.path}
                        >
                          ...
                        </button>
                        <span className="text-surface-600">/</span>
                      </span>
                    );
                  }
                  return null;
                }
                return (
                  <span key={seg.path} className="flex items-center gap-1">
                    {isLast ? (
                      <span className="text-surface-300 font-medium truncate max-w-[120px]">
                        {seg.name}
                      </span>
                    ) : (
                      <>
                        <button
                          onClick={() => handleBreadcrumbNavigate(seg.path)}
                          className="hover:text-blue-400 transition-colors truncate max-w-[100px]"
                          title={seg.path}
                        >
                          {seg.name}
                        </button>
                        <span className="text-surface-600">/</span>
                      </>
                    )}
                  </span>
                );
              })}
            </div>
          )}

          {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        </div>

        {/* Folder tree */}
        <div className="flex-1 overflow-y-auto">
          {!basePath ? (
            <div className="p-4 text-surface-500 text-center text-sm">
              ベースパスを入力してフォルダを表示
            </div>
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
            <div className="p-4 text-surface-500 text-center text-sm">
              フォルダが見つかりません
            </div>
          ) : (
            <div className="py-1">{renderTreeNodes(rootFolderPaths, 0)}</div>
          )}
        </div>
      </div>

      {/* Right pane: Content (70%) */}
      <div className="w-[70%] flex flex-col">
        {!selectedFolder ? (
          /* Placeholder state */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <svg
                className="w-12 h-12 text-surface-600 mx-auto mb-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <p className="text-surface-400 text-sm">
                プロジェクトフォルダを選択してください
              </p>
            </div>
          </div>
        ) : loading ? (
          /* Loading state */
          <div className="flex-1 p-4 space-y-4 animate-pulse">
            <div className="h-6 bg-surface-700 rounded w-1/3" />
            <div className="space-y-2">
              <div className="h-4 bg-surface-700 rounded w-full" />
              <div className="h-4 bg-surface-700 rounded w-5/6" />
              <div className="h-4 bg-surface-700 rounded w-3/4" />
            </div>
            <div className="h-6 bg-surface-700 rounded w-1/4 mt-6" />
            <div className="space-y-2">
              <div className="h-4 bg-surface-700 rounded w-2/3" />
              <div className="h-4 bg-surface-700 rounded w-1/2" />
            </div>
          </div>
        ) : context ? (
          /* Content view */
          <div className="flex-1 overflow-y-auto">
            {/* Header */}
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white">
                {selectedFolder.split('/').filter(Boolean).pop() || selectedFolder}
              </h3>
              <p className="text-xs text-surface-500 mt-0.5 truncate">
                {selectedFolder}
              </p>
              {context.subfolders.length > 0 && (
                <p className="text-xs text-surface-400 mt-1">
                  サブフォルダ: {context.subfolders.length}件
                </p>
              )}
            </div>

            {/* README content */}
            <div className="p-3 border-b border-surface-700">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider">
                  README
                </h4>
                {context.readmeContent ? (
                  <span className="text-xs bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">
                    検出済み
                  </span>
                ) : (
                  <span className="text-xs bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded">
                    未検出
                  </span>
                )}
              </div>

              {context.readmeContent ? (
                <div className="bg-surface-800 rounded border border-surface-700 p-3">
                  <RenderedMarkdown content={context.readmeContent} />
                </div>
              ) : (
                <div className="bg-surface-800 rounded border border-surface-700 p-3">
                  <p className="text-sm text-yellow-400 mb-2">
                    READMEが見つかりません
                  </p>
                  {context.subfolders.length > 0 && (
                    <div>
                      <p className="text-xs text-surface-400 mb-1">
                        フォルダ内容:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {context.subfolders.map((name) => (
                          <span
                            key={name}
                            className="text-xs bg-surface-700 text-surface-300 px-1.5 py-0.5 rounded"
                          >
                            {name}/
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Schedule timeline */}
            <div className="p-3 border-b border-surface-700">
              <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                スケジュール
              </h4>
              <ScheduleTimeline schedule={context.schedule} />
            </div>

            {/* To-Do mapping (placeholder for future integration) */}
            <div className="p-3">
              <h4 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">
                関連 To-Do
              </h4>
              <div className="text-sm text-surface-500 py-2">
                プロジェクトに関連するTo-Do項目はTo-Doビューで確認できます
              </div>
            </div>
          </div>
        ) : (
          /* Error or empty state */
          <div className="flex-1 flex items-center justify-center">
            <p className="text-surface-500 text-sm">
              {error || 'プロジェクトコンテキストの読み込みに失敗しました'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
