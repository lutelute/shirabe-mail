import { useState, useEffect, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { useTaskData } from '../hooks/useTaskData';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';
import { formatDateOnly } from '../utils/date';

export default function TaskView() {
  const { selectedAccounts, settingsLoaded } = useAppContext();
  const { tasks, loading, error, fetchTasks } = useTaskData();
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    if (settingsLoaded && selectedAccounts.length > 0) {
      fetchTasks(selectedAccounts.map((a) => a.email));
    }
  }, [settingsLoaded, selectedAccounts, fetchTasks]);

  const filtered = useMemo(() => {
    if (showCompleted) return tasks;
    return tasks.filter((t) => !t.completed);
  }, [tasks, showCompleted]);

  const completedCount = useMemo(() => tasks.filter((t) => t.completed).length, [tasks]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-surface-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">タスク</h2>
            <span className="text-xs text-surface-400">({filtered.length}件)</span>
          </div>
          <button
            onClick={() => fetchTasks(selectedAccounts.map((a) => a.email))}
            disabled={loading}
            className="px-3 py-1 text-sm bg-surface-700 hover:bg-surface-600 rounded transition-colors disabled:opacity-50"
          >
            更新
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-surface-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          完了済みを表示 ({completedCount})
        </label>
      </div>
      {error && <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10">{error}</div>}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <LoadingSkeleton rows={6} variant="card" />
        ) : filtered.length === 0 ? (
          <EmptyState title="タスクはありません" />
        ) : (
          <div className="divide-y divide-surface-700">
            {filtered.map((task) => {
              const isCompleted = !!task.completed;
              const isOverdue = task.end && new Date(task.end) < new Date() && !isCompleted;
              return (
                <div key={`${task.accountEmail}-${task.id}`} className={`px-3 py-2.5 ${isCompleted ? 'opacity-50' : ''}`}>
                  <div className="flex items-start gap-2">
                    <div className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
                      isCompleted ? 'bg-blue-500 border-blue-500' : 'border-surface-500'
                    }`}>
                      {isCompleted && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm ${isCompleted ? 'line-through text-surface-500' : 'text-white'}`}>
                        {task.summary || '(タイトルなし)'}
                      </div>
                      {task.description && (
                        <p className="text-xs text-surface-400 mt-0.5 line-clamp-2">{task.description}</p>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-xs text-surface-500">
                        {task.end && (
                          <span className={isOverdue ? 'text-red-400 font-medium' : ''}>
                            期限: {formatDateOnly(task.end)}
                          </span>
                        )}
                        {task.percentComplete > 0 && task.percentComplete < 100 && (
                          <span>{task.percentComplete}%</span>
                        )}
                        <span>{task.accountEmail.split('@')[0]}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
