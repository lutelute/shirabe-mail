import { useState, useCallback, useMemo, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useMailData } from '../hooks/useMailData';
import { useJunkDetection } from '../hooks/useJunkDetection';
import type { MailItem, MoveToTrashResult, JunkColumnId, JunkColumnDef, ThreadMessage } from '../types';
import { JUNK_COLUMN_OPTIONS } from '../types';
import AccountSelector from '../components/AccountSelector';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';
import { formatDate } from '../utils/date';

type FilterMode = 'all' | 'junk' | 'safe';

// ─── Column config popover ───────────────────────────────
function ColumnConfigPopover({
  columns,
  onChange,
  onClose,
}: {
  columns: JunkColumnId[];
  onChange: (cols: JunkColumnId[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<JunkColumnId[]>([...columns]);

  const toggle = (id: JunkColumnId) =>
    setDraft((p) => (p.includes(id) ? p.filter((c) => c !== id) : [...p, id]));

  const move = (idx: number, dir: -1 | 1) => {
    const t = idx + dir;
    if (t < 0 || t >= draft.length) return;
    setDraft((p) => {
      const n = [...p];
      [n[idx], n[t]] = [n[t], n[idx]];
      return n;
    });
  };

  return (
    <div className="absolute right-0 top-full mt-1 z-20 bg-surface-800 border border-surface-600 rounded shadow-xl p-2 w-52">
      <div className="text-[10px] text-surface-400 mb-1 font-medium uppercase tracking-wide">カラム設定</div>
      {JUNK_COLUMN_OPTIONS.map((col) => {
        const on = draft.includes(col.id);
        const idx = draft.indexOf(col.id);
        return (
          <div key={col.id} className="flex items-center gap-1 py-0.5">
            <input type="checkbox" checked={on} onChange={() => toggle(col.id)}
              className="w-3 h-3 rounded-sm border-surface-600 bg-surface-700 text-blue-500 focus:ring-0" />
            <span className="text-xs text-surface-300 flex-1">{col.label}</span>
            {on && (
              <div className="flex gap-px">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="text-[10px] text-surface-400 hover:text-white disabled:opacity-20 px-0.5">↑</button>
                <button onClick={() => move(idx, 1)} disabled={idx === draft.length - 1}
                  className="text-[10px] text-surface-400 hover:text-white disabled:opacity-20 px-0.5">↓</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex justify-end gap-1 mt-1.5 pt-1 border-t border-surface-700">
        <button onClick={onClose} className="px-2 py-0.5 text-[10px] text-surface-400 hover:text-white">戻る</button>
        <button onClick={() => { onChange(draft); onClose(); }}
          className="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-500">適用</button>
      </div>
    </div>
  );
}

// ─── Cell renderer ───────────────────────────────────────
function CellContent({ colId, mail, confidence, isJunk }: {
  colId: JunkColumnId; mail: MailItem; confidence: number | null; isJunk: boolean | null;
}) {
  switch (colId) {
    case 'from':
      return <span className="text-[11px] text-surface-300 truncate">{mail.from ? mail.from.displayName || mail.from.address.split('@')[0] : ''}</span>;
    case 'subject':
      return <span className={`text-[11px] truncate ${mail.isRead ? 'text-surface-400' : 'text-white font-medium'}`}>{mail.subject || '(件名なし)'}</span>;
    case 'date':
      return <span className="text-[10px] text-surface-500 whitespace-nowrap">{formatDate(mail.date)}</span>;
    case 'attachment':
      return <span className="text-[10px] text-surface-500 text-center">{(mail.flags & 256) !== 0 ? '📎' : ''}</span>;
    case 'confidence':
      return confidence !== null ? <span className="text-[10px] text-surface-500 text-right tabular-nums">{Math.round(confidence * 100)}%</span> : <span />;
    case 'verdict':
      return isJunk !== null ? (
        <span className={`px-1 py-px rounded text-[10px] font-medium leading-tight ${isJunk ? 'bg-orange-500/20 text-orange-400' : 'bg-green-500/20 text-green-400'}`}>
          {isJunk ? 'J' : 'S'}
        </span>
      ) : <span />;
    default: return null;
  }
}

function colStyle(def: JunkColumnDef): React.CSSProperties {
  if (def.width.includes(' ')) {
    const [grow, shrink, basis] = def.width.split(' ');
    return { flex: `${grow} ${shrink} ${basis}`, minWidth: 0 };
  }
  return { width: def.width, flexShrink: 0 };
}

// ─── Thread message component ────────────────────────────
function ThreadMessageItem({ msg, isLast }: { msg: ThreadMessage; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`px-3 py-1.5 ${!isLast ? 'border-b border-surface-700/50' : ''}`}>
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <span className={`text-[10px] ${msg.isSentByMe ? 'text-blue-400' : 'text-surface-400'}`}>
          {msg.isSentByMe ? '→ 自分' : msg.from.split('<')[0].trim() || msg.from}
        </span>
        <span className="text-[10px] text-surface-600 flex-shrink-0">
          {msg.date instanceof Date ? formatDate(msg.date) : ''}
        </span>
        <span className="text-[10px] text-surface-600 ml-auto">{expanded ? '▾' : '▸'}</span>
      </div>
      {!expanded && (
        <p className="text-[11px] text-surface-400 truncate mt-0.5">{msg.preview}</p>
      )}
      {expanded && (
        <div className="mt-1">
          <div className="text-[10px] text-surface-500 mb-0.5">
            To: {msg.to.join(', ')}{msg.cc.length > 0 ? ` | Cc: ${msg.cc.join(', ')}` : ''}
          </div>
          <p className="text-xs text-surface-300 whitespace-pre-wrap leading-relaxed">{msg.preview}</p>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════
export default function JunkView() {
  const { selectedAccounts, settings, settingsLoaded, saveSettings } = useAppContext();
  const { mails, loading: mailsLoading, fetchMails } = useMailData();
  const { results: junkResults, loading: junkLoading, error, detectJunk } = useJunkDetection(settings.apiKey);

  const [selectedMail, setSelectedMail] = useState<MailItem | null>(null);
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [selectedForTrash, setSelectedForTrash] = useState<Set<number>>(new Set());
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveResults, setMoveResults] = useState<MoveToTrashResult[] | null>(null);
  const [showColConfig, setShowColConfig] = useState(false);

  // Thread
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const activeColumns: JunkColumnId[] = settings.junkColumns ?? ['from', 'subject', 'date', 'confidence', 'verdict'];
  const colDefs = useMemo(() => {
    const map = new Map(JUNK_COLUMN_OPTIONS.map((c) => [c.id, c]));
    return activeColumns.map((id) => map.get(id)!).filter(Boolean);
  }, [activeColumns]);

  const handleColumnsChange = (cols: JunkColumnId[]) => {
    saveSettings({ ...settings, junkColumns: cols });
  };

  useEffect(() => {
    if (settingsLoaded && selectedAccounts.length > 0) {
      fetchMails(selectedAccounts.map((a) => a.email), settings.mailDaysBack, settings.excludeSpam);
    }
  }, [settingsLoaded, selectedAccounts, settings.mailDaysBack, settings.excludeSpam, fetchMails]);

  // Load thread when selecting a mail
  useEffect(() => {
    if (!selectedMail) { setThreadMessages([]); return; }
    let cancelled = false;
    setThreadLoading(true);
    window.electronAPI.getThreadMessages(selectedMail.id, selectedMail.accountEmail)
      .then((msgs) => { if (!cancelled) setThreadMessages(msgs); })
      .catch(() => { if (!cancelled) setThreadMessages([]); })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
  }, [selectedMail]);

  const junkMap = useMemo(() => new Map(junkResults.map((r) => [r.mailId, r])), [junkResults]);

  const filteredMails = useMemo(() => {
    let base = selectedAccount === 'all' ? mails : mails.filter((m) => m.accountEmail === selectedAccount);
    if (junkResults.length > 0 && filterMode !== 'all') {
      base = base.filter((m) => {
        const j = junkMap.get(m.id);
        if (filterMode === 'junk') return j?.isJunk;
        return !j?.isJunk;
      });
    }
    return base;
  }, [mails, selectedAccount, junkResults, filterMode, junkMap]);

  // Detect junk — only for the selected account
  const handleDetect = useCallback(async () => {
    const target = selectedAccount === 'all'
      ? mails
      : mails.filter((m) => m.accountEmail === selectedAccount);
    await detectJunk(target);
    setSelectedForTrash(new Set());
    setMoveResults(null);
  }, [mails, selectedAccount, detectJunk]);

  const junkCount = junkResults.filter((r) => r.isJunk).length;
  const safeCount = junkResults.filter((r) => !r.isJunk).length;

  const toggleTrashSelection = (mailId: number) => {
    setSelectedForTrash((prev) => {
      const next = new Set(prev);
      if (next.has(mailId)) next.delete(mailId); else next.add(mailId);
      return next;
    });
  };

  const selectAllJunk = () =>
    setSelectedForTrash(new Set(junkResults.filter((r) => r.isJunk).map((r) => r.mailId)));

  const handleMoveToTrash = useCallback(async () => {
    if (selectedForTrash.size === 0) return;
    const byAccount = new Map<string, number[]>();
    for (const mailId of selectedForTrash) {
      const mail = mails.find((m) => m.id === mailId);
      if (!mail) continue;
      const list = byAccount.get(mail.accountEmail) || [];
      list.push(mailId);
      byAccount.set(mail.accountEmail, list);
    }
    setMoveLoading(true);
    setMoveResults(null);
    const allResults: MoveToTrashResult[] = [];
    for (const [acct, ids] of byAccount) {
      try { allResults.push(...await window.electronAPI.moveToTrash(ids, acct)); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allResults.push(...ids.map((id) => ({ mailId: id, success: false, error: msg })));
      }
    }
    setMoveResults(allResults);
    setMoveLoading(false);
    const ok = new Set(allResults.filter((r) => r.success).map((r) => r.mailId));
    setSelectedForTrash((prev) => { const n = new Set(prev); for (const id of ok) n.delete(id); return n; });
  }, [selectedForTrash, mails]);

  const hasImapConfig = settings.imapConfigs.some((c) => c.credentials !== null);
  const loading = mailsLoading || junkLoading;

  // Detect label based on selected account
  const detectLabel = selectedAccount === 'all'
    ? `全アカウント検出`
    : `検出 (${selectedAccount.split('@')[0]})`;

  return (
    <div className="flex h-full">
      {/* ─── Left: Mail list ─── */}
      <div className="w-3/5 flex flex-col border-r border-surface-700">
        {/* Toolbar */}
        <div className="p-2 border-b border-surface-700">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">ゴミメール検出</h2>
              {junkResults.length > 0 && (
                <span className="text-[10px] bg-orange-500 text-white px-1.5 py-0.5 rounded-full">{junkCount}</span>
              )}
            </div>
            <button
              onClick={handleDetect}
              disabled={loading || mails.length === 0}
              className="px-2.5 py-0.5 text-xs bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {junkLoading ? '検出中...' : detectLabel}
            </button>
          </div>

          <AccountSelector accounts={selectedAccounts} selected={selectedAccount} onSelect={setSelectedAccount} />

          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {junkResults.length > 0 && (['all', 'junk', 'safe'] as FilterMode[]).map((mode) => (
              <button key={mode} onClick={() => setFilterMode(mode)}
                className={`px-1.5 py-px text-[10px] rounded transition-colors ${
                  filterMode === mode
                    ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                    : 'bg-surface-700 text-surface-400 hover:bg-surface-600 border border-transparent'
                }`}>
                {mode === 'all' ? '全て' : mode === 'junk' ? `Junk(${junkCount})` : `Safe(${safeCount})`}
              </button>
            ))}
            {junkResults.length > 0 && (
              <>
                <button onClick={selectAllJunk} className="px-1.5 py-px text-[10px] bg-surface-700 text-surface-400 hover:bg-surface-600 rounded">全選択</button>
                {selectedForTrash.size > 0 && (
                  <button onClick={handleMoveToTrash} disabled={moveLoading || !hasImapConfig}
                    title={!hasImapConfig ? 'IMAP未設定' : ''}
                    className="px-1.5 py-px text-[10px] bg-red-600 hover:bg-red-500 text-white rounded disabled:opacity-50">
                    {moveLoading ? '移動中...' : `削除(${selectedForTrash.size})`}
                  </button>
                )}
              </>
            )}
          </div>
          {!settings.apiKey && <p className="text-[10px] text-surface-500 mt-1">キーワード検出モード</p>}
          {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
          {moveResults && (() => {
            const ok = moveResults.filter((r) => r.success).length;
            const ng = moveResults.filter((r) => !r.success).length;
            return <p className={`text-[10px] mt-1 ${ng ? 'text-yellow-400' : 'text-green-400'}`}>{ok}件完了{ng ? ` / ${ng}件失敗` : ''}</p>;
          })()}
        </div>

        {/* Column header */}
        <div className="flex items-center gap-px px-2 py-0.5 border-b border-surface-600 bg-surface-850 text-[10px] text-surface-500 uppercase tracking-wider select-none relative">
          {junkResults.length > 0 && <div className="w-4 flex-shrink-0" />}
          {junkResults.length > 0 && <div className="w-2 flex-shrink-0" />}
          {colDefs.map((def) => (
            <div key={def.id} style={colStyle(def)} className="truncate px-0.5">{def.label}</div>
          ))}
          <button onClick={() => setShowColConfig((v) => !v)}
            className="ml-auto flex-shrink-0 text-surface-500 hover:text-surface-200" title="カラム設定">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </button>
          {showColConfig && <ColumnConfigPopover columns={activeColumns} onChange={handleColumnsChange} onClose={() => setShowColConfig(false)} />}
        </div>

        {/* Mail rows */}
        <div className="flex-1 overflow-y-auto">
          {mailsLoading ? <LoadingSkeleton rows={12} /> : filteredMails.length === 0 ? <EmptyState title="メールはありません" /> : (
            filteredMails.map((mail) => {
              const junk = junkMap.get(mail.id);
              const isSelected = selectedMail?.id === mail.id;
              const isChecked = selectedForTrash.has(mail.id);
              return (
                <div key={`${mail.accountEmail}-${mail.id}`} onClick={() => setSelectedMail(mail)}
                  className={`flex items-center gap-px px-2 py-px border-b border-surface-700/40 cursor-pointer transition-colors h-[22px] ${
                    isSelected ? 'bg-surface-600/80 border-l-2 border-l-orange-500' : 'hover:bg-surface-700/40'
                  }`}>
                  {junkResults.length > 0 && (
                    <div className="w-4 flex-shrink-0 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleTrashSelection(mail.id)}
                        className="w-3 h-3 rounded-sm border-surface-600 bg-surface-700 text-orange-500 focus:ring-0" />
                    </div>
                  )}
                  {junkResults.length > 0 && (
                    <div className="w-2 flex-shrink-0 flex items-center justify-center">
                      {junk && <span className={`inline-block w-1.5 h-1.5 rounded-full ${junk.isJunk ? 'bg-orange-500' : 'bg-green-500'}`} />}
                    </div>
                  )}
                  {colDefs.map((def) => (
                    <div key={def.id} style={colStyle(def)} className="truncate px-0.5 flex items-center">
                      <CellContent colId={def.id} mail={mail} confidence={junk?.confidence ?? null} isJunk={junk?.isJunk ?? null} />
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ─── Right: Detail + Thread ─── */}
      <div className="w-2/5 flex flex-col">
        {selectedMail ? (
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="p-2 border-b border-surface-700">
              <h3 className="text-sm font-semibold text-white leading-tight">{selectedMail.subject || '(件名なし)'}</h3>
              <div className="flex items-center gap-2 text-xs text-surface-400 mt-0.5">
                <span>{selectedMail.from ? selectedMail.from.displayName || selectedMail.from.address : '不明'}</span>
                <span className="flex-shrink-0">{formatDate(selectedMail.date)}</span>
              </div>
              {(() => {
                const junk = junkMap.get(selectedMail.id);
                if (!junk) return null;
                return (
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${junk.isJunk ? 'bg-orange-500/20 text-orange-400' : 'bg-green-500/20 text-green-400'}`}>
                      {junk.isJunk ? 'Junk' : 'Safe'}
                    </span>
                    <span className="text-xs text-surface-400">{Math.round(junk.confidence * 100)}%</span>
                    {junk.detectedPatterns.length > 0 && (
                      <span className="text-[10px] text-surface-500 truncate">{junk.detectedPatterns.slice(0, 3).join(', ')}</span>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Thread messages */}
            <div className="flex-1 overflow-y-auto">
              {threadLoading ? (
                <div className="p-3 text-xs text-surface-500">スレッド読込中...</div>
              ) : threadMessages.length > 1 ? (
                <div>
                  <div className="px-3 py-1 bg-surface-850 border-b border-surface-700">
                    <span className="text-[10px] text-surface-400 uppercase tracking-wide font-medium">
                      スレッド ({threadMessages.length}件)
                    </span>
                  </div>
                  {threadMessages.map((msg, i) => (
                    <ThreadMessageItem key={msg.id} msg={msg} isLast={i === threadMessages.length - 1} />
                  ))}
                </div>
              ) : (
                /* Single mail — no thread */
                <div className="p-3">
                  {selectedMail.to && selectedMail.to.length > 0 && (
                    <div className="mb-2 text-xs text-surface-400">
                      <span className="font-medium text-surface-300">To: </span>
                      {selectedMail.to.map((addr) => addr.displayName || addr.address).join(', ')}
                    </div>
                  )}
                  <div className="text-xs text-surface-300 whitespace-pre-wrap leading-relaxed">{selectedMail.preview}</div>
                </div>
              )}

              {/* Junk detection details */}
              {(() => {
                const junk = junkMap.get(selectedMail.id);
                if (!junk) return null;
                return (
                  <div className="mx-3 mb-3 p-2 bg-surface-800 rounded border border-surface-700">
                    <p className="text-[10px] text-surface-400 mb-0.5 font-medium">検出理由:</p>
                    <p className="text-xs text-surface-300">{junk.reasoning}</p>
                    {junk.detectedPatterns.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {junk.detectedPatterns.map((p, i) => (
                          <span key={i} className="px-1.5 py-0.5 text-[10px] bg-surface-700 text-surface-400 rounded">{p}</span>
                        ))}
                      </div>
                    )}
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
