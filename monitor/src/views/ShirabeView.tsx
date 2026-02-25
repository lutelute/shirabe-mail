import { useState, useEffect, useCallback } from 'react';
import type { ShirabeDigest, ShirabeUrgentItem, ShirabeThesisStatus, ShirabeRoutineProgress, ViewType } from '../types';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';

interface ShirabeViewProps {
  onNavigate: (view: ViewType) => void;
}

// Static thesis data from references (loaded once)
const THESIS_DATA: ShirabeThesisStatus[] = [
  { student: 'Student-M1', category: 'M', phase: '報告書提出', nextMilestone: '報告書〆切 ~2/19', daysLeft: null },
  { student: 'Student-M2', category: 'M', phase: '報告書承認済(2/16)', nextMilestone: '-', daysLeft: null },
  { student: 'Student-M3', category: 'M', phase: '報告書提出', nextMilestone: '報告書〆切 ~2/19', daysLeft: null },
  { student: 'Student-M4', category: 'M', phase: '報告書提出', nextMilestone: '報告書〆切 ~2/19', daysLeft: null },
  { student: 'Student-M5', category: 'M', phase: '報告書提出', nextMilestone: '報告書〆切 ~2/19', daysLeft: null },
  { student: 'Student-M6', category: 'M', phase: '報告書提出', nextMilestone: '報告書〆切 ~2/19', daysLeft: null },
  { student: 'Student-D1', category: 'D', phase: '公聴会済(1/20)', nextMilestone: '報告書提出', daysLeft: null },
  { student: 'Student-D2', category: 'D', phase: '公聴会済(1/20)', nextMilestone: '報告書提出', daysLeft: null },
  { student: 'Student-D3', category: 'D', phase: '完了（9月修了済）', nextMilestone: '-', daysLeft: null },
  { student: 'Student-B1', category: 'B', phase: '卒論発表済', nextMilestone: '卒論提出 & 判定', daysLeft: null },
  { student: 'Student-B2', category: 'B', phase: '卒論発表済', nextMilestone: '卒論提出 & 判定', daysLeft: null },
  { student: 'Student-B3', category: 'B', phase: '卒論発表済', nextMilestone: '卒論提出 & 判定', daysLeft: null },
];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatWeekday(iso: string): string {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return weekdays[new Date(iso).getDay()];
}

