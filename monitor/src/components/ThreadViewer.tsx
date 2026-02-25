import { useState, useMemo } from 'react';
import type { ThreadMessage } from '../types';

interface ThreadViewerProps {
  messages: ThreadMessage[];
  loading: boolean;
  onClose?: () => void;
}

/** Number of messages to show initially before pagination. */
const PAGE_SIZE = 10;

function formatDate(date: Date): string {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

function formatFullDate(date: Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getAccountLabel(sourceAccount: string): string {
  const parts = sourceAccount.split('@');
  if (parts.length < 2) return sourceAccount;
  return parts[0];
}

function LoadingSkeleton() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="p-3 bg-surface-800 rounded space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-3 bg-surface-700 rounded w-1/4" />
            <div className="h-3 bg-surface-700 rounded w-20" />
          </div>
          <div className="h-3 bg-surface-700 rounded w-full" />
          <div className="h-3 bg-surface-700 rounded w-3/4" />
        </div>
      ))}
    </div>
  );
}

interface MessageItemProps {
  message: ThreadMessage;
  isExpanded: boolean;
  onToggle: () => void;
}

function MessageItem({ message, isExpanded, onToggle }: MessageItemProps) {
  return (
    <div
      className={`rounded border transition-colors ${
        message.isSentByMe
          ? 'bg-surface-700/50 border-surface-600'
          : 'bg-surface-800 border-surface-700'
      }`}
    >
      {/* Message header - always visible */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center gap-2"
      >
        {/* Expand/collapse indicator */}
        <span className="text-surface-500 text-xs flex-shrink-0 w-4">
          {isExpanded ? '▼' : '▶'}
        </span>

        {/* Sent-by-me arrow indicator */}
        {message.isSentByMe && (
          <span className="text-blue-400 flex-shrink-0" title="自分が送信">
            →
          </span>
        )}

        {/* Sender */}
        <span className="text-sm text-surface-200 truncate flex-1">
          {message.from}
        </span>

        {/* Cross-account badge */}
        {message.isSentByMe && message.sourceAccount && (
          <span
            className="px-1.5 py-0.5 rounded text-xs bg-surface-600 text-surface-300 flex-shrink-0"
            title={message.sourceAccount}
          >
            {getAccountLabel(message.sourceAccount)}
          </span>
        )}

        {/* Date */}
        <span className="text-xs text-surface-500 flex-shrink-0">
          {formatDate(message.date)}
        </span>
      </button>

      {/* Message body - only when expanded */}
      {isExpanded && (
        <div className="px-3 pb-3 ml-6">
          {/* Full date + recipients */}
          <div className="text-xs text-surface-500 mb-2 space-y-0.5">
            <div>{formatFullDate(message.date)}</div>
            {message.to.length > 0 && (
              <div>
                <span className="font-medium text-surface-400">To: </span>
                {message.to.join(', ')}
              </div>
            )}
            {message.cc.length > 0 && (
              <div>
                <span className="font-medium text-surface-400">Cc: </span>
                {message.cc.join(', ')}
              </div>
            )}
            {message.folderName && (
              <div>
                <span className="font-medium text-surface-400">
                  フォルダ:{' '}
                </span>
                {message.folderName}
              </div>
            )}
          </div>

          {/* Subject if different from thread subject */}
          {message.subject && (
            <p className="text-xs text-surface-400 mb-1 font-medium">
              {message.subject}
            </p>
          )}

          {/* Body / preview */}
          {message.preview ? (
            <div className="text-sm text-surface-300 whitespace-pre-wrap leading-relaxed">
              {message.preview}
            </div>
          ) : (
            <p className="text-xs text-surface-500 italic">
              本文なし
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function ThreadViewer({
  messages,
  loading,
  onClose,
}: ThreadViewerProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Sort messages chronologically
  const sortedMessages = useMemo(
    () =>
      [...messages].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      ),
    [messages]
  );

  const totalCount = sortedMessages.length;
  const hasMore = visibleCount < totalCount;
  const visibleMessages = sortedMessages.slice(0, visibleCount);

  // Derive thread subject from the first message
  const threadSubject = sortedMessages.length > 0
    ? sortedMessages[0].subject || '(件名なし)'
    : '';

  const toggleMessage = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleToggleAll = () => {
    if (allExpanded) {
      setExpandedIds(new Set());
      setAllExpanded(false);
    } else {
      setExpandedIds(new Set(visibleMessages.map((m) => m.id)));
      setAllExpanded(true);
    }
  };

  const handleLoadMore = () => {
    setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, totalCount));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-surface-700 flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-white truncate">
            {threadSubject}
          </h2>
          <p className="text-xs text-surface-400 mt-0.5">
            {totalCount} 件のメッセージ
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <button
            type="button"
            onClick={handleToggleAll}
            className="px-2 py-1 text-xs text-surface-400 hover:text-surface-200 bg-surface-700 hover:bg-surface-600 rounded transition-colors"
          >
            {allExpanded ? 'すべて折りたたむ' : 'すべて展開'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-xs text-surface-400 hover:text-surface-200 bg-surface-700 hover:bg-surface-600 rounded transition-colors"
              title="閉じる"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <LoadingSkeleton />
        ) : sortedMessages.length === 0 ? (
          <div className="p-4 text-surface-400 text-center text-sm">
            スレッドメッセージはありません
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {visibleMessages.map((msg) => (
              <MessageItem
                key={`${msg.sourceAccount}-${msg.id}`}
                message={msg}
                isExpanded={expandedIds.has(msg.id)}
                onToggle={() => toggleMessage(msg.id)}
              />
            ))}

            {/* Load more pagination */}
            {hasMore && (
              <div className="pt-2 pb-1 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  className="px-4 py-1.5 text-xs text-blue-400 hover:text-blue-300 bg-surface-800 hover:bg-surface-700 border border-surface-600 rounded transition-colors"
                >
                  さらに読み込む（残り {totalCount - visibleCount} 件）
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
