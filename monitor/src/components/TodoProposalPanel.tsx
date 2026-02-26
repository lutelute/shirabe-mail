import { useState, useEffect, useCallback, useRef } from 'react';
import type { Proposal, SkillSummary, ViewType, AccountConfig, AnalysisLogEntry } from '../types';
import { useAnalysisPrompt } from '../hooks/useAnalysisPrompt';
import { useAnalysisProgress } from '../hooks/useAnalysisProgress';
import MarkdownRenderer from './MarkdownRenderer';

function formatTimestamp(ts: Date | string): string {
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

type TabMode = 'proposal' | 'skills';

interface SkillCategory {
  icon: string;
  color: string;
}

function getSkillCategory(name: string): SkillCategory {
  const n = name.toLowerCase();
  if (n.includes('mail') || n.includes('email') || n.includes('triage'))
    return { icon: '\u2709', color: '#3b82f6' }; // envelope
  if (n.includes('todo') || n.includes('task'))
    return { icon: '\u2611', color: '#22c55e' }; // checkbox
  if (n.includes('code') || n.includes('refactor') || n.includes('electron') || n.includes('mcp'))
    return { icon: '\u2699', color: '#a855f7' }; // gear
  if (n.includes('paper') || n.includes('research') || n.includes('literature') || n.includes('review'))
    return { icon: '\ud83d\udcdd', color: '#f59e0b' }; // memo
  if (n.includes('lecture') || n.includes('pandapower'))
    return { icon: '\ud83c\udf93', color: '#06b6d4' }; // graduation cap
  if (n.includes('briefing') || n.includes('imakoko') || n.includes('handover') || n.includes('daily'))
    return { icon: '\u2600', color: '#f97316' }; // sun
  if (n.includes('fact') || n.includes('audit') || n.includes('historical'))
    return { icon: '\ud83d\udd0d', color: '#ef4444' }; // magnifying glass
  if (n.includes('project') || n.includes('context'))
    return { icon: '\ud83d\udcc1', color: '#8b5cf6' }; // folder
  if (n.includes('doc') || n.includes('slide') || n.includes('pptx') || n.includes('xlsx') || n.includes('pdf'))
    return { icon: '\ud83d\udcc4', color: '#10b981' }; // page
  if (n.includes('design') || n.includes('art') || n.includes('canvas') || n.includes('frontend') || n.includes('theme') || n.includes('brand'))
    return { icon: '\ud83c\udfa8', color: '#ec4899' }; // palette
  if (n.includes('git') || n.includes('worktree'))
    return { icon: '\ud83d\udd00', color: '#f43f5e' }; // shuffle
  if (n.includes('chat') || n.includes('slack') || n.includes('comms'))
    return { icon: '\ud83d\udcac', color: '#6366f1' }; // speech bubble
  if (n.includes('web') || n.includes('webapp') || n.includes('artifact'))
    return { icon: '\ud83c\udf10', color: '#0ea5e9' }; // globe
  return { icon: '\u2726', color: '#64748b' }; // sparkle default
}

interface Props {
  onNavigate: (view: ViewType) => void;
  refreshTrigger?: number;
}

export default function TodoProposalPanel({ onNavigate, refreshTrigger }: Props) {
  const analysisPrompt = useAnalysisPrompt();
  const [tab, setTab] = useState<TabMode>('proposal');

  // --- Proposal state ---
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const { percent, phaseLabel } = useAnalysisProgress(analysisLogs, running);

  // --- Account selection for analysis ---
  const [accounts, setAccounts] = useState<AccountConfig[]>([]);
  const [analysisAccount, setAnalysisAccount] = useState('all');

  // --- Skills state ---
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState('');
  const [skillEditing, setSkillEditing] = useState(false);
  const [skillDraft, setSkillDraft] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);

  // Load proposals and accounts (re-fetch when refreshTrigger changes)
  useEffect(() => {
    window.electronAPI.getProposals().then(setProposals);
    window.electronAPI.getAccounts().then(setAccounts);
  }, [refreshTrigger]);

  // Listen for progress
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

  // Load skills (filter to work/email management related only)
  useEffect(() => {
    const WORK_KEYWORDS = [
      'mail', 'email', 'triage', 'todo', 'task', 'briefing', 'daily',
      'handover', 'imakoko', 'routine', 'work', 'folder', 'audit',
      'historical', 'project', 'context', 'fact',
    ];
    window.electronAPI.getSkills().then((all) => {
      const filtered = all.filter((s) => {
        const n = s.name.toLowerCase();
        return WORK_KEYWORDS.some((kw) => n.includes(kw));
      });
      setSkills(filtered);
    });
  }, []);

  // Load skill content when selected
  useEffect(() => {
    if (!selectedSkill) {
      setSkillContent('');
      setSkillEditing(false);
      return;
    }
    window.electronAPI.getSkillContent(selectedSkill).then((content) => {
      setSkillContent(content);
      setSkillDraft(content);
      setSkillEditing(false);
    });
  }, [selectedSkill]);

  const handleRun = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setProgressMessage('分析を開始しています...');
    setAnalysisLogs([]);
    try {
      // Add account filter to prompt if specific account selected
      const accountFilter = analysisAccount !== 'all'
        ? `\n\n**重要**: アカウント「${analysisAccount}」のメールのみ分析してください。get_unread_mails や get_recent_mails の account パラメータに「${analysisAccount}」を指定してください。\n`
        : '';

      // Inject past investigation context
      let investigationContext = '';
      try {
        const investigations = await window.electronAPI.getInvestigations();
        const recentInvs = investigations
          .filter((inv) => inv.status === 'done' && inv.resultProposalId)
          .slice(0, 5);
        if (recentInvs.length > 0) {
          investigationContext = '\n\n## 過去の調査結果（参考にしてください）\n';
          for (const inv of recentInvs) {
            investigationContext += `\n### ${inv.subject}\n`;
            investigationContext += `- 日時: ${inv.createdAt}\n`;
            if (inv.userMessage) investigationContext += `- 調査指示: ${inv.userMessage}\n`;
            investigationContext += `- 結果ID: ${inv.resultProposalId}\n`;
          }
        }
      } catch {
        // investigations not available, skip
      }

      const result = await window.electronAPI.runClaudeAnalysis(
        analysisPrompt + accountFilter + investigationContext,
        { mode: 'deep' },
      );
      setProposals((prev) => [result, ...prev]);
      setCurrentIndex(0);
      setTab('proposal');
    } catch (err) {
      console.error('Claude analysis failed:', err);
    } finally {
      setRunning(false);
    }
  }, [running, analysisPrompt, analysisAccount]);

  const handleSaveSkill = useCallback(async () => {
    if (!selectedSkill || skillSaving) return;
    setSkillSaving(true);
    try {
      await window.electronAPI.saveSkillContent(selectedSkill, skillDraft);
      setSkillContent(skillDraft);
      setSkillEditing(false);
    } catch (err) {
      console.error('Failed to save skill:', err);
    } finally {
      setSkillSaving(false);
    }
  }, [selectedSkill, skillDraft, skillSaving]);

  const current = proposals[currentIndex] ?? null;
  const hasPrev = currentIndex < proposals.length - 1;
  const hasNext = currentIndex > 0;

  const handleExport = useCallback(async () => {
    if (!current?.markdown) return;
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const filename = `mail-analysis-${dateStr}.md`;
    await window.electronAPI.exportAnalysis(current.markdown, filename);
  }, [current]);

  return (
    <div className="flex flex-col h-full">
      {/* Tab header */}
      <div className="flex items-center border-b border-surface-700/50 bg-surface-900/50">
        <button
          onClick={() => setTab('proposal')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'proposal'
              ? 'text-accent-400 border-b-2 border-accent-400'
              : 'text-surface-400 hover:text-surface-200'
          }`}
        >
          TODO提案
        </button>
        <button
          onClick={() => setTab('skills')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'skills'
              ? 'text-accent-400 border-b-2 border-accent-400'
              : 'text-surface-400 hover:text-surface-200'
          }`}
        >
          Skills
        </button>
        <button
          onClick={() => onNavigate('proposal')}
          className="px-2 py-2 text-[10px] text-surface-500 hover:text-accent-400 transition-colors"
          title="全画面で見る"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
      </div>

      {tab === 'proposal' ? (
        <>
          {/* Proposal controls */}
          <div className="p-3 border-b border-surface-700/50 bg-surface-900/50 space-y-2">
            {/* Account selector + run button */}
            <div className="flex items-center gap-1.5">
              <select
                value={analysisAccount}
                onChange={(e) => setAnalysisAccount(e.target.value)}
                className="flex-1 bg-surface-800 border border-surface-600 rounded text-[10px] text-surface-300 px-1.5 py-1 focus:outline-none focus:border-accent-500/50"
              >
                <option value="all">全アカウント</option>
                {accounts.map((a) => (
                  <option key={a.email} value={a.email}>{a.label || a.email}</option>
                ))}
              </select>
              <button
                onClick={handleRun}
                disabled={running}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors flex-shrink-0 ${
                  running
                    ? 'bg-surface-700 text-surface-400 cursor-not-allowed'
                    : 'bg-accent-500 hover:bg-accent-600 text-white'
                }`}
              >
                {running ? (
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    分析中
                  </span>
                ) : (
                  '分析実行'
                )}
              </button>
            </div>

            {running && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-surface-400">{phaseLabel || progressMessage}</span>
                  <span className="text-[10px] text-surface-500">{percent}%</span>
                </div>
                <div className="w-full h-1.5 bg-surface-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-500 rounded-full transition-all duration-700 ease-out"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            )}

            {/* Compact analysis log */}
            {analysisLogs.length > 0 && (
              <div>
                <div className="flex items-center gap-1 mb-0.5">
                  <span className="text-[8px] text-surface-500">ログ ({analysisLogs.length})</span>
                  <button
                    onClick={() => {
                      const text = analysisLogs.map(e => `[${e.time}] [${e.type}] ${e.message}`).join('\n');
                      navigator.clipboard.writeText(text);
                    }}
                    className="text-[8px] text-surface-500 hover:text-surface-200 transition-colors"
                    title="ログをコピー"
                  >
                    コピー
                  </button>
                </div>
                <div className="max-h-24 overflow-y-auto bg-surface-950 border border-surface-700 rounded p-1.5 font-mono text-[9px] space-y-px">
                  {analysisLogs.map((entry, i) => (
                    <div key={i} className={`flex gap-1 ${
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

            {proposals.length > 0 && (
              <div className="flex items-center justify-between text-xs">
                <button
                  onClick={() => setCurrentIndex((i) => i + 1)}
                  disabled={!hasPrev}
                  className="text-surface-400 hover:text-surface-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  &larr; 前へ
                </button>
                <span className="text-surface-500 flex items-center gap-1">
                  {currentIndex + 1} / {proposals.length}
                  {current && <span className="text-surface-600">{formatTimestamp(current.timestamp)}</span>}
                  {current?.id.startsWith('proposal-') && current.markdown?.includes('調査結果') && (
                    <span className="text-[8px] bg-purple-500/20 text-purple-400 px-1 py-0.5 rounded">調査</span>
                  )}
                  {current?.markdown && (
                    <button
                      onClick={handleExport}
                      className="text-surface-500 hover:text-accent-400 transition-colors ml-1"
                      title="エクスポート"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </button>
                  )}
                </span>
                <button
                  onClick={() => setCurrentIndex((i) => i - 1)}
                  disabled={!hasNext}
                  className="text-surface-400 hover:text-surface-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  次へ &rarr;
                </button>
              </div>
            )}
          </div>

          {/* Proposal content */}
          <div className="flex-1 overflow-y-auto">
            {current ? (
              current.status === 'error' ? (
                <div className="p-3 space-y-2">
                  <div className="bg-red-500/10 border border-red-500/30 rounded p-3">
                    <p className="text-red-400 text-xs font-medium mb-1">分析エラー</p>
                    <p className="text-surface-400 text-xs">{current.errorMessage}</p>
                  </div>
                  {current.markdown && (
                    <details className="bg-surface-800/50 border border-surface-700 rounded p-2">
                      <summary className="text-[10px] text-surface-500 cursor-pointer">Debug: Raw CLI Output</summary>
                      <div className="mt-2">
                        <MarkdownRenderer compact>{current.markdown}</MarkdownRenderer>
                      </div>
                    </details>
                  )}
                </div>
              ) : (
                <div className="p-3">
                  <MarkdownRenderer compact>{current.markdown}</MarkdownRenderer>
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-4">
                <svg className="w-8 h-8 text-surface-600 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <p className="text-xs text-surface-500">「分析実行」でメールからTODOを抽出します</p>
              </div>
            )}
          </div>
        </>
      ) : (
        /* Skills tab — top: gallery (always visible), bottom: preview */
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Top: Gallery grid (40%) */}
          <div className="overflow-y-auto p-2 border-b border-surface-700/50" style={{ minHeight: 0, flex: '0 0 40%' }}>
            {skills.length === 0 ? (
              <div className="p-4 text-center text-surface-500 text-xs">
                スキルが見つかりません
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {skills.map((skill) => {
                  const cat = getSkillCategory(skill.name);
                  const isActive = selectedSkill === skill.name;
                  return (
                    <div
                      key={skill.name}
                      onClick={() => setSelectedSkill(isActive ? null : skill.name)}
                      className={`p-1.5 rounded-lg border cursor-pointer transition-all hover:scale-[1.02] hover:shadow-md ${
                        isActive ? 'ring-1 ring-accent-400' : ''
                      }`}
                      style={{
                        borderColor: isActive ? 'var(--accent-400, #60a5fa)' : `${cat.color}30`,
                        background: isActive ? `${cat.color}18` : `${cat.color}08`,
                      }}
                    >
                      <div className="flex items-start gap-1">
                        <span className="text-xs flex-shrink-0 mt-px" role="img">{cat.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[9px] font-semibold text-surface-200 truncate leading-tight">{skill.name}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Bottom: Preview pane (60%) */}
          <div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
            {selectedSkill ? (
              <>
                <div className="px-2 py-1.5 border-b border-surface-700/50 flex items-center gap-2 flex-shrink-0 bg-surface-900/50">
                  <span className="text-xs font-medium text-surface-200 truncate flex-1">{selectedSkill}</span>
                  {skillEditing ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => { setSkillDraft(skillContent); setSkillEditing(false); }}
                        className="px-2 py-0.5 text-[10px] text-surface-400 hover:text-surface-200 transition-colors"
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={handleSaveSkill}
                        disabled={skillSaving}
                        className="px-2 py-0.5 text-[10px] bg-accent-500 hover:bg-accent-600 text-white rounded transition-colors disabled:opacity-50"
                      >
                        {skillSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSkillEditing(true)}
                      className="px-2 py-0.5 text-[10px] text-surface-400 hover:text-accent-400 transition-colors"
                    >
                      編集
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
                  {skillEditing ? (
                    <textarea
                      value={skillDraft}
                      onChange={(e) => setSkillDraft(e.target.value)}
                      className="w-full h-full p-3 bg-surface-950 text-surface-300 text-xs font-mono resize-none focus:outline-none border-none"
                      spellCheck={false}
                    />
                  ) : (
                    <div className="p-3">
                      <MarkdownRenderer compact>{skillContent}</MarkdownRenderer>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-4">
                <svg className="w-6 h-6 text-surface-600 mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p className="text-[10px] text-surface-500">スキルを選択してプレビュー</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
