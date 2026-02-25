import { useState, useCallback, useMemo } from 'react';
import { useAppContext } from '../context/AppContext';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import type { AuditResult } from '../types';
import AccountSelector from '../components/AccountSelector';
import EmptyState from '../components/shared/EmptyState';
import { formatDateInput } from '../utils/date';

type ScanStatus = 'idle' | 'running' | 'done' | 'error';

interface ScanState {
  status: ScanStatus;
  percentComplete: number;
  currentMonthLabel: string;
  result: AuditResult | null;
  errorMessage: string | null;
}

function estimateCostUsd(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 30))) * 0.05;
}

function totalMonths(startDate: string, endDate: string): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);
}

function formatMonthLabel(monthIndex: number, startDate: string): string {
  const d = new Date(startDate);
  d.setMonth(d.getMonth() + monthIndex);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function ActivityChart({ data }: { data: { month: string; count: number; summary: string }[] }) {
  const maxCount = useMemo(() => Math.max(1, ...data.map((d) => d.count)), [data]);
  if (data.length === 0) return <div className="text-sm text-surface-500 py-2">月別アクティビティデータがありません</div>;
  return (
    <div className="space-y-1.5">
      {data.map((item) => (
        <div key={item.month} className="flex items-center gap-2 group">
          <span className="text-xs text-surface-400 w-16 flex-shrink-0 text-right">{item.month}</span>
          <div className="flex-1 h-5 bg-surface-800 rounded overflow-hidden">
            <div className="h-full bg-blue-500/60 rounded transition-all" style={{ width: `${(item.count / maxCount) * 100}%` }} />
          </div>
          <span className="text-xs text-surface-400 w-10 flex-shrink-0">{item.count}件</span>
          <span className="text-xs text-surface-500 truncate max-w-[200px] hidden group-hover:inline">{item.summary}</span>
        </div>
      ))}
    </div>
  );
}

export default function AuditView() {
  const { accounts, settings } = useAppContext();

  const [selectedAccount, setSelectedAccount] = useState('all');
  const defaultStart = useMemo(() => { const d = new Date(); d.setFullYear(d.getFullYear() - 2); return formatDateInput(d); }, []);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(() => formatDateInput(new Date()));
  const [topic, setTopic] = useState('');
  const [scanState, setScanState] = useState<ScanState>({ status: 'idle', percentComplete: 0, currentMonthLabel: '', result: null, errorMessage: null });
  const [confirmedThreads, setConfirmedThreads] = useState<Set<number>>(new Set());

  const { loading, error, costUsd, runHistoricalAudit, cancel } = useClaudeAgent(settings.apiKey);
  const isAgentAvailable = settings.agentEnabled && !!settings.apiKey;
  const estimatedCost = useMemo(() => estimateCostUsd(startDate, endDate), [startDate, endDate]);
  const overBudget = estimatedCost > settings.maxBudgetUsd;
  const months = useMemo(() => totalMonths(startDate, endDate), [startDate, endDate]);

  const auditAccountEmail = useMemo(() => {
    if (selectedAccount !== 'all') return selectedAccount;
    return accounts.length > 0 ? accounts[0].email : '';
  }, [selectedAccount, accounts]);

  const handleStartScan = useCallback(async () => {
    if (!auditAccountEmail) return;
    setScanState({ status: 'running', percentComplete: 0, currentMonthLabel: formatMonthLabel(0, startDate), result: null, errorMessage: null });
    setConfirmedThreads(new Set());

    let monthIndex = 0;
    const progressInterval = setInterval(() => {
      monthIndex += 1;
      if (monthIndex >= months) { clearInterval(progressInterval); return; }
      setScanState((prev) => {
        if (prev.status !== 'running') return prev;
        return { ...prev, percentComplete: Math.min(95, Math.round((monthIndex / months) * 100)), currentMonthLabel: formatMonthLabel(monthIndex, startDate) };
      });
    }, 800);

    try {
      const result = await runHistoricalAudit({
        accountEmail: auditAccountEmail, startDate: new Date(startDate), endDate: new Date(endDate),
        topic: topic || undefined, apiKey: settings.apiKey,
      });
      clearInterval(progressInterval);
      setScanState({ status: 'done', percentComplete: 100, currentMonthLabel: '', result, errorMessage: null });
    } catch (err) {
      clearInterval(progressInterval);
      setScanState((prev) => ({ ...prev, status: 'error', errorMessage: err instanceof Error ? err.message : String(err) }));
    }
  }, [auditAccountEmail, startDate, endDate, topic, months, settings.apiKey, runHistoricalAudit]);

  const handleCancel = useCallback(async () => {
    await cancel();
    setScanState((prev) => ({ ...prev, status: 'idle', percentComplete: 0, currentMonthLabel: '' }));
  }, [cancel]);

  const toggleConfirmedThread = useCallback((threadId: number) => {
    setConfirmedThreads((prev) => { const next = new Set(prev); if (next.has(threadId)) next.delete(threadId); else next.add(threadId); return next; });
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {overBudget && (
        <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 flex items-center gap-2">
          <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm text-red-400">推定コスト (${estimatedCost.toFixed(2)}) が予算上限 (${settings.maxBudgetUsd.toFixed(2)}) を超えています</span>
        </div>
      )}

      <div className="p-3 border-b border-surface-700 space-y-3">
        <h2 className="text-base font-semibold">監査スキャン</h2>
        <div>
          <label className="block text-xs text-surface-400 mb-1">アカウント</label>
          <AccountSelector accounts={accounts} selected={selectedAccount} onSelect={setSelectedAccount} />
        </div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs text-surface-400 mb-1">開始日</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              disabled={scanState.status === 'running'}
              className="w-full bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-surface-400 mb-1">終了日</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              disabled={scanState.status === 'running'}
              className="w-full bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-surface-400 mb-1">トピック / キーワード（任意）</label>
          <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
            disabled={scanState.status === 'running'} placeholder="例: 予算, 報告書..."
            className="w-full bg-surface-800 border border-surface-600 rounded px-2 py-1 text-sm text-white placeholder-surface-500 focus:outline-none focus:border-blue-500 disabled:opacity-50" />
        </div>
        <div className="flex items-center justify-between text-xs text-surface-400">
          <span>対象期間: {months}ヶ月</span>
          <span>推定コスト: <span className={overBudget ? 'text-red-400 font-medium' : 'text-surface-300'}>${estimatedCost.toFixed(2)}</span>
            {costUsd > 0 && <span className="ml-2 text-surface-500">(実績: ${costUsd.toFixed(4)})</span>}
          </span>
        </div>
        {!isAgentAvailable && <p className="text-xs text-yellow-400">AI未設定: 設定画面でAPIキーを入力し、エージェントを有効にしてください</p>}
      </div>

      <div className="p-3 border-b border-surface-700">
        <div className="flex items-center gap-2">
          {scanState.status !== 'running' ? (
            <button onClick={handleStartScan}
              disabled={!isAgentAvailable || !auditAccountEmail || loading || overBudget}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {scanState.status === 'done' ? '再スキャン' : 'スキャン開始'}
            </button>
          ) : (
            <button onClick={handleCancel} className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded transition-colors">キャンセル</button>
          )}
          {scanState.status === 'running' && <span className="text-xs text-surface-400 animate-pulse">{scanState.currentMonthLabel}を分析中...</span>}
          {scanState.status === 'done' && <span className="text-xs text-green-400">スキャン完了</span>}
          {scanState.status === 'error' && <span className="text-xs text-red-400">エラー: {scanState.errorMessage || error || '不明なエラー'}</span>}
        </div>
        {scanState.status === 'running' && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-xs text-surface-400 mb-1">
              <span>{scanState.currentMonthLabel}</span><span>{scanState.percentComplete}%</span>
            </div>
            <div className="w-full h-2 bg-surface-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${scanState.percentComplete}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {scanState.status === 'idle' ? (
          <EmptyState title="期間とアカウントを選択してスキャンを開始してください"
            description="過去のメール履歴を分析し、活動パターンや重要スレッドを発見します"
            icon={<svg className="w-12 h-12 text-surface-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>} />
        ) : scanState.status === 'running' ? (
          <div className="p-4 space-y-4 animate-pulse">
            <div className="h-5 bg-surface-700 rounded w-1/4" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2"><div className="h-4 bg-surface-700 rounded w-16" /><div className="h-5 bg-surface-700 rounded flex-1" /></div>
            ))}
          </div>
        ) : scanState.result ? (
          <div>
            <div className="p-3 border-b border-surface-700">
              <h3 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">月別アクティビティ</h3>
              <ActivityChart data={scanState.result.monthlyActivity} />
            </div>
            <div className="p-3 border-b border-surface-700">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-surface-300 uppercase tracking-wider">主要スレッド</h3>
                {scanState.result.keyThreads.length > 0 && (
                  <span className="text-xs text-surface-400">確認済み: {confirmedThreads.size}/{scanState.result.keyThreads.length}</span>
                )}
              </div>
              {scanState.result.keyThreads.length === 0 ? (
                <div className="text-sm text-surface-500 py-2">重要なスレッドは見つかりませんでした</div>
              ) : (
                <div className="border border-surface-700 rounded overflow-hidden">
                  {scanState.result.keyThreads.map((thread) => (
                    <div key={thread.threadId} className={`px-3 py-2 border-b border-surface-700 last:border-b-0 flex items-start gap-2 ${confirmedThreads.has(thread.threadId) ? 'opacity-60' : ''}`}>
                      <button onClick={() => toggleConfirmedThread(thread.threadId)}
                        className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                          confirmedThreads.has(thread.threadId) ? 'bg-blue-500 border-blue-500' : 'border-surface-500 hover:border-surface-400'
                        }`}>
                        {confirmedThreads.has(thread.threadId) && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <span className={`text-sm ${confirmedThreads.has(thread.threadId) ? 'line-through text-surface-500' : 'text-white'}`}>
                          {thread.subject || '(件名なし)'}
                        </span>
                        <div className="flex items-center gap-2 text-xs text-surface-400 mt-0.5">
                          <span>{thread.dateRange}</span>
                          <span className="bg-surface-700 px-1.5 py-0.5 rounded">{thread.messageCount}通</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {scanState.result.findings.length > 0 && (
              <div className="p-3">
                <h3 className="text-xs font-semibold text-surface-300 uppercase tracking-wider mb-2">発見事項</h3>
                <div className="space-y-1.5">
                  {scanState.result.findings.map((finding, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-sm text-surface-300">
                      <span className="text-blue-400 flex-shrink-0 mt-0.5">&bull;</span>
                      <span>{finding}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {costUsd > 0 && (
              <div className="p-3 border-t border-surface-700">
                <div className="text-xs text-surface-500">スキャンコスト: ${costUsd.toFixed(4)}</div>
              </div>
            )}
          </div>
        ) : scanState.status === 'error' ? (
          <EmptyState title="スキャンに失敗しました"
            description={scanState.errorMessage || error || 'ネットワークやAPIキーを確認してください'}
            icon={<svg className="w-10 h-10 text-red-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>} />
        ) : null}
      </div>
    </div>
  );
}
