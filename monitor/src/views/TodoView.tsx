import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { useMailData } from '../hooks/useMailData';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import type { TodoItem, ThreadMessage } from '../types';
import ThreadViewer from '../components/ThreadViewer';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';
import { formatDeadline, getRelativeDateLabel } from '../utils/date';

type GroupBy = 'priority' | 'deadline';
type FilterMode = 'mine' | 'all';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function getPriorityLabel(priority: string): string {
  switch (priority) {
    case 'high': return '高';
    case 'medium': return '中';
    case 'low': return '低';
    default: return priority;
  }
}

export default function TodoView() {
  const { selectedAccounts, settings, settingsLoaded } = useAppContext();
  const { mails, fetchMails } = useMailData();
  const { loading, error, extractTodos } = useClaudeAgent(settings.apiKey);

  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<GroupBy>('priority');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [showCompleted, setShowCompleted] = useState(false);
  const [selectedTodo, setSelectedTodo] = useState<TodoItem | null>(null);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('');
  const [showAddForm, setShowAddForm] = useState(false);

  // Manual add form state
  const [newAction, setNewAction] = useState('');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [newDeadline, setNewDeadline] = useState('');

  const isAgentAvailable = settings.agentEnabled && !!settings.apiKey;
  const loadedRef = useRef(false);

  // Set initial active tab
  useEffect(() => {
    if (selectedAccounts.length > 0 && !activeTab) {
      setActiveTab(selectedAccounts[0].email);
    }
  }, [selectedAccounts, activeTab]);

  // Load persisted todos when tab changes
  useEffect(() => {
    if (!activeTab) return;
    (async () => {
      try {
        const loaded = await window.electronAPI.loadTodos(activeTab);
        setTodos(loaded);
        setCompletedIds(new Set(loaded.filter((t) => t.isCompleted).map((t) => t.id)));
        loadedRef.current = true;
      } catch {
        setTodos([]);
      }
    })();
  }, [activeTab]);

  // Fetch mails for thread extraction
  useEffect(() => {
    if (settingsLoaded && selectedAccounts.length > 0) {
      fetchMails(selectedAccounts.map((a) => a.email), settings.mailDaysBack, settings.excludeSpam);
    }
  }, [settingsLoaded, selectedAccounts, settings.mailDaysBack, settings.excludeSpam, fetchMails]);

  const persistTodo = useCallback(async (todo: TodoItem) => {
    await window.electronAPI.saveTodo(todo);
  }, []);

  const handleExtractTodos = useCallback(async () => {
    if (!isAgentAvailable || mails.length === 0 || !activeTab) return;
    const accountMails = mails.filter((m) => m.accountEmail === activeTab);
    const allMessages: ThreadMessage[] = [];
    for (const mail of accountMails.slice(0, 20)) {
      try {
        const messages = await window.electronAPI.getThreadMessages(mail.id, mail.accountEmail);
        allMessages.push(...messages);
      } catch { /* skip */ }
    }
    if (allMessages.length === 0) return;
    const extracted = await extractTodos(allMessages);
    const now = new Date();
    const withMeta: TodoItem[] = extracted.map((t) => ({
      ...t,
      accountEmail: activeTab,
      createdAt: now,
      updatedAt: now,
      source: 'thread' as const,
    }));
    // Merge: keep existing, add new by id
    const existingIds = new Set(todos.map((t) => t.id));
    const newOnes = withMeta.filter((t) => !existingIds.has(t.id));
    const merged = [...todos, ...newOnes];
    setTodos(merged);
    // Persist all new ones
    for (const t of newOnes) {
      await persistTodo(t);
    }
  }, [mails, extractTodos, isAgentAvailable, activeTab, todos, persistTodo]);

  const handleAddManual = useCallback(async () => {
    if (!newAction.trim() || !activeTab) return;
    const now = new Date();
    const todo: TodoItem = {
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action: newAction.trim(),
      priority: newPriority,
      deadline: newDeadline ? new Date(newDeadline) : null,
      sourceThreadId: 0,
      sourceMailId: 0,
      assignedToMe: true,
      category: '',
      isCompleted: false,
      accountEmail: activeTab,
      createdAt: now,
      updatedAt: now,
      source: 'manual',
    };
    const updated = [...todos, todo];
    setTodos(updated);
    await persistTodo(todo);
    setNewAction('');
    setNewDeadline('');
    setShowAddForm(false);
  }, [newAction, newPriority, newDeadline, activeTab, todos, persistTodo]);

  const toggleCompleted = useCallback(async (id: string) => {
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    const nowCompleted = !todo.isCompleted && !completedIds.has(id);
    const updated: TodoItem = {
      ...todo,
      isCompleted: nowCompleted,
      updatedAt: new Date(),
    };
    setTodos((prev) => prev.map((t) => (t.id === id ? updated : t)));
    setCompletedIds((prev) => {
      const next = new Set(prev);
      if (nowCompleted) next.add(id);
      else next.delete(id);
      return next;
    });
    await window.electronAPI.updateTodo(updated);
  }, [todos, completedIds]);

  const handleDeleteTodo = useCallback(async (id: string) => {
    if (!activeTab) return;
    setTodos((prev) => prev.filter((t) => t.id !== id));
    await window.electronAPI.deleteTodo(id, activeTab);
  }, [activeTab]);

  const isItemCompleted = useCallback(
    (item: TodoItem) => item.isCompleted || completedIds.has(item.id),
    [completedIds],
  );

  const handleSelectTodo = useCallback(async (todo: TodoItem) => {
    setSelectedTodo(todo);
    if (todo.sourceMailId === 0) {
      setThreadMessages([]);
      return;
    }
    setThreadLoading(true);
    try {
      const messages = await window.electronAPI.getThreadMessages(todo.sourceMailId, todo.accountEmail);
      setThreadMessages(messages);
    } catch {
      setThreadMessages([]);
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const filtered = useMemo(() => {
    let items = todos;
    if (filterMode === 'mine') items = items.filter((t) => t.assignedToMe);
    if (!showCompleted) items = items.filter((t) => !isItemCompleted(t));
    return items;
  }, [todos, filterMode, showCompleted, isItemCompleted]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (groupBy === 'priority') {
          const pa = PRIORITY_ORDER[a.priority] ?? 2;
          const pb = PRIORITY_ORDER[b.priority] ?? 2;
          if (pa !== pb) return pa - pb;
          const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity;
          const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
          return ad - bd;
        }
        const ad = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const bd = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (ad !== bd) return ad - bd;
        return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
      }),
    [filtered, groupBy],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, TodoItem[]>();
    for (const item of sorted) {
      const key = groupBy === 'priority'
        ? getPriorityLabel(item.priority)
        : getRelativeDateLabel(item.deadline);
      const existing = groups.get(key) ?? [];
      existing.push(item);
      groups.set(key, existing);
    }
    return groups;
  }, [sorted, groupBy]);

  const activeCount = todos.filter((t) => !isItemCompleted(t)).length;

  return (
    <div className="flex h-full">
      {/* Left: Task list */}
      <div className="w-1/2 flex flex-col border-r border-surface-700">
        <div className="p-3 border-b border-surface-700">
          {/* Account tabs */}
          {selectedAccounts.length > 1 && (
            <div className="flex gap-1 mb-2 overflow-x-auto">
              {selectedAccounts.map((acc) => (
                <button
                  key={acc.email}
                  onClick={() => setActiveTab(acc.email)}
                  className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                    activeTab === acc.email
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'text-surface-400 hover:text-surface-300 hover:bg-surface-800'
                  }`}
                >
                  {acc.label || acc.email}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">To-Do</h2>
              {todos.length > 0 && (
                <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full">{activeCount}</span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowAddForm((v) => !v)}
                className="px-2 py-1 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded transition-colors"
                title="手動で追加"
              >
                +
              </button>
              <button
                onClick={handleExtractTodos}
                disabled={loading || mails.length === 0 || !isAgentAvailable}
                className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '抽出中...' : 'スレッドから抽出'}
              </button>
            </div>
          </div>

          {/* Manual add form */}
          {showAddForm && (
            <div className="mb-2 p-2 bg-surface-800 rounded border border-surface-700">
              <input
                type="text"
                value={newAction}
                onChange={(e) => setNewAction(e.target.value)}
                placeholder="やること..."
                className="w-full px-2 py-1 text-sm bg-surface-900 border border-surface-600 rounded text-white placeholder-surface-500 focus:outline-none focus:border-blue-500 mb-1.5"
                onKeyDown={(e) => e.key === 'Enter' && handleAddManual()}
              />
              <div className="flex items-center gap-2">
                <select
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value as 'high' | 'medium' | 'low')}
                  className="px-2 py-1 text-xs bg-surface-900 border border-surface-600 rounded text-white focus:outline-none"
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="low">低</option>
                </select>
                <input
                  type="date"
                  value={newDeadline}
                  onChange={(e) => setNewDeadline(e.target.value)}
                  className="px-2 py-1 text-xs bg-surface-900 border border-surface-600 rounded text-white focus:outline-none"
                />
                <button
                  onClick={handleAddManual}
                  disabled={!newAction.trim()}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                >
                  追加
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 text-xs">
            <div className="flex items-center gap-1">
              <span className="text-surface-400">グループ:</span>
              <button onClick={() => setGroupBy('priority')}
                className={`px-1.5 py-0.5 rounded ${groupBy === 'priority' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}>
                優先度
              </button>
              <button onClick={() => setGroupBy('deadline')}
                className={`px-1.5 py-0.5 rounded ${groupBy === 'deadline' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}>
                期限
              </button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-surface-400">表示:</span>
              <button onClick={() => setFilterMode('all')}
                className={`px-1.5 py-0.5 rounded ${filterMode === 'all' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}>
                すべて
              </button>
              <button onClick={() => setFilterMode('mine')}
                className={`px-1.5 py-0.5 rounded ${filterMode === 'mine' ? 'bg-blue-500/20 text-blue-400' : 'text-surface-400 hover:text-surface-300'}`}>
                自分のみ
              </button>
            </div>
          </div>

          <label className="flex items-center gap-1.5 mt-2 text-xs text-surface-400 cursor-pointer">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
            完了済みを表示
          </label>

          {!isAgentAvailable && (
            <p className="text-xs text-surface-500 mt-1">AI Agent未設定: 設定でAPI KeyとAgentを有効にしてください</p>
          )}
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <LoadingSkeleton rows={4} variant="card" />
          ) : sorted.length === 0 ? (
            <EmptyState title={todos.length === 0 ? 'To-Do項目はありません。「+」で追加するか「スレッドから抽出」で取得してください。' : 'フィルタに該当するTo-Do項目はありません'} />
          ) : (
            Array.from(grouped.entries()).map(([groupLabel, items]) => (
              <div key={groupLabel}>
                <div className="px-3 py-1.5 bg-surface-800 border-b border-surface-700 sticky top-0 z-10">
                  <span className="text-xs font-medium text-surface-300">{groupLabel}</span>
                  <span className="text-xs text-surface-500 ml-1.5">({items.length})</span>
                </div>
                {items.map((todo) => {
                  const completed = isItemCompleted(todo);
                  const isSelected = selectedTodo?.id === todo.id;
                  return (
                    <div
                      key={todo.id}
                      onClick={() => handleSelectTodo(todo)}
                      className={`px-3 py-2 border-b border-surface-700 cursor-pointer transition-colors ${
                        completed ? 'opacity-50' : ''
                      } ${isSelected ? 'bg-surface-700' : 'hover:bg-surface-800'}`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleCompleted(todo.id); }}
                          className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                            completed ? 'bg-blue-500 border-blue-500' : 'border-surface-500 hover:border-surface-400'
                          }`}
                        >
                          {completed && (
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                              todo.priority === 'high' ? 'bg-red-500' : todo.priority === 'medium' ? 'bg-yellow-500' : 'bg-green-500'
                            }`} />
                            <span className={`text-sm ${completed ? 'line-through text-surface-500' : 'text-white'}`}>
                              {todo.action}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-surface-400">
                            {todo.deadline && <span>{formatDeadline(todo.deadline)}</span>}
                            {todo.category && <span className="bg-surface-700 px-1.5 py-0.5 rounded">{todo.category}</span>}
                            {todo.assignedToMe && <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-medium">自分</span>}
                            {todo.source === 'manual' && <span className="bg-surface-600 px-1.5 py-0.5 rounded">手動</span>}
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteTodo(todo.id); }}
                          className="text-surface-500 hover:text-red-400 transition-colors flex-shrink-0 p-0.5"
                          title="削除"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right: ThreadViewer */}
      <div className="w-1/2 flex flex-col">
        {selectedTodo ? (
          selectedTodo.source === 'manual' && threadMessages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-surface-500 text-sm">
              手動で追加されたTo-Doです
            </div>
          ) : (
            <ThreadViewer
              messages={threadMessages}
              loading={threadLoading}
              onClose={() => { setSelectedTodo(null); setThreadMessages([]); }}
            />
          )
        ) : (
          <EmptyState title="To-Doを選択してスレッドを表示" />
        )}
      </div>
    </div>
  );
}
