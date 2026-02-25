import { useState, useCallback, useMemo } from 'react';
import type {
  MailItem,
  TaskItem,
  ActionItem,
  AccountConfig,
  AppSettings,
  TodoItem,
  ThreadMessage,
} from '../types';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import ThreadViewer from './ThreadViewer';

interface TodoViewProps {
  mails: MailItem[];
  tasks: TaskItem[];
  actions: ActionItem[];
  accounts: AccountConfig[];
  settings: AppSettings;
}

type GroupBy = 'priority' | 'deadline';
type FilterMode = 'mine' | 'all';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function formatDeadline(date: Date): string {
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function getDeadlineGroup(deadline: Date | null): string {
  if (!deadline) return '期限なし';
  const d = new Date(deadline);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return '期限超過';
  if (diffDays === 0) return '今日';
  if (diffDays <= 7) return '今週中';
  return '来週以降';
}

function getPriorityLabel(priority: string): string {
  switch (priority) {
    case 'high':
      return '高';
    case 'medium':
      return '中';
    case 'low':
      return '低';
    default:
      return priority;
  }
}

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="p-3 bg-surface-800 rounded space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-4 bg-surface-700 rounded w-4" />
            <div className="h-4 bg-surface-700 rounded w-3/4" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 bg-surface-700 rounded w-16" />
            <div className="h-3 bg-surface-700 rounded w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function TodoView({
  mails,
  tasks: _tasks,
  actions: _actions,
  accounts: _accounts,
  settings,
}: TodoViewProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>('priority');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const { loading, error, extractTodos } = useClaudeAgent(settings.apiKey);

  const isAgentAvailable = settings.agentEnabled && !!settings.apiKey;

  const handleExtractTodos = useCallback(async () => {
    if (!isAgentAvailable || mails.length === 0) return;
    // Gather thread messages from all mails
    const allMessages: ThreadMessage[] = [];
    for (const mail of mails) {
      try {
        const messages = await window.electronAPI.getThreadMessages(
          mail.id,
          mail.accountEmail,
        );
        allMessages.push(...messages);
      } catch {
        // Skip mails where thread loading fails
      }
    }
    if (allMessages.length === 0) return;
    const extracted = await extractTodos(allMessages);
    setTodos(extracted);
  }, [mails, extractTodos, isAgentAvailable]);

  const toggleCompleted = useCallback((id: string) => {
    setCompletedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const isItemCompleted = useCallback(
    (item: TodoItem) => item.isCompleted || completedIds.has(item.id),
    [completedIds],
  );

  const handleSelectTodo = useCallback(
    async (todo: TodoItem) => {
      setSelectedTodo(todo);
      setThreadLoading(true);
      try {
        const messages = await window.electronAPI.getThreadMessages(
          todo.sourceMailId,
          todo.accountEmail,
        );
        setThreadMessages(messages);
      } catch {
        setThreadMessages([]);
      } finally {
        setThreadLoading(false);
      }
    },
    [],
  );

  const filtered = useMemo(() => {
    let items = todos;

    // Filter by assignment
    if (filterMode === 'mine') {
      items = items.filter((t) => t.assignedToMe);
    }

    // Filter completed
    if (!showCompleted) {
      items = items.filter((t) => !isItemCompleted(t));
    }

    return items;
  }, [todos, filterMode, showCompleted, isItemCompleted]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (groupBy === 'priority') {
          const pa = PRIORITY_ORDER[a.priority] ?? 2;
          const pb = PRIORITY_ORDER[b.priority] ?? 2;
          if (pa !== pb) return pa - pb;
          // Secondary sort by deadline
          const aDeadline = a.deadline
            ? new Date(a.deadline).getTime()
            : Infinity;
          const bDeadline = b.deadline
            ? new Date(b.deadline).getTime()
            : Infinity;
          return aDeadline - bDeadline;
        }
        // Group by deadline
        const aDeadline = a.deadline
          ? new Date(a.deadline).getTime()
          : Infinity;
        const bDeadline = b.deadline
          ? new Date(b.deadline).getTime()
          : Infinity;
        if (aDeadline !== bDeadline) return aDeadline - bDeadline;
        return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
      }),
    [filtered, groupBy],
  );

  const grouped = useMemo(() => {
    const groups: Map<string, TodoItem[]> = new Map();
    for (const item of sorted) {
      const key =
        groupBy === 'priority'
          ? getPriorityLabel(item.priority)
          : getDeadlineGroup(item.deadline);
      const existing = groups.get(key) ?? [];
      existing.push(item);
      groups.set(key, existing);
    }
    return groups;
  }, [sorted, groupBy]);

  const activeCount = todos.filter((t) => !isItemCompleted(t)).length;

  return (
    <div className="flex h-full">
      {/* Left column: Task list (50%) */}
      <div className="w-1/2 flex flex-col border-r border-surface-700">
        {/* Header */}
        <div className="p-3 border-b border-surface-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">To-Do</h2>
              {todos.length > 0 && (
                <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full">
                  {activeCount}
                </span>
              )}
            </div>
            <button
              onClick={handleExtractTodos}
              disabled={loading || mails.length === 0 || !isAgentAvailable}
              className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '抽出中...' : 'スレッドから抽出'}
            </button>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 text-xs">
            {/* Group toggle */}
            <div className="flex items-center gap-1">
              <span className="text-surface-400">グループ:</span>
              <button
                onClick={() => setGroupBy('priority')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  groupBy === 'priority'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-surface-400 hover:text-surface-300'
                }`}
              >
                優先度
              </button>
              <button
                onClick={() => setGroupBy('deadline')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  groupBy === 'deadline'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-surface-400 hover:text-surface-300'
                }`}
              >
                期限
              </button>
            </div>

            {/* Filter toggle */}
            <div className="flex items-center gap-1">
              <span className="text-surface-400">表示:</span>
              <button
                onClick={() => setFilterMode('all')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  filterMode === 'all'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-surface-400 hover:text-surface-300'
                }`}
              >
                すべて
              </button>
              <button
                onClick={() => setFilterMode('mine')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  filterMode === 'mine'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-surface-400 hover:text-surface-300'
                }`}
              >
                自分のみ
              </button>
            </div>
          </div>

          {/* Show completed toggle */}
          <label className="flex items-center gap-1.5 mt-2 text-xs text-surface-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
            />
            完了済みを表示
          </label>

          {!isAgentAvailable && (
            <p className="text-xs text-surface-500 mt-1">
              AI Agent未設定: 設定でAPI KeyとAgentを有効にしてください
            </p>
          )}

          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>

        {/* Task list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <LoadingSkeleton />
          ) : sorted.length === 0 ? (
            <div className="p-4 text-surface-400 text-center text-sm">
              {todos.length === 0
                ? 'To-Do項目はありません。「スレッドから抽出」で取得してください。'
                : 'フィルタに該当するTo-Do項目はありません'}
            </div>
          ) : (
            <div>
              {Array.from(grouped.entries()).map(([groupLabel, items]) => (
                <div key={groupLabel}>
                  {/* Group header */}
                  <div className="px-3 py-1.5 bg-surface-800 border-b border-surface-700 sticky top-0 z-10">
                    <span className="text-xs font-medium text-surface-300">
                      {groupLabel}
                    </span>
                    <span className="text-xs text-surface-500 ml-1.5">
                      ({items.length})
                    </span>
                  </div>

                  {/* Items */}
                  {items.map((todo) => {
                    const completed = isItemCompleted(todo);
                    const isSelected = selectedTodo?.id === todo.id;
                    return (
                      <div
                        key={todo.id}
                        onClick={() => handleSelectTodo(todo)}
                        className={`px-3 py-2 border-b border-surface-700 cursor-pointer transition-colors ${
                          completed ? 'opacity-50' : ''
                        } ${
                          isSelected
                            ? 'bg-surface-700'
                            : 'hover:bg-surface-800'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          {/* Completion toggle */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCompleted(todo.id);
                            }}
                            className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                              completed
                                ? 'bg-blue-500 border-blue-500'
                                : 'border-surface-500 hover:border-surface-400'
                            }`}
                          >
                            {completed && (
                              <svg
                                className="w-3 h-3 text-white"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={3}
                                  d="M5 13l4 4L19 7"
                                />
                              </svg>
                            )}
                          </button>

                          <div className="flex-1 min-w-0">
                            {/* Priority dot + action text */}
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span
                                className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                                  todo.priority === 'high'
                                    ? 'bg-red-500'
                                    : todo.priority === 'medium'
                                    ? 'bg-yellow-500'
                                    : 'bg-green-500'
                                }`}
                              />
                              <span
                                className={`text-sm ${
                                  completed
                                    ? 'line-through text-surface-500'
                                    : 'text-white'
                                }`}
                              >
                                {todo.action}
                              </span>
                            </div>

                            {/* Metadata row */}
                            <div className="flex items-center gap-2 text-xs text-surface-400">
                              {todo.deadline && (
                                <span>{formatDeadline(todo.deadline)}</span>
                              )}
                              {todo.category && (
                                <span className="bg-surface-700 px-1.5 py-0.5 rounded">
                                  {todo.category}
                                </span>
                              )}
                              {todo.assignedToMe && (
                                <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-medium">
                                  自分
                                </span>
                              )}
                              <span className="text-surface-500 truncate">
                                Thread #{todo.sourceThreadId}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right column: ThreadViewer (50%) */}
      <div className="w-1/2 flex flex-col">
        {selectedTodo ? (
          <ThreadViewer
            messages={threadMessages}
            loading={threadLoading}
            onClose={() => {
              setSelectedTodo(null);
              setThreadMessages([]);
            }}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-surface-500 text-sm">
              To-Doを選択してスレッドを表示
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
