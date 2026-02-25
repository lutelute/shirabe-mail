import { useState } from 'react';
import type { ActionItem } from '../types';

interface ActionPanelProps {
  actions: ActionItem[];
  /** Current user account email for "assigned to me" detection */
  currentAccountEmail?: string;
  /** Callback when user clicks a source thread link */
  onSelectThread?: (mailId: number, accountEmail: string) => void;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function formatDeadline(date: Date): string {
  const d = new Date(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ActionPanel({
  actions,
  currentAccountEmail,
  onSelectThread,
}: ActionPanelProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  const toggleCompleted = (id: string) => {
    setCompletedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isItemCompleted = (item: ActionItem) =>
    item.isCompleted || completedIds.has(item.id);

  const filtered = showCompleted
    ? actions
    : actions.filter((a) => !isItemCompleted(a));

  const sorted = [...filtered].sort((a, b) => {
    // Deadline soonest first (null last)
    const aDeadline = a.deadline ? new Date(a.deadline).getTime() : Infinity;
    const bDeadline = b.deadline ? new Date(b.deadline).getTime() : Infinity;
    if (aDeadline !== bDeadline) return aDeadline - bDeadline;
    // Then by priority
    return (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2);
  });

  const activeCount = actions.filter((a) => !isItemCompleted(a)).length;

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-surface-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">アクション項目</h2>
            <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full">
              {activeCount}
            </span>
          </div>
        </div>
        <label className="flex items-center gap-1.5 mt-2 text-xs text-surface-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
          />
          完了済みを表示
        </label>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-surface-400 text-center text-sm">
            アクション項目はありません
          </div>
        ) : (
          sorted.map((action) => {
            const completed = isItemCompleted(action);
            return (
              <div
                key={action.id}
                className={`px-3 py-2 border-b border-surface-700 ${
                  completed ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-start gap-2">
                  <button
                    onClick={() => toggleCompleted(action.id)}
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
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          action.priority === 'high'
                            ? 'bg-red-500'
                            : action.priority === 'medium'
                            ? 'bg-yellow-500'
                            : 'bg-green-500'
                        }`}
                      />
                      <span
                        className={`text-sm ${
                          completed ? 'line-through text-surface-500' : 'text-white'
                        }`}
                      >
                        {action.action}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-surface-400">
                      {action.deadline && (
                        <span>{formatDeadline(action.deadline)}</span>
                      )}
                      {action.category && (
                        <span className="bg-surface-700 px-1.5 py-0.5 rounded">
                          {action.category}
                        </span>
                      )}
                      <span
                        className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                          action.source === 'ai'
                            ? 'bg-purple-500/20 text-purple-400'
                            : action.source === 'agent'
                            ? 'bg-green-500/20 text-green-400'
                            : 'bg-blue-500/20 text-blue-400'
                        }`}
                      >
                        {action.source === 'ai'
                          ? 'AI'
                          : action.source === 'agent'
                          ? 'Agent'
                          : 'KW'}
                      </span>
                      {currentAccountEmail &&
                        action.accountEmail === currentAccountEmail && (
                          <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-medium">
                            自分
                          </span>
                        )}
                      {onSelectThread && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectThread(
                              action.mailId,
                              action.accountEmail,
                            );
                          }}
                          className="text-surface-500 hover:text-blue-400 transition-colors truncate"
                          title={action.subject}
                        >
                          {action.subject
                            ? `📧 ${action.subject.length > 20 ? action.subject.slice(0, 20) + '…' : action.subject}`
                            : `📧 #${action.mailId}`}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
