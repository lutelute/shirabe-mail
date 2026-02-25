import { useState, useEffect, useCallback, useRef } from 'react';
import type { Proposal, AnalysisLogEntry } from '../types';
import EmptyState from '../components/shared/EmptyState';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { useAnalysisPrompt } from '../hooks/useAnalysisPrompt';

function formatTimestamp(ts: Date | string): string {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

export default function ProposalView() {
  const analysisPrompt = useAnalysisPrompt();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoIntervalHours, setAutoIntervalHours] = useState(2);
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load saved proposals on mount
  useEffect(() => {
    window.electronAPI.getProposals().then((loaded) => {
      setProposals(loaded);
      if (loaded.length > 0) {
        setSelectedId(loaded[0].id);
      }
    });
  }, []);

  // Listen for progress events
  useEffect(() => {
    const cleanup = window.electronAPI.onClaudeProgress((progress) => {
      setProgressMessage(progress.message);
      if (progress.logEntry) {
        setAnalysisLogs((prev) => [...prev, progress.logEntry!]);
      }
      if (progress.status === 'done' || progress.status === 'error') {
        setRunning(false);
      }
    });
    return cleanup;
  }, []);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [analysisLogs]);

  // Auto-run timer
  useEffect(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    if (autoEnabled) {
      autoTimerRef.current = setInterval(() => {
        if (!running) {
          handleRun();
        }
      }, autoIntervalHours * 60 * 60 * 1000);
    }
    return () => {
      if (autoTimerRef.current) clearInterval(autoTimerRef.current);
    };
  }, [autoEnabled, autoIntervalHours, running]);

  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setProgressMessage('分析を開始しています...');
    setAnalysisLogs([]);
    try {
      const result = await window.electronAPI.runClaudeAnalysis(analysisPrompt, { mode: 'deep' });
      setProposals((prev) => [result, ...prev]);
      setSelectedId(result.id);
    } catch (err) {
      console.error('Claude analysis failed:', err);
    } finally {
      setRunning(false);
    }
  }, [running]);

  const handleDelete = useCallback(async (id: string) => {
    await window.electronAPI.deleteProposal(id);
    setProposals((prev) => prev.filter((p) => p.id !== id));
    if (selectedId === id) {
      setSelectedId(null);
    }
  }, [selectedId]);

  const selected = proposals.find((p) => p.id === selectedId);

  return (
    <div className="h-full flex">
      {/* Left panel - proposal list */}
      <div className="w-80 border-r border-surface-700/50 flex flex-col flex-shrink-0">
        {/* Controls */}
        <div className="p-3 border-b border-surface-700/50 space-y-2">
          <button
            onClick={handleRun}
            disabled={running}
            className={`w-full px-3 py-2 rounded text-sm font-medium transition-colors ${
              running
                ? 'bg-surface-700 text-surface-400 cursor-not-allowed'
                : 'bg-accent-500 hover:bg-accent-600 text-white'
            }`}
          >
            {running ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                分析中...
              </span>
            ) : (
              '分析実行'
            )}
          </button>

          {running && progressMessage && (
            <p className="text-xs text-surface-400 truncate">{progressMessage}</p>
          )}

          {/* Analysis log */}
          {analysisLogs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[9px] text-surface-500">ログ ({analysisLogs.length})</span>
                <button
                  onClick={() => {
                    const text = analysisLogs.map(e => `[${e.time}] [${e.type}] ${e.message}`).join('\n');
                    navigator.clipboard.writeText(text);
                  }}
                  className="text-[9px] text-surface-500 hover:text-surface-200 transition-colors"
                  title="ログをコピー"
                >
                  コピー
                </button>
              </div>
              <div className="max-h-40 overflow-y-auto bg-surface-950 border border-surface-700 rounded p-2 font-mono text-[10px] space-y-0.5">
                {analysisLogs.map((entry, i) => (
                  <div key={i} className={`flex gap-1.5 ${
                    entry.type === 'tool' ? 'text-cyan-400' :
                    entry.type === 'result' ? 'text-emerald-400' :
                    entry.type === 'error' ? 'text-red-400' :
                    entry.type === 'text' ? 'text-surface-500' :
                    'text-surface-400'
                  }`}>
                    <span className="text-surface-600 flex-shrink-0">{entry.time}</span>
                    <span className="truncate">{entry.type === 'tool' ? '\ud83d\udd0d ' : ''}{entry.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}

          {/* Auto-run toggle */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-surface-400 cursor-pointer">
              <input
                type="checkbox"
                checked={autoEnabled}
                onChange={(e) => setAutoEnabled(e.target.checked)}
                className="accent-accent-500"
              />
              自動実行
            </label>
            {autoEnabled && (
              <select
                value={autoIntervalHours}
                onChange={(e) => setAutoIntervalHours(Number(e.target.value))}
                className="bg-surface-800 border border-surface-700 rounded px-1.5 py-0.5 text-xs text-surface-300"
              >
                <option value={1}>1時間毎</option>
                <option value={2}>2時間毎</option>
                <option value={4}>4時間毎</option>
                <option value={8}>8時間毎</option>
              </select>
            )}
          </div>
        </div>

        {/* Proposal list */}
        <div className="flex-1 overflow-y-auto">
          {proposals.length === 0 ? (
            <div className="p-4 text-center text-surface-500 text-sm">
              まだ提案がありません。「分析実行」で開始してください。
            </div>
          ) : (
            proposals.map((p) => {
              const isActive = p.id === selectedId;
              return (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`px-3 py-2.5 border-b border-surface-800 cursor-pointer group transition-colors ${
                    isActive ? 'bg-surface-800' : 'hover:bg-surface-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-surface-400">{formatTimestamp(p.timestamp)}</span>
                    <div className="flex items-center gap-1.5">
                      {p.status === 'error' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">エラー</span>
                      )}
                      {p.status === 'running' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">実行中</span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                        className="opacity-0 group-hover:opacity-100 text-surface-500 hover:text-red-400 transition-all"
                        title="削除"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  <p className="text-sm text-surface-300 mt-1 truncate">
                    {p.status === 'done'
                      ? p.markdown.split('\n').find((l) => l.trim().length > 0 && !l.startsWith('#'))?.trim() || 'メール分析結果'
                      : p.status === 'error'
                        ? p.errorMessage || 'エラーが発生しました'
                        : '分析中...'}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel - markdown preview */}
      <div className="flex-1 overflow-y-auto">
        {selected ? (
          selected.status === 'error' ? (
            <div className="p-6 space-y-4">
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                <h3 className="text-red-400 font-medium text-sm mb-2">分析エラー</h3>
                <p className="text-surface-400 text-sm">{selected.errorMessage}</p>
              </div>
              {selected.markdown && (
                <div className="bg-surface-800/50 border border-surface-700 rounded-lg p-4">
                  <MarkdownRenderer>{selected.markdown}</MarkdownRenderer>
                </div>
              )}
            </div>
          ) : (
            <div className="p-6">
              <MarkdownRenderer>{selected.markdown}</MarkdownRenderer>
            </div>
          )
        ) : (
          <EmptyState
            title="提案を選択してください"
            description="左のリストから提案を選択するか、「分析実行」で新しい分析を開始します"
            icon={
              <svg className="w-12 h-12 text-surface-600 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            }
          />
        )}
      </div>
    </div>
  );
}
