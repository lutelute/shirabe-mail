import { useState, useEffect, useCallback } from 'react';
import type { ShirabeDigest, ShirabeUrgentItem, ShirabeThesisStatus, ShirabeRoutineProgress, MailNote, MailItem, ViewType } from '../types';
import { BUILTIN_TAGS } from '../types';
import { useNoteService } from '../context/NoteServiceContext';
import { isObviousSpam } from '../utils/spamFilter';
import { openInEmClient } from '../utils/openInEmClient';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';

interface ShirabeViewProps {
  onNavigate: (view: ViewType) => void;
}

// Thesis data placeholder (populate from external config or API)
const THESIS_DATA: ShirabeThesisStatus[] = [];

// Tag color map for badges
const TAG_COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  amber:   { bg: 'bg-amber-500/15',   text: 'text-amber-400',   border: 'border-amber-500/30' },
  orange:  { bg: 'bg-orange-500/15',  text: 'text-orange-400',  border: 'border-orange-500/30' },
  violet:  { bg: 'bg-violet-500/15',  text: 'text-violet-400',  border: 'border-violet-500/30' },
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  red:     { bg: 'bg-red-500/15',     text: 'text-red-400',     border: 'border-red-500/30' },
  sky:     { bg: 'bg-sky-500/15',     text: 'text-sky-400',     border: 'border-sky-500/30' },
  rose:    { bg: 'bg-rose-500/15',    text: 'text-rose-400',    border: 'border-rose-500/30' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatWeekday(iso: string): string {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return weekdays[new Date(iso).getDay()];
}

// Extract tag info
function getTagInfo(tagId: string) {
  const tag = BUILTIN_TAGS.find(t => t.id === tagId);
  if (!tag) return null;
  const colors = TAG_COLOR_MAP[tag.color] ?? { bg: 'bg-surface-600', text: 'text-surface-300', border: 'border-surface-500' };
  return { ...tag, ...colors };
}

// Categorize notes by action priority
interface NotesByAction {
  urgent: MailNote[];    // 至急
  reply: MailNote[];     // 要返信
  action: MailNote[];    // 要対応
  hold: MailNote[];      // 保留
  info: MailNote[];      // 情報
  done: MailNote[];      // 対応済
  untagged: MailNote[];  // タグなし（コンテンツあり）
}

function categorizeNotes(notes: MailNote[]): NotesByAction {
  const result: NotesByAction = { urgent: [], reply: [], action: [], hold: [], info: [], done: [], untagged: [] };
  for (const note of notes) {
    const tags = note.tags ?? (note.quickLabel ? [note.quickLabel] : []);
    if (tags.includes('urgent')) result.urgent.push(note);
    else if (tags.includes('reply')) result.reply.push(note);
    else if (tags.includes('action')) result.action.push(note);
    else if (tags.includes('hold')) result.hold.push(note);
    else if (tags.includes('info')) result.info.push(note);
    else if (tags.includes('done') || tags.includes('unnecessary')) result.done.push(note);
    else if (note.content) result.untagged.push(note);
  }
  return result;
}

// Extract deadlines from note content
interface DeadlineItem {
  subject: string;
  deadline: string;
  noteId: string;
}

function extractDeadlines(notes: MailNote[]): DeadlineItem[] {
  const deadlines: DeadlineItem[] = [];
  for (const note of notes) {
    if (!note.content) continue;
    // Look for ⚠️ 期限 section and extract lines
    const deadlineMatch = note.content.match(/## ⚠️\s*期限\s*\n([\s\S]*?)(?=\n##|\n*$)/);
    if (deadlineMatch) {
      const lines = deadlineMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      for (const line of lines) {
        const text = line.replace(/^[-*]\s*(\[[ x]\]\s*)?/, '').trim();
        if (text && !text.includes('なし') && !text.includes('省略')) {
          deadlines.push({
            subject: note.subject,
            deadline: text,
            noteId: note.id,
          });
        }
      }
    }
  }
  return deadlines;
}

export default function ShirabeView({ onNavigate }: ShirabeViewProps) {
  const [digest, setDigest] = useState<ShirabeDigest | null>(null);
  const [notes, setNotes] = useState<MailNote[]>([]);
  const [unreadMails, setUnreadMails] = useState<MailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const noteService = useNoteService();

  const loadDigest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.electronAPI;

      const accounts = await api.getAccounts();

      // Load notes and other data in parallel
      const [allNotes, ...accountResults] = await Promise.all([
        api.getNotes() as Promise<MailNote[]>,
        ...accounts.flatMap(acc => [
          api.getTasks(acc.email).catch(() => []),
          api.getEvents(acc.email, 7).catch(() => []),
          api.getMails(acc.email, 3).catch(() => []),
        ]),
      ]);

      setNotes(allNotes);

      // Reassemble results from flat array
      let tasks: Awaited<ReturnType<typeof api.getTasks>> = [];
      let events: Awaited<ReturnType<typeof api.getEvents>> = [];
      let unreadMails: Awaited<ReturnType<typeof api.getMails>> = [];

      for (let i = 0; i < accounts.length; i++) {
        const base = i * 3;
        tasks = tasks.concat(accountResults[base] as typeof tasks);
        events = events.concat(accountResults[base + 1] as typeof events);
        unreadMails = unreadMails.concat(accountResults[base + 2] as typeof unreadMails);
      }

      events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      // Filter out obvious spam by content analysis (not folder-based)
      unreadMails = unreadMails.filter(m => !isObviousSpam(m));
      unreadMails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setUnreadMails(unreadMails);

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

  const categorized = categorizeNotes(notes);
  const deadlines = extractDeadlines(notes);
  const actionableCount = categorized.urgent.length + categorized.reply.length + categorized.action.length;
  const totalNotes = notes.filter(n => n.content).length;

  const hasThesisData = digest.thesis.length > 0;
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

      {/* Running generation indicator */}
      {noteService.runningCount > 0 && (
        <div className="mb-3 px-3 py-2 bg-purple-500/10 border border-purple-500/30 rounded-lg flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
          <span className="text-xs text-purple-400">
            AI分析中... ({noteService.runningCount}件のノートを生成中)
          </span>
        </div>
      )}

      {/* Summary stats bar */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-900 rounded-lg border border-surface-700/50">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          <span className="text-xs text-surface-400">要対応</span>
          <span className="text-sm font-medium text-surface-100">{actionableCount}</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-900 rounded-lg border border-surface-700/50">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          <span className="text-xs text-surface-400">期限</span>
          <span className="text-sm font-medium text-surface-100">{deadlines.length}</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-900 rounded-lg border border-surface-700/50">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-xs text-surface-400">予定</span>
          <span className="text-sm font-medium text-surface-100">{digest.weekEvents.length}</span>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-900 rounded-lg border border-surface-700/50">
          <span className="w-2 h-2 rounded-full bg-surface-500" />
          <span className="text-xs text-surface-400">分析済</span>
          <span className="text-sm font-medium text-surface-100">{totalNotes}</span>
        </div>
      </div>

      {/* Grid layout */}
      <div className="grid grid-cols-2 gap-4">
        {/* Action required notes (from tags) */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-red-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            対応が必要 ({actionableCount})
          </h2>
          {actionableCount === 0 ? (
            <p className="text-sm text-surface-500">対応が必要なメールはありません</p>
          ) : (
            <ul className="space-y-1.5">
              {/* Urgent first, then reply, then action */}
              {[...categorized.urgent, ...categorized.reply, ...categorized.action].slice(0, 8).map((note, i) => {
                const tags = note.tags ?? (note.quickLabel ? [note.quickLabel] : []);
                const primaryTag = tags[0];
                const tagInfo = primaryTag ? getTagInfo(primaryTag) : null;
                return (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm cursor-pointer hover:bg-surface-800/50 rounded px-1 py-0.5 -mx-1 transition-colors"
                    onClick={() => {
                      openInEmClient({
                        subject: note.subject,
                      });
                    }}
                    title="クリックでeM Clientで開く"
                  >
                    {tagInfo ? (
                      <span className={`text-[9px] px-1.5 py-px rounded border flex-shrink-0 mt-0.5 ${tagInfo.bg} ${tagInfo.text} ${tagInfo.border}`}>
                        {tagInfo.label}
                      </span>
                    ) : (
                      <span className="text-red-400 mt-0.5 flex-shrink-0">!</span>
                    )}
                    <span className="text-surface-300 line-clamp-1">{note.subject}</span>
                    <span className="text-[8px] text-surface-600 flex-shrink-0 mt-0.5 ml-auto">eM</span>
                  </li>
                );
              })}
              {actionableCount > 8 && (
                <li className="text-xs text-surface-500 pl-1">...他 {actionableCount - 8} 件</li>
              )}
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

        {/* Deadlines (extracted from notes) */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-amber-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            期限・締切 ({deadlines.length})
          </h2>
          {deadlines.length === 0 ? (
            <p className="text-sm text-surface-500">抽出された期限なし</p>
          ) : (
            <ul className="space-y-2">
              {deadlines.slice(0, 6).map((dl, i) => (
                <li key={i} className="text-sm">
                  <div className="text-surface-300 line-clamp-1">{dl.deadline}</div>
                  <div className="text-[10px] text-surface-500 mt-0.5 line-clamp-1">{dl.subject}</div>
                </li>
              ))}
              {deadlines.length > 6 && (
                <li className="text-xs text-surface-500">...他 {deadlines.length - 6} 件</li>
              )}
            </ul>
          )}
          <button
            onClick={() => onNavigate('mail')}
            className="mt-3 text-xs text-accent-400 hover:text-accent-300"
          >
            メール確認 →
          </button>
        </section>

        {/* Unread mails */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-sky-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sky-500" />
            未読メール ({digest.urgent.filter(u => u.source === 'mail').length})
          </h2>
          {digest.urgent.filter(u => u.source === 'mail').length === 0 ? (
            <p className="text-sm text-surface-500">未読メールなし</p>
          ) : (
            <ul className="space-y-1.5">
              {digest.urgent.filter(u => u.source === 'mail').map((item, i) => (
                <li
                  key={i}
                  className="text-sm text-surface-300 line-clamp-1 cursor-pointer hover:bg-surface-800/50 rounded px-1 py-0.5 -mx-1 transition-colors"
                  onClick={() => {
                    // Extract subject from label (format: "subject — sender")
                    const subject = item.label.split(' — ')[0];
                    openInEmClient({ subject });
                  }}
                  title="クリックでeM Clientで開く"
                >
                  {item.label}
                </li>
              ))}
            </ul>
          )}
          <button
            onClick={() => onNavigate('mail')}
            className="mt-3 text-xs text-accent-400 hover:text-accent-300"
          >
            メール一覧 →
          </button>
        </section>

        {/* Note analysis summary */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-emerald-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            分析ノート概況
          </h2>
          <div className="space-y-1.5">
            {(['urgent', 'reply', 'action', 'hold', 'info', 'done'] as const).map(key => {
              const list = categorized[key];
              if (list.length === 0) return null;
              const tagInfo = getTagInfo(key);
              if (!tagInfo) return null;
              return (
                <div key={key} className="flex items-center justify-between text-sm">
                  <span className={`text-[10px] px-1.5 py-px rounded border ${tagInfo.bg} ${tagInfo.text} ${tagInfo.border}`}>
                    {tagInfo.label}
                  </span>
                  <span className="text-surface-300 font-mono text-xs">{list.length} 件</span>
                </div>
              );
            })}
            {categorized.untagged.length > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-[10px] px-1.5 py-px rounded border bg-surface-700 text-surface-400 border-surface-600">
                  未分類
                </span>
                <span className="text-surface-300 font-mono text-xs">{categorized.untagged.length} 件</span>
              </div>
            )}
          </div>
          {totalNotes === 0 && (
            <p className="text-sm text-surface-500 mt-2">ノートなし（メール画面で分析を開始）</p>
          )}
        </section>

        {/* 校務 (Administrative duties including thesis reviews) */}
        <section className="bg-surface-900 rounded-lg border border-surface-700/50 p-4">
          <h2 className="text-sm font-medium text-violet-400 mb-3 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-violet-500" />
            校務
          </h2>

          {/* Thesis sub-section */}
          {hasThesisData && (
            <div className="mb-3">
              <h3 className="text-xs text-surface-500 mb-1.5 font-medium">学位審査</h3>
              <div className="space-y-2 pl-1">
                {thesisD.length > 0 && (
                  <div>
                    <h4 className="text-[10px] text-surface-500 mb-0.5">博士 (D)</h4>
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
                )}
                {thesisM.length > 0 && (
                  <div>
                    <h4 className="text-[10px] text-surface-500 mb-0.5">修士 (M)</h4>
                    {thesisM.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-sm py-0.5">
                        <span className="text-surface-300">{t.student}</span>
                        <span className="text-xs text-amber-400">{t.phase}</span>
                      </div>
                    ))}
                  </div>
                )}
                {thesisB.length > 0 && (
                  <div>
                    <h4 className="text-[10px] text-surface-500 mb-0.5">学士 (B)</h4>
                    {thesisB.map((t, i) => (
                      <div key={i} className="flex items-center justify-between text-sm py-0.5">
                        <span className="text-surface-300">{t.student}</span>
                        <span className="text-xs text-blue-400">{t.phase}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Overdue tasks from eM Client */}
          {digest.urgent.filter(u => u.source === 'task').length > 0 && (
            <div className="mb-3">
              <h3 className="text-xs text-surface-500 mb-1.5 font-medium">期限超過タスク</h3>
              <ul className="space-y-1 pl-1">
                {digest.urgent.filter(u => u.source === 'task').map((item, i) => (
                  <li key={i} className="text-sm text-red-400 line-clamp-1">
                    {item.label}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Placeholder for future items */}
          {!hasThesisData && digest.urgent.filter(u => u.source === 'task').length === 0 && (
            <p className="text-sm text-surface-500">校務データなし</p>
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
            ルーティンチェック →
          </button>
        </section>
      </div>

      {/* Quick actions */}
      <div className="mt-6 flex gap-3 flex-wrap">
        <button
          onClick={() => {
            // Batch analyze: generate notes for unread mails without notes
            const noteIds = new Set(notes.map(n => n.id));
            const toAnalyze = unreadMails.filter(m => {
              const id = m.conversationId ? `conv-${m.conversationId}` : `mail-${m.id}`;
              return !noteIds.has(id) && !noteService.isGenerating(id);
            });
            for (const mail of toAnalyze.slice(0, 10)) {
              noteService.requestGeneration(mail, [], 'light', null);
            }
          }}
          disabled={noteService.runningCount > 0}
          className="px-4 py-2 bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/30 rounded-lg text-sm text-purple-400 transition-colors disabled:opacity-40"
        >
          {noteService.runningCount > 0
            ? `分析中 (${noteService.runningCount}件)...`
            : `未読メール一括分析 (${unreadMails.filter(m => {
                const id = m.conversationId ? `conv-${m.conversationId}` : `mail-${m.id}`;
                return !new Set(notes.map(n => n.id)).has(id);
              }).length}件)`
          }
        </button>
        <button
          onClick={() => {
            // Refresh notes after batch analysis
            loadDigest();
          }}
          className="px-4 py-2 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-sm text-surface-300 transition-colors"
        >
          データ更新
        </button>
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
