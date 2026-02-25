import { useState, useCallback, useMemo } from 'react';
import type { MailItem, AccountConfig, AppSettings, TriageResult } from '../types';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import EmailPanel from './EmailPanel';

interface TriageViewProps {
  mails: MailItem[];
  accounts: AccountConfig[];
  settings: AppSettings;
}

/** Keyword-based fallback classification when AI is unavailable. */
const REPLY_KEYWORDS = [
  'ご確認ください',
  'お返事',
  '返信',
  'ご回答',
  '回答お願い',
  'ご連絡ください',
  'please reply',
  'please respond',
  'get back to',
];

const TODO_KEYWORDS = [
  '提出',
  '締切',
  '期限',
  '〆切',
  'deadline',
  '要対応',
  'アクション',
  'タスク',
  '依頼',
  'お願い',
  'submit',
  'action required',
  'todo',
  'to-do',
];

function keywordFallbackClassify(mail: MailItem): TriageResult | null {
  const text = `${mail.subject} ${mail.preview}`.toLowerCase();
  const isTodo = TODO_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
  const isReply = REPLY_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));

  if (!isTodo && !isReply) return null;

  return {
    mailId: mail.id,
    classification: isTodo ? 'todo' : 'reply',
    relevanceScore: 0.5,
    reasoning: 'キーワード検出による分類',
  };
}

function formatDate(date: Date): string {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-4 bg-surface-700 rounded w-3/4" />
            <div className="h-4 bg-surface-700 rounded w-16" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 bg-surface-700 rounded w-1/3" />
            <div className="h-3 bg-surface-700 rounded w-20" />
          </div>
          <div className="h-3 bg-surface-700 rounded w-full" />
        </div>
      ))}
    </div>
  );
}

export default function TriageView({ mails, accounts, settings }: TriageViewProps) {
  const [triageResults, setTriageResults] = useState<TriageResult[]>([]);
  const [selectedMail, setSelectedMail] = useState<MailItem | null>(null);
  const [showIrrelevant, setShowIrrelevant] = useState(false);

  const { loading, error, triageEmails } = useClaudeAgent(settings.apiKey);

  const isAgentAvailable = settings.agentEnabled && !!settings.apiKey;

  const handleBatchClassify = useCallback(async () => {
    if (isAgentAvailable) {
      const results = await triageEmails(mails);
      setTriageResults(results);
    } else {
      // Keyword fallback
      const fallbackResults = mails
        .map(keywordFallbackClassify)
        .filter((r): r is TriageResult => r !== null);
      setTriageResults(fallbackResults);
    }
  }, [mails, triageEmails, isAgentAvailable]);

  const triageMap = useMemo(
    () => new Map(triageResults.map((r) => [r.mailId, r])),
    [triageResults]
  );

  const classifiedMails = useMemo(() => {
    if (triageResults.length === 0) return mails;
    if (showIrrelevant) return mails;
    // Hide irrelevant (score < 0.3) emails
    return mails.filter((m) => {
      const triage = triageMap.get(m.id);
      return !triage || triage.relevanceScore >= 0.3;
    });
  }, [mails, triageResults, triageMap, showIrrelevant]);

  const classifiedCount = triageResults.length;
  const replyCount = triageResults.filter((r) => r.classification === 'reply').length;
  const todoCount = triageResults.filter((r) => r.classification === 'todo').length;

  const handleSelectMail = useCallback((mail: MailItem) => {
    setSelectedMail(mail);
  }, []);

  return (
    <div className="flex h-full">
      {/* Left column: Email list (60%) */}
      <div className="w-3/5 flex flex-col border-r border-surface-700">
        {/* Triage header */}
        <div className="p-3 border-b border-surface-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">トリアージ</h2>
              {classifiedCount > 0 && (
                <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full">
                  {classifiedCount}
                </span>
              )}
            </div>
            <button
              onClick={handleBatchClassify}
              disabled={loading || mails.length === 0}
              className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? '分析中...' : '一括分類'}
            </button>
          </div>

          {/* Classification summary */}
          {classifiedCount > 0 && (
            <div className="flex items-center gap-3 mb-2 text-xs">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-surface-300">返信のみ: {replyCount}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-purple-500" />
                <span className="text-surface-300">To-Do作成: {todoCount}</span>
              </span>
            </div>
          )}

          {/* Toggle irrelevant */}
          {classifiedCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showIrrelevant}
                onChange={(e) => setShowIrrelevant(e.target.checked)}
                className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              低関連度メールを表示
            </label>
          )}

          {!isAgentAvailable && (
            <p className="text-xs text-surface-500 mt-1">
              AI未設定: キーワード検出による分類
            </p>
          )}

          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}
        </div>

        {/* Email list */}
        {loading ? (
          <LoadingSkeleton />
        ) : (
          <div className="flex-1 overflow-hidden">
            <EmailPanel
              mails={classifiedMails}
              accounts={accounts}
              triageResults={triageResults}
              selectedMailId={selectedMail?.id}
              onSelectMail={handleSelectMail}
            />
          </div>
        )}
      </div>

      {/* Right column: Detail/Thread (40%) */}
      <div className="w-2/5 flex flex-col">
        {selectedMail ? (
          <div className="flex flex-col h-full">
            {/* Detail header */}
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white mb-1">
                {selectedMail.subject || '(件名なし)'}
              </h3>
              <div className="flex items-center gap-2 text-xs text-surface-400">
                <span>
                  {selectedMail.from
                    ? selectedMail.from.displayName || selectedMail.from.address
                    : '不明'}
                </span>
                <span className="flex-shrink-0">
                  {formatDate(selectedMail.date)}
                </span>
              </div>
              {(() => {
                const triage = triageMap.get(selectedMail.id);
                if (!triage) return null;
                return (
                  <div className="flex items-center gap-2 mt-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                        triage.classification === 'reply'
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-purple-500/20 text-purple-400'
                      }`}
                    >
                      {triage.classification === 'reply'
                        ? '返信のみ'
                        : 'To-Do作成'}
                    </span>
                    <span className="text-xs text-surface-400">
                      関連度: {Math.round(triage.relevanceScore * 100)}%
                    </span>
                  </div>
                );
              })()}
            </div>

            {/* Detail body */}
            <div className="flex-1 overflow-y-auto p-3">
              {/* To addresses */}
              {selectedMail.to && selectedMail.to.length > 0 && (
                <div className="mb-3 text-xs text-surface-400">
                  <span className="font-medium text-surface-300">To: </span>
                  {selectedMail.to
                    .map((addr) => addr.displayName || addr.address)
                    .join(', ')}
                </div>
              )}

              {/* Preview content */}
              {selectedMail.preview && (
                <div className="text-sm text-surface-300 whitespace-pre-wrap leading-relaxed">
                  {selectedMail.preview}
                </div>
              )}

              {/* AI reasoning */}
              {(() => {
                const triage = triageMap.get(selectedMail.id);
                if (!triage?.reasoning) return null;
                return (
                  <div className="mt-4 p-2 bg-surface-800 rounded border border-surface-700">
                    <p className="text-xs text-surface-400 mb-1 font-medium">
                      AI分析理由:
                    </p>
                    <p className="text-xs text-surface-300">
                      {triage.reasoning}
                    </p>
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-surface-500 text-sm">
              メールを選択してください
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
