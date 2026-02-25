import { useState } from 'react';
import type { MailItem, AccountConfig, TriageResult } from '../types';
import AccountSelector from './AccountSelector';

interface EmailPanelProps {
  mails: MailItem[];
  accounts: AccountConfig[];
  triageResults?: TriageResult[];
  selectedMailId?: number;
  onSelectMail?: (mail: MailItem) => void;
}

function formatDate(date: Date): string {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function getRelevanceLabel(score: number): { text: string; className: string } {
  if (score >= 0.7) return { text: '高', className: 'text-red-400' };
  if (score >= 0.4) return { text: '中', className: 'text-yellow-400' };
  return { text: '低', className: 'text-surface-500' };
}

export default function EmailPanel({
  mails,
  accounts,
  triageResults,
  selectedMailId,
  onSelectMail,
}: EmailPanelProps) {
  const [selectedAccount, setSelectedAccount] = useState('all');

  const triageMap = new Map(
    (triageResults ?? []).map((r) => [r.mailId, r])
  );

  const filteredMails =
    selectedAccount === 'all'
      ? mails
      : mails.filter((m) => m.accountEmail === selectedAccount);

  const sortedMails = [...filteredMails].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-surface-700">
        <h2 className="text-base font-semibold mb-2">メール</h2>
        <AccountSelector
          accounts={accounts}
          selected={selectedAccount}
          onSelect={setSelectedAccount}
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {sortedMails.length === 0 ? (
          <div className="p-4 text-surface-400 text-center text-sm">
            メールはありません
          </div>
        ) : (
          sortedMails.map((mail) => {
            const triage = triageMap.get(mail.id);
            const isSelected = selectedMailId === mail.id;
            const isLowRelevance = triage && triage.relevanceScore < 0.3;

            return (
              <div
                key={`${mail.accountEmail}-${mail.id}`}
                onClick={() => onSelectMail?.(mail)}
                className={`px-3 py-2 border-b border-surface-700 transition-colors ${
                  onSelectMail ? 'cursor-pointer' : 'cursor-default'
                } ${
                  isSelected
                    ? 'bg-surface-600 border-l-2 border-l-blue-500'
                    : 'hover:bg-surface-700'
                } ${isLowRelevance ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  {mail.importance > 1 && (
                    <span
                      className="inline-block w-2 h-2 rounded-full bg-red-500 flex-shrink-0"
                      title="重要度: 高"
                    />
                  )}
                  <span
                    className={`text-sm truncate flex-1 ${
                      mail.isRead ? 'text-surface-300' : 'text-white font-semibold'
                    }`}
                  >
                    {mail.subject || '(件名なし)'}
                  </span>
                  {triage && (
                    <span
                      className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${
                        triage.classification === 'reply'
                          ? 'bg-blue-500/20 text-blue-400'
                          : 'bg-purple-500/20 text-purple-400'
                      }`}
                    >
                      {triage.classification === 'reply'
                        ? '返信のみ'
                        : 'To-Do作成'}
                    </span>
                  )}
                  {mail.isFlagged && (
                    <span className="text-yellow-400 text-sm flex-shrink-0">
                      &#9733;
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-surface-400">
                  <span className="truncate mr-2">
                    {mail.from
                      ? mail.from.displayName || mail.from.address
                      : '不明'}
                  </span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {triage && (
                      <span className={`text-xs font-medium ${getRelevanceLabel(triage.relevanceScore).className}`}>
                        {getRelevanceLabel(triage.relevanceScore).text}
                      </span>
                    )}
                    <span>{formatDate(mail.date)}</span>
                  </div>
                </div>
                {mail.preview && (
                  <p className="text-xs text-surface-500 mt-1 line-clamp-2">
                    {mail.preview}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