export default function ShirabeView({ onNavigate }: ShirabeViewProps) {
  const [digest, setDigest] = useState<ShirabeDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.electronAPI;

      // Parallel fetch: unread mails, calendar events, tasks
      const [accounts, tasks] = await Promise.all([
        api.getAccounts(),
        api.getTasks('' /* all accounts */),
      ]);

      // Get events for the next 7 days
      let events: Awaited<ReturnType<typeof api.getEvents>> = [];
      for (const acc of accounts) {
        try {
          const accEvents = await api.getEvents(acc.email, 7);
          events = events.concat(accEvents);
        } catch {
          // skip accounts without calendar
        }
      }
      events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      // Get unread mails (last 3 days)
      let unreadMails: Awaited<ReturnType<typeof api.getMails>> = [];
      for (const acc of accounts) {
        try {
          const mails = await api.getMails(acc.email, 3);
          unreadMails = unreadMails.concat(mails);
        } catch {
          // skip
        }
      }
      unreadMails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Build urgent items from unread mails (top 5)
      const urgent: ShirabeUrgentItem[] = unreadMails.slice(0, 5).map((m) => ({
        label: `${m.subject} — ${m.from?.displayName || m.from?.address || ''}`,
        source: 'mail' as const,
        sourceId: m.id,
        accountEmail: m.accountEmail,
      }));

      // Add overdue tasks
      const now = new Date();
      for (const t of tasks) {
        if (t.end && new Date(t.end) < now && !t.completed) {
          urgent.push({
            label: `[期限超過] ${t.summary}`,
            source: 'task',
            accountEmail: t.accountEmail,
          });
        }
      }

      // Build week events
      const weekEvents = events.slice(0, 10).map((e) => ({
        date: new Date(e.start).toISOString(),
        summary: e.summary,
        preparation: e.location || undefined,
      }));

      // Routine progress (current month placeholder)
      const currentMonth = now.getMonth() + 1;
      const routine: ShirabeRoutineProgress = {
        month: currentMonth,
        completed: 0,
        total: 0,
        pending: [],
      };

      setDigest({
        date: now.toISOString(),
        urgent,
        weekEvents,
        thesis: THESIS_DATA,
        routine,
        lastUpdated: now.toISOString(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDigest();
  }, [loadDigest]);

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton rows={8} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          <p className="font-medium">データ取得エラー</p>
          <p className="text-sm mt-1">{error}</p>
          <button
            onClick={loadDigest}
            className="mt-2 px-3 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-sm"
          >
            再試行
          </button>
        </div>
      </div>
    );
  }

  if (!digest) return null;

  const thesisD = digest.thesis.filter((t) => t.category === 'D');
  const thesisM = digest.thesis.filter((t) => t.category === 'M');
  const thesisB = digest.thesis.filter((t) => t.category === 'B');

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-surface-100">
            調 Dashboard
          </h1>
          <p className="text-sm text-surface-500 mt-0.5">
            {new Date(digest.date).toLocaleDateString('ja-JP', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}
          </p>
        </div>
        <button
          onClick={loadDigest}
          className="px-3 py-1.5 bg-surface-800 hover:bg-surface-700 rounded-lg text-sm text-surface-300 transition-colors"
        >
          更新
        </button>
      </div>

      {/* Grid layout */}
      <div className="grid grid-cols-2 gap-4">
        {/* Urgent items */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-red-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            緊急 ({digest.urgent.length})
          </h2>
          {digest.urgent.length === 0 ? (
            <p className="text-sm text-surface-500">緊急項目なし</p>
          ) : (
            <ul className="space-y-2">
              {digest.urgent.map((item, i) => (
                <li key={i} className="text-sm text-surface-300 flex items-start gap-2">
                  <span className="text-red-400 mt-0.5 flex-shrink-0">
                    {item.source === 'mail' ? '!' : item.source === 'task' ? '!' : '!'}
                  </span>
                  <span className="line-clamp-2">{item.label}</span>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => onNavigate('triage')}
            className="mt-3 text-xs text-accent-400 hover:text-accent-300"
          >
            トリアージへ →
          </button>
        </section>

        {/* Week schedule */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-blue-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            今週の予定
          </h2>
          {digest.weekEvents.length === 0 ? (
            <p className="text-sm text-surface-500">今週の予定なし</p>
          ) : (
            <ul className="space-y-1.5">
              {digest.weekEvents.map((ev, i) => (
                <li key={i} className="text-sm text-surface-300 flex items-start gap-2">
                  <span className="text-surface-500 flex-shrink-0 w-12 text-right font-mono text-xs mt-0.5">
                    {formatDate(ev.date)}({formatWeekday(ev.date)})
                  </span>
                  <span className="line-clamp-1">{ev.summary}</span>
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => onNavigate('calendar')}
            className="mt-3 text-xs text-accent-400 hover:text-accent-300"
          >
            カレンダーへ →
          </button>
        </section>

        {/* Thesis status */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-amber-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            学位審査
          </h2>
          <div className="space-y-3">
            {/* Doctoral */}
            <div>
              <h3 className="text-xs text-surface-500 mb-1">博士 (D)</h3>
              {thesisD.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-0.5">
                  <span className={`text-surface-300 ${t.phase.includes('完了') ? 'line-through text-surface-500' : ''}`}>
                    {t.student}
                  </span>
                  <span className={`text-xs ${t.phase.includes('完了') ? 'text-emerald-400' : 'text-amber-400'}`}>
                    {t.phase.includes('完了') ? '完了' : t.phase}
                  </span>
                </div>
              ))}
            </div>
            {/* Master's */}
            <div>
              <h3 className="text-xs text-surface-500 mb-1">修士 (M)</h3>
              {thesisM.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-0.5">
                  <span className="text-surface-300">{t.student}</span>
                  <span className="text-xs text-amber-400">{t.phase}</span>
                </div>
              ))}
            </div>
            {/* Bachelor's */}
            <div>
              <h3 className="text-xs text-surface-500 mb-1">学士 (B)</h3>
              {thesisB.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-sm py-0.5">
                  <span className="text-surface-300">{t.student}</span>
                  <span className="text-xs text-blue-400">{t.phase}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Routine progress */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-emerald-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            ルーティン ({digest.routine.month}月)
          </h2>
          <div className="mb-3">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-surface-400">進捗</span>
              <span className="text-surface-300">
                {digest.routine.total > 0
                  ? `${digest.routine.completed}/${digest.routine.total} 完了`
                  : 'データ読み込み中...'}
              </span>
            </div>
            {digest.routine.total > 0 && (
              <div className="w-full bg-surface-800 rounded-full h-2">
                <div
                  className="bg-emerald-500 h-2 rounded-full transition-all"
                  style={{
                    width: `${Math.round((digest.routine.completed / digest.routine.total) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
          {digest.routine.pending.length > 0 && (
            <div>
              <h3 className="text-xs text-surface-500 mb-1">未完了</h3>
              <ul className="space-y-0.5">
                {digest.routine.pending.slice(0, 5).map((item, i) => (
                  <li key={i} className="text-sm text-surface-400">
                    - {item}
                  </li>
                ))}
                {digest.routine.pending.length > 5 && (
                  <li className="text-xs text-surface-500">
                    ...他 {digest.routine.pending.length - 5} 件
                  </li>
                )}
              </ul>
            </div>
          )}
          <button
            onClick={() => {
              window.electronAPI.ptyCreate().then(() => {
                window.electronAPI.ptyWrite('/routine-checker\n');
                onNavigate('chat');
              });
            }}
            className="mt-3 text-xs text-accent-400 hover:text-accent-300"
          >
            詳細チェック →
          </button>
        </section>
      </div>

      {/* Quick actions */}
      <div className="mt-6 flex gap-3">
        <button
          onClick={() => {
            window.electronAPI.ptyCreate().then(() => {
              window.electronAPI.ptyWrite('/shirabe\n');
              onNavigate('chat');
            });
          }}
          className="px-4 py-2 bg-accent-500/20 hover:bg-accent-500/30 border border-accent-500/30 rounded-lg text-sm text-accent-400 transition-colors"
        >
          /shirabe を実行
        </button>
        <button
          onClick={() => {
            window.electronAPI.ptyCreate().then(() => {
              window.electronAPI.ptyWrite('/daily-briefing\n');
              onNavigate('chat');
            });
          }}
          className="px-4 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-sm text-surface-300 transition-colors"
        >
          ブリーフィング
        </button>
        <button
          onClick={() => onNavigate('mail')}
          className="px-4 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-sm text-surface-300 transition-colors"
        >
          メール確認
        </button>
      </div>
    </div>
  );
}
