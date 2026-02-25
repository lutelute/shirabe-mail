import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useMailData } from '../hooks/useMailData';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import type { MailItem, TriageResult } from '../types';
import AccountSelector from '../components/AccountSelector';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';
import { formatDate } from '../utils/date';

const REPLY_KEYWORDS = [
  'ご確認ください', 'お返事', '返信', 'ご回答', '回答お願い',
  'ご連絡ください', 'please reply', 'please respond', 'get back to',
];

const TODO_KEYWORDS = [
  '提出', '締切', '期限', '〆切', 'deadline', '要対応',
  'アクション', 'タスク', '依頼', 'お願い', 'submit',
  'action required', 'todo', 'to-do',
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

export default function TriageView() {
  const { selectedAccounts, settings, settingsLoaded } = useAppContext();
  const { mails, loading: mailsLoading, fetchMails } = useMailData();
  const { loading: aiLoading, error, triageEmails } = useClaudeAgent(settings.apiKey);

  const [triageResults, setTriageResults] = useState<TriageResult[]>([]);
  const [selectedMail, setSelectedMail] = useState<MailItem | null>(null);
  const [showIrrelevant, setShowIrrelevant] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState('all');

  const isAgentAvailable = settings.agentEnabled && !!settings.apiKey;

  useEffect(() => {
    if (settingsLoaded && selectedAccounts.length > 0) {
      fetchMails(selectedAccounts.map((a) => a.email), settings.mailDaysBack, settings.excludeSpam);
    }
  }, [settingsLoaded, selectedAccounts, settings.mailDaysBack, settings.excludeSpam, fetchMails]);

  const filteredMails = useMemo(() => {
    const base = selectedAccount === 'all' ? mails : mails.filter((m) => m.accountEmail === selectedAccount);
    if (triageResults.length === 0 || showIrrelevant) return base;
    const triageMap = new Map(triageResults.map((r) => [r.mailId, r]));
    return base.filter((m) => {
      const triage = triageMap.get(m.id);
      return !triage || triage.relevanceScore >= 0.3;
    });
  }, [mails, selectedAccount, triageResults, showIrrelevant]);

  const handleBatchClassify = useCallback(async () => {
    if (isAgentAvailable) {
      const results = await triageEmails(filteredMails);
      setTriageResults(results);
    } else {
      const fallback = filteredMails
        .map(keywordFallbackClassify)
        .filter((r): r is TriageResult => r !== null);
      setTriageResults(fallback);
    }
  }, [filteredMails, triageEmails, isAgentAvailable]);

  const triageMap = useMemo(
    () => new Map(triageResults.map((r) => [r.mailId, r])),
    [triageResults],
  );

  const replyCount = triageResults.filter((r) => r.classification === 'reply').length;
  const todoCount = triageResults.filter((r) => r.classification === 'todo').length;
  const loading = mailsLoading || aiLoading;

  return (
    <div className="flex h-full">
      {/* Left: Mail list */}
      <div className="w-3/5 flex flex-col border-r border-surface-700">
        <div className="p-3 border-b border-surface-700">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">トリアージ</h2>
              {triageResults.length > 0 && (
                <span className="text-xs bg-blue-500 text-white px-1.5 py-0.5 rounded-full">
                  {triageResults.length}
                </span>
              )}
            </div>
            <button
              onClick={handleBatchClassify}
              disabled={loading || mails.length === 0}
              className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {aiLoading ? '分析中...' : '一括分類'}
            </button>
          </div>

          <AccountSelector accounts={selectedAccounts} selected={selectedAccount} onSelect={setSelectedAccount} />

          {triageResults.length > 0 && (
            <div className="flex items-center gap-3 mt-2 text-xs">
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

          {triageResults.length > 0 && (
            <label className="flex items-center gap-1.5 mt-1.5 text-xs text-surface-400 cursor-pointer">
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
            <p className="text-xs text-surface-500 mt-1">AI未設定: キーワード検出による分類</p>
          )}
          {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
        </div>

        <div className="flex-1 overflow-y-auto">
          {mailsLoading ? (
            <LoadingSkeleton rows={8} />
          ) : filteredMails.length === 0 ? (
            <EmptyState title="メールはありません" />
          ) : (
            filteredMails.map((mail) => {
              const triage = triageMap.get(mail.id);
              const isSelected = selectedMail?.id === mail.id;
              const isLowRelevance = triage && triage.relevanceScore < 0.3;

              return (
                <div
                  key={`${mail.accountEmail}-${mail.id}`}
                  onClick={() => setSelectedMail(mail)}
                  className={`px-3 py-2 border-b border-surface-700 cursor-pointer transition-colors ${
                    isSelected ? 'bg-surface-600 border-l-2 border-l-blue-500' : 'hover:bg-surface-700'
                  } ${isLowRelevance ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {mail.importance > 1 && <span className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
                    <span className={`text-sm truncate flex-1 ${mail.isRead ? 'text-surface-300' : 'text-white font-semibold'}`}>
                      {mail.subject || '(件名なし)'}
                    </span>
                    {triage && (
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                        triage.classification === 'reply' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                      }`}>
                        {triage.classification === 'reply' ? '返信のみ' : 'To-Do作成'}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-xs text-surface-400">
                    <span className="truncate mr-2">{mail.from ? mail.from.displayName || mail.from.address : '不明'}</span>
                    <span className="flex-shrink-0">{formatDate(mail.date)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right: Detail */}
      <div className="w-2/5 flex flex-col">
        {selectedMail ? (
          <div className="flex flex-col h-full">
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white mb-1">{selectedMail.subject || '(件名なし)'}</h3>
              <div className="flex items-center gap-2 text-xs text-surface-400">
                <span>{selectedMail.from ? selectedMail.from.displayName || selectedMail.from.address : '不明'}</span>
                <span className="flex-shrink-0">{formatDate(selectedMail.date)}</span>
              </div>
              {(() => {
                const triage = triageMap.get(selectedMail.id);
                if (!triage) return null;
                return (
                  <div className="flex items-center gap-2 mt-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      triage.classification === 'reply' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                    }`}>
                      {triage.classification === 'reply' ? '返信のみ' : 'To-Do作成'}
                    </span>
                    <span className="text-xs text-surface-400">関連度: {Math.round(triage.relevanceScore * 100)}%</span>
                  </div>
                );
              })()}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {selectedMail.to && selectedMail.to.length > 0 && (
                <div className="mb-3 text-xs text-surface-400">
                  <span className="font-medium text-surface-300">To: </span>
                  {selectedMail.to.map((addr) => addr.displayName || addr.address).join(', ')}
                </div>
              )}
              {selectedMail.preview && (
                <div className="text-sm text-surface-300 whitespace-pre-wrap leading-relaxed">{selectedMail.preview}</div>
              )}
              {(() => {
                const triage = triageMap.get(selectedMail.id);
                if (!triage?.reasoning) return null;
                return (
                  <div className="mt-4 p-2 bg-surface-800 rounded border border-surface-700">
                    <p className="text-xs text-surface-400 mb-1 font-medium">AI分析理由:</p>
                    <p className="text-xs text-surface-300">{triage.reasoning}</p>
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <EmptyState title="メールを選択してください" />
        )}
      </div>
    </div>
  );
}
