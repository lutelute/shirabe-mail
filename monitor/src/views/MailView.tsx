import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useAppContext } from '../context/AppContext';
import { useMailData } from '../hooks/useMailData';
import { useJunkDetection } from '../hooks/useJunkDetection';
import type { MailItem, MailNote, ViewType, ThreadMessage, MailColumnId, MoveToTrashResult, InvestigationRequest, FolderItem, SenderColorMode } from '../types';
import { generateBasicNote } from '../utils/mailAnalysis';
import AccountSelector from '../components/AccountSelector';
import MailTable from '../components/MailTable';
import ThreadDetailPane from '../components/ThreadDetailPane';
import TodoProposalPanel from '../components/TodoProposalPanel';
import ChatPanel from '../components/ChatPanel';
import LoadingSkeleton from '../components/shared/LoadingSkeleton';
import EmptyState from '../components/shared/EmptyState';

interface MailViewProps {
  onNavigate: (view: ViewType) => void;
}

type JunkFilter = 'all' | 'junk' | 'safe';

/* ---- Column resize hook ---- */
function useColumnResize(initial: [number, number, number]) {
  const [widths, setWidths] = useState(initial);
  const drag = useRef<{ col: number; x: number; w: [number, number, number] } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const el = document.getElementById('mail-cols');
      if (!el) return;
      const d = ((e.clientX - drag.current.x) / el.offsetWidth) * 100;
      const w = [...drag.current.w] as [number, number, number];
      if (drag.current.col === 0) {
        w[0] = Math.max(15, Math.min(55, drag.current.w[0] + d));
        w[1] = Math.max(15, drag.current.w[1] - d);
      } else {
        w[1] = Math.max(15, Math.min(55, drag.current.w[1] + d));
        w[2] = Math.max(15, drag.current.w[2] - d);
      }
      setWidths(w);
    };
    const up = () => {
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const onDown = useCallback((col: number, e: React.MouseEvent) => {
    drag.current = { col, x: e.clientX, w: [...widths] as [number, number, number] };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [widths]);

  return { widths, onDown };
}

/* ---- Vertical (row) resize hook ---- */
function useRowResize(initialTopPct: number = 55) {
  const [topPct, setTopPct] = useState(initialTopPct);
  const drag = useRef<{ y: number; pct: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const dy = ((e.clientY - drag.current.y) / rect.height) * 100;
      setTopPct(Math.max(20, Math.min(80, drag.current.pct + dy)));
    };
    const up = () => {
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const onDown = useCallback((e: React.MouseEvent) => {
    drag.current = { y: e.clientY, pct: topPct };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [topPct]);

  return { topPct, onDown, containerRef };
}

/* ---- Main ---- */
export default function MailView({ onNavigate }: MailViewProps) {
  const { selectedAccounts, settings, settingsLoaded, saveSettings, updateState } = useAppContext();
  const { mails, loading, error, fetchMails } = useMailData();
  const { results: junkResults, loading: junkLoading, error: junkError, detectJunk } = useJunkDetection(settings.apiKey);

  const [selectedAccount, setSelectedAccount] = useState('all');
  const [selectedMail, setSelectedMail] = useState<MailItem | null>(null);
  const [expandedThreadId, setExpandedThreadId] = useState<number | null>(null);
  const [selectedThreadMsgId, setSelectedThreadMsgId] = useState<number | null>(null);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(settings.mailUnreadOnly);
  const [junkFilter, setJunkFilter] = useState<JunkFilter>('all');
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [moveLoading, setMoveLoading] = useState(false);
  const [moveResult, setMoveResult] = useState<{ ok: number; ng: number } | null>(null);
  const [crawlLoading, setCrawlLoading] = useState(false);
  const [crawlProgress, setCrawlProgress] = useState<{ done: number; total: number } | null>(null);
  const [investigateLoading, setInvestigateLoading] = useState(false);
  const [proposalRefreshTrigger, setProposalRefreshTrigger] = useState(0);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<number>>(new Set());
  const [showFolderFilter, setShowFolderFilter] = useState(false);
  const [noteMap, setNoteMap] = useState<Map<string, MailNote>>(new Map());

  const { widths, onDown } = useColumnResize(settings.mailColumnRatio);
  const { topPct: col3TopPct, onDown: col3RowDown, containerRef: col3Ref } = useRowResize(75);

  useEffect(() => {
    if (settingsLoaded) setUnreadOnly(settings.mailUnreadOnly);
  }, [settingsLoaded, settings.mailUnreadOnly]);

  useEffect(() => {
    if (settingsLoaded && selectedAccounts.length > 0)
      fetchMails(selectedAccounts.map((a) => a.email), settings.mailDaysBack, settings.excludeSpam);
  }, [settingsLoaded, selectedAccounts, settings.mailDaysBack, settings.excludeSpam, fetchMails]);

  // Load folders for folder filter
  const INBOX_NAMES = useMemo(() => new Set(['inbox', '受信トレイ', 'eingang', 'posteingang']), []);
  useEffect(() => {
    if (!settingsLoaded || selectedAccounts.length === 0) return;
    Promise.all(selectedAccounts.map(a => window.electronAPI.getFolders(a.email)))
      .then(results => {
        const all = results.flat();
        setFolders(all);
        const inboxIds = new Set(
          all.filter(f => INBOX_NAMES.has(f.name.toLowerCase())).map(f => f.id)
        );
        setSelectedFolderIds(inboxIds);
      });
  }, [settingsLoaded, selectedAccounts, INBOX_NAMES]);

  // Load thread when expandedThreadId changes
  useEffect(() => {
    if (!expandedThreadId || !selectedMail) {
      setThreadMessages([]);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    window.electronAPI.getThreadMessages(selectedMail.id, selectedMail.accountEmail)
      .then((msgs) => { if (!cancelled) setThreadMessages(msgs); })
      .catch(() => { if (!cancelled) setThreadMessages([]); })
      .finally(() => { if (!cancelled) setThreadLoading(false); });
    return () => { cancelled = true; };
  }, [expandedThreadId, selectedMail]);

  const junkMap = useMemo(() => new Map(junkResults.map((r) => [r.mailId, r])), [junkResults]);

  const filteredMails = useMemo(() => {
    let r = mails;
    if (selectedAccount !== 'all') r = r.filter((m) => m.accountEmail === selectedAccount);
    if (unreadOnly) r = r.filter((m) => !m.isRead);
    // フォルダフィルター
    if (selectedFolderIds.size > 0) {
      r = r.filter((m) => selectedFolderIds.has(m.folder));
    }
    if (junkResults.length > 0 && junkFilter !== 'all') {
      r = r.filter((m) => {
        const j = junkMap.get(m.id);
        return junkFilter === 'junk' ? j?.isJunk : !j?.isJunk;
      });
    }

    // Group by conversationId — keep only the latest mail per thread
    const threadMap = new Map<string, MailItem>();
    const standalone: MailItem[] = [];
    for (const m of r) {
      if (!m.conversationId) {
        standalone.push(m);
        continue;
      }
      const existing = threadMap.get(m.conversationId);
      if (!existing || new Date(m.date).getTime() > new Date(existing.date).getTime()) {
        threadMap.set(m.conversationId, m);
      }
    }

    return [...threadMap.values(), ...standalone]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [mails, selectedAccount, unreadOnly, selectedFolderIds, junkResults, junkFilter, junkMap]);

  // Load notes for tag badge display
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getNotes().then((notes) => {
      if (cancelled) return;
      const map = new Map<string, MailNote>();
      for (const n of notes as MailNote[]) {
        map.set(n.id, n);
      }
      setNoteMap(map);
    });
    return () => { cancelled = true; };
  }, [mails.length, selectedMail]);

  const handleSelectMail = useCallback((mail: MailItem) => {
    setSelectedMail(mail);
    setSelectedThreadMsgId(null);
    // 選択メールコンテキストを永続化（Claude Codeから参照可能に）
    window.electronAPI.setSelectedMailContext(mail);
  }, []);

  const handleToggleThread = useCallback((mailId: number) => {
    setExpandedThreadId((prev) => (prev === mailId ? null : mailId));
    setSelectedThreadMsgId(null);
  }, []);

  const handleCheck = useCallback((id: number) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleCheckAll = useCallback((ids: number[]) => {
    setCheckedIds(new Set(ids));
  }, []);

  const handleColumnsChange = useCallback((cols: MailColumnId[]) => {
    saveSettings({ ...settings, mailColumns: cols });
  }, [settings, saveSettings]);

  const handleDetectJunk = useCallback(async () => {
    const target = selectedAccount === 'all'
      ? mails
      : mails.filter((m) => m.accountEmail === selectedAccount);
    await detectJunk(target);
    setCheckedIds(new Set());
    setMoveResult(null);
  }, [mails, selectedAccount, detectJunk]);

  const handleMoveToTrash = useCallback(async () => {
    if (checkedIds.size === 0) return;
    const byAccount = new Map<string, number[]>();
    for (const mailId of checkedIds) {
      const mail = mails.find((m) => m.id === mailId);
      if (!mail) continue;
      const list = byAccount.get(mail.accountEmail) || [];
      list.push(mailId);
      byAccount.set(mail.accountEmail, list);
    }
    setMoveLoading(true);
    setMoveResult(null);
    const allResults: MoveToTrashResult[] = [];
    for (const [acct, ids] of byAccount) {
      try { allResults.push(...await window.electronAPI.moveToTrash(ids, acct)); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        allResults.push(...ids.map((id) => ({ mailId: id, success: false, error: msg })));
      }
    }
    const ok = allResults.filter((r) => r.success).length;
    const ng = allResults.filter((r) => !r.success).length;
    setMoveResult({ ok, ng });
    setMoveLoading(false);
    const okSet = new Set(allResults.filter((r) => r.success).map((r) => r.mailId));
    setCheckedIds((prev) => { const n = new Set(prev); for (const id of okSet) n.delete(id); return n; });
  }, [checkedIds, mails]);

  // --- Mail crawl: batch note generation/update (AI-powered when apiKey available) ---
  const handleCrawlNotes = useCallback(async () => {
    if (crawlLoading) return;
    const target = filteredMails;
    if (target.length === 0) return;
    setCrawlLoading(true);
    setCrawlProgress({ done: 0, total: target.length });

    const useAi = !!settings.apiKey;
    let done = 0;
    for (const mail of target) {
      const noteId = mail.conversationId ? `conv-${mail.conversationId}` : `mail-${mail.id}`;
      try {
        const existing = await window.electronAPI.getNote(noteId);
        // Skip if note already has AI content (avoid re-processing)
        if (existing && existing.content && existing.history.some((h) => h.type === 'ai_proposal')) {
          done++;
          setCrawlProgress({ done, total: target.length });
          continue;
        }

        const sender = mail.from?.displayName || mail.from?.address || '不明';
        const now = new Date().toISOString();
        let content: string;
        let quickLabel: import('../types').QuickLabel | undefined;

        if (useAi) {
          // AI-powered analysis
          const prompt = `以下のメールを簡潔に分析し、判定と要点をまとめてください。

件名: ${mail.subject}
差出人: ${sender}
日付: ${mail.date}
本文: ${(mail.preview || '').slice(0, 1200)}

以下の形式で出力（マークダウン、簡潔に）:
## 判定
[不要/要返信/個別対応/保留/対応済] — 理由1文

## 要点
- **重要な点は太字**
- （2〜4行で）

## アクション
- [ ] 必要なタスクがあれば（なければ省略）

## ⚠️ 期限
- 期限があれば記載（なければ省略）`;

          try {
            const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'light' });
            if (result.status === 'done' && result.markdown) {
              content = result.markdown;
              // Extract quick label from AI response
              const labelMatch = result.markdown.match(/##\s*判定\s*\n\s*\[?(不要|要返信|個別対応|保留|対応済)/);
              if (labelMatch) {
                const labelMap: Record<string, import('../types').QuickLabel> = {
                  '不要': 'unnecessary', '要返信': 'reply', '個別対応': 'action', '保留': 'hold', '対応済': 'done',
                };
                quickLabel = labelMap[labelMatch[1]];
              }
            } else {
              // AI failed — fallback to regex
              content = generateBasicNote(mail.subject, sender, mail.preview);
            }
          } catch {
            content = generateBasicNote(mail.subject, sender, mail.preview);
          }
        } else {
          // Regex-based fallback
          content = generateBasicNote(mail.subject, sender, mail.preview);
        }

        if (existing) {
          const updated: MailNote = {
            ...existing,
            mailId: mail.id,
            subject: mail.subject,
            content,
            quickLabel: quickLabel ?? existing.quickLabel,
            updatedAt: now,
            history: [
              ...existing.history,
              { timestamp: now, type: useAi ? 'ai_proposal' : 'updated', content: useAi ? 'AIクロール分析' : 'クロール更新' },
            ],
          };
          await window.electronAPI.saveNote(updated);
        } else {
          const newNote: MailNote = {
            id: noteId,
            mailId: mail.id,
            accountEmail: mail.accountEmail,
            subject: mail.subject,
            content,
            quickLabel,
            todos: [],
            history: [{ timestamp: now, type: useAi ? 'ai_proposal' : 'created', content: useAi ? 'AIクロール分析' : 'クロール自動生成' }],
            createdAt: now,
            updatedAt: now,
          };
          await window.electronAPI.saveNote(newNote);
        }
      } catch {
        // Skip errors for individual mails
      }
      done++;
      setCrawlProgress({ done, total: target.length });
    }

    setCrawlLoading(false);
    setCrawlProgress(null);
  }, [crawlLoading, filteredMails, settings.apiKey]);

  // --- Investigation handler ---
  const handleInvestigate = useCallback(async (mail: MailItem, userMessage: string) => {
    setInvestigateLoading(true);

    const sender = mail.from?.displayName || mail.from?.address || '不明';
    const prompt = `以下のメールについて詳細に調査・分析してください。

件名: ${mail.subject}
差出人: ${sender}
アカウント: ${mail.accountEmail}
メールID: ${mail.id}

${userMessage ? `## ユーザーからの追加指示\n${userMessage}` : ''}

## 調査手順
1. mcp__shirabe__get_note でこのメールの既存ノートを確認
2. mcp__shirabe__get_mail_detail でメール本文の詳細を取得
3. mcp__shirabe__get_mail_thread でスレッド全体の文脈を確認
4. 必要に応じて mcp__shirabe__search_mails で関連メールを検索
5. mcp__shirabe__analyze_thread でアクション項目・緊急度を構造化分析
6. 分析結果を mcp__shirabe__update_note でノートに保存（既存ノートがあれば差分のみ追記）
   - content: 調査結果のMarkdown
   - todos: 具体的なアクション項目（テキスト配列）
   - tags: カテゴリ（urgent/reply/action/info/unnecessary/hold）
7. 必要に応じて mcp__shirabe__tag_mail でタグ付け

## 出力形式（Markdown）
# 調査結果: ${mail.subject}

## 概要
- スレッドの状況まとめ

## 重要なポイント
- **太字で強調**
- 期限があれば明記

## アクション
- [ ] 必要な対応（あれば）

## 関連情報
- 背景・注意点`;

    const inv: InvestigationRequest = {
      id: `inv-${Date.now()}`,
      mailId: mail.id,
      accountEmail: mail.accountEmail,
      subject: mail.subject,
      conversationId: mail.conversationId,
      userMessage: userMessage || undefined,
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    await window.electronAPI.saveInvestigation(inv);

    try {
      const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'deep' });
      inv.status = result.status === 'done' ? 'done' : 'error';
      inv.resultProposalId = result.id;
      await window.electronAPI.saveInvestigation(inv);
      setProposalRefreshTrigger((n) => n + 1);
    } catch {
      inv.status = 'error';
      await window.electronAPI.saveInvestigation(inv);
    } finally {
      setInvestigateLoading(false);
    }
  }, []);

  const handleSendToCli = useCallback((message: string) => {
    window.electronAPI.ptyWrite(message + '\n');
  }, []);

  const unreadCount = useMemo(() => {
    const base = selectedAccount === 'all' ? mails : mails.filter((m) => m.accountEmail === selectedAccount);
    return base.filter((m) => !m.isRead).length;
  }, [mails, selectedAccount]);

  const junkCount = junkResults.filter((r) => r.isJunk).length;
  const safeCount = junkResults.filter((r) => !r.isJunk).length;
  const hasImapConfig = settings.imapConfigs.some((c) => c.credentials !== null);
  const activeColumns: MailColumnId[] = settings.mailColumns ?? ['unread', 'from', 'subject', 'importance', 'date'];

  // Folder filter helpers — build tree structure
  interface FolderTreeNode {
    folder: FolderItem;
    children: FolderTreeNode[];
    depth: number;
  }

  const folderTree = useMemo((): FolderTreeNode[] => {
    const seen = new Map<number, FolderItem>();
    for (const f of folders) {
      if (!seen.has(f.id)) seen.set(f.id, f);
    }
    const all = [...seen.values()];
    const childrenMap = new Map<number | null, FolderItem[]>();
    for (const f of all) {
      const parent = f.parentFolderId;
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent)!.push(f);
    }
    // Sort children alphabetically
    for (const [, children] of childrenMap) {
      children.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Build tree recursively
    function build(parentId: number | null, depth: number): FolderTreeNode[] {
      const children = childrenMap.get(parentId) ?? [];
      return children.map(f => ({
        folder: f,
        children: build(f.id, depth + 1),
        depth,
      }));
    }
    // Find root parents: folders whose parentFolderId is null or whose parent is not in the set
    const idSet = new Set(all.map(f => f.id));
    const roots = all.filter(f => f.parentFolderId === null || !idSet.has(f.parentFolderId));
    const rootIds = new Set(roots.map(r => r.parentFolderId));
    // Build from all root parent IDs
    const tree: FolderTreeNode[] = [];
    for (const rid of rootIds) {
      tree.push(...build(rid, 0));
    }
    return tree;
  }, [folders]);

  // Flatten tree for rendering (with depth info)
  const flatFolderTree = useMemo(() => {
    const result: FolderTreeNode[] = [];
    function walk(nodes: FolderTreeNode[]) {
      for (const n of nodes) {
        result.push(n);
        walk(n.children);
      }
    }
    walk(folderTree);
    return result;
  }, [folderTree]);

  const toggleFolder = useCallback((id: number) => {
    setSelectedFolderIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectInboxOnly = useCallback(() => {
    setSelectedFolderIds(new Set(
      folders.filter(f => INBOX_NAMES.has(f.name.toLowerCase())).map(f => f.id)
    ));
  }, [folders, INBOX_NAMES]);

  const selectAllFolders = useCallback(() => {
    setSelectedFolderIds(new Set());
  }, []);

  const selectNoFolders = useCallback(() => {
    setSelectedFolderIds(new Set([-1])); // sentinel: match nothing
  }, []);

  return (
    <div id="mail-cols" className="flex h-full w-full overflow-hidden">

      {/* ========== Col 1: Toolbar + MailTable ========== */}
      <div className="flex flex-col" style={{ width: `${widths[0]}%`, height: '100%' }}>
        {/* Toolbar */}
        <div className="px-2 py-1.5 border-b border-surface-700/50 bg-surface-900/50 flex-shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5">
              <h2 className="text-xs font-semibold text-surface-200">メール</h2>
              {unreadCount > 0 && (
                <span className="text-[9px] bg-accent-500 text-white px-1 py-0.5 rounded-full font-medium leading-none">{unreadCount}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setUnreadOnly((v) => !v)}
                className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                  unreadOnly
                    ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
                    : 'bg-surface-800 hover:bg-surface-700 text-surface-400 border border-transparent'
                }`}
              >未読</button>
              {/* フォルダフィルター */}
              <div className="relative">
                <button
                  onClick={() => setShowFolderFilter(v => !v)}
                  className={`px-1.5 py-0.5 text-[10px] rounded transition-colors ${
                    selectedFolderIds.size > 0
                      ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
                      : 'bg-surface-800 hover:bg-surface-700 text-surface-400 border border-transparent'
                  }`}
                >
                  {selectedFolderIds.size > 0 && !selectedFolderIds.has(-1) ? `フォルダ(${selectedFolderIds.size})` : 'フォルダ'}
                </button>
                {showFolderFilter && (
                  <div className="absolute top-full left-0 z-50 mt-1 bg-surface-800 border border-surface-600 rounded shadow-lg p-2 min-w-[220px] max-h-[300px] overflow-y-auto">
                    <div className="flex gap-1 mb-1.5 pb-1 border-b border-surface-700">
                      <button onClick={selectInboxOnly} className="text-[9px] px-1 py-0.5 bg-accent-500/20 text-accent-400 rounded hover:bg-accent-500/30">受信トレイのみ</button>
                      <button onClick={selectAllFolders} className="text-[9px] px-1 py-0.5 bg-surface-700 text-surface-300 rounded hover:bg-surface-600">全て</button>
                      <button onClick={selectNoFolders} className="text-[9px] px-1 py-0.5 bg-surface-700 text-surface-300 rounded hover:bg-surface-600">クリア</button>
                    </div>
                    {flatFolderTree.map(node => (
                      <label
                        key={node.folder.id}
                        className="flex items-center gap-1.5 text-[10px] py-0.5 cursor-pointer text-surface-300 hover:text-surface-100"
                        style={{ paddingLeft: `${node.depth * 12 + 2}px` }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFolderIds.has(node.folder.id)}
                          onChange={() => toggleFolder(node.folder.id)}
                          className="w-3 h-3 flex-shrink-0"
                        />
                        {node.children.length > 0 && (
                          <span className="text-[8px] text-surface-500 flex-shrink-0">
                            {node.children.some(c => selectedFolderIds.has(c.folder.id)) ? '▼' : '▶'}
                          </span>
                        )}
                        <span className="truncate">{node.folder.name}</span>
                        {INBOX_NAMES.has(node.folder.name.toLowerCase()) && (
                          <span className="text-[8px] text-accent-400 flex-shrink-0">★</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleDetectJunk}
                disabled={junkLoading || loading || mails.length === 0}
                className="px-1.5 py-0.5 text-[10px] bg-orange-600/80 hover:bg-orange-500 text-white rounded transition-colors disabled:opacity-40"
              >
                {junkLoading ? '検出中...' : 'Junk'}
              </button>
              <button
                onClick={() => fetchMails(selectedAccounts.map((a) => a.email), settings.mailDaysBack, settings.excludeSpam)}
                disabled={loading}
                className="px-1.5 py-0.5 text-[10px] bg-surface-800 hover:bg-surface-700 text-surface-300 rounded disabled:opacity-40"
              >更新</button>
              <button
                onClick={handleCrawlNotes}
                disabled={crawlLoading || loading || filteredMails.length === 0}
                className="px-1.5 py-0.5 text-[10px] bg-purple-600/80 hover:bg-purple-500 text-white rounded transition-colors disabled:opacity-40"
                title={settings.apiKey ? 'Claude AIで一括分析' : '表示中メールのノートを一括生成（regex）'}
              >
                {crawlLoading
                  ? `${crawlProgress?.done ?? 0}/${crawlProgress?.total ?? 0}`
                  : settings.apiKey ? 'AI分析' : 'クロール'}
              </button>
              {updateState.hasUpdate && !updateState.installed && (
                <button
                  onClick={() => onNavigate('settings')}
                  className={`px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
                    updateState.downloading
                      ? 'text-amber-400 bg-amber-500/15 border-amber-500/30'
                      : 'text-accent-400 bg-accent-500/15 border-accent-500/30 animate-pulse'
                  }`}
                  title={updateState.downloading
                    ? `ダウンロード中 ${updateState.downloadPercent ?? 0}%`
                    : `v${updateState.latestVersion} が利用可能`}
                >
                  {updateState.downloading ? `更新中 ${updateState.downloadPercent ?? 0}%` : '更新あり'}
                </button>
              )}
            </div>
          </div>
          <AccountSelector accounts={selectedAccounts} selected={selectedAccount} onSelect={setSelectedAccount} />

          {/* Junk filter + bulk actions */}
          {junkResults.length > 0 && (
            <div className="flex items-center gap-1 mt-1 flex-wrap">
              {(['all', 'junk', 'safe'] as JunkFilter[]).map((mode) => (
                <button key={mode} onClick={() => setJunkFilter(mode)}
                  className={`px-1.5 py-px text-[10px] rounded transition-colors ${
                    junkFilter === mode
                      ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
                      : 'bg-surface-700 text-surface-400 hover:bg-surface-600 border border-transparent'
                  }`}>
                  {mode === 'all' ? '全て' : mode === 'junk' ? `Junk(${junkCount})` : `Safe(${safeCount})`}
                </button>
              ))}
              {checkedIds.size > 0 && (
                <button
                  onClick={handleMoveToTrash}
                  disabled={moveLoading || !hasImapConfig}
                  title={!hasImapConfig ? 'IMAP未設定' : ''}
                  className="px-1.5 py-px text-[10px] bg-red-600 hover:bg-red-500 text-white rounded disabled:opacity-50"
                >
                  {moveLoading ? '移動中...' : `削除(${checkedIds.size})`}
                </button>
              )}
            </div>
          )}
          {moveResult && (
            <p className={`text-[10px] mt-0.5 ${moveResult.ng ? 'text-orange-400' : 'text-green-400'}`}>
              {moveResult.ok}件完了{moveResult.ng ? ` / ${moveResult.ng}件失敗` : ''}
            </p>
          )}
        </div>

        {error && <div className="px-2 py-1 text-[10px] text-red-400 bg-red-500/5 border-b border-red-500/10 flex-shrink-0">{error}</div>}
        {junkError && <div className="px-2 py-1 text-[10px] text-red-400 bg-red-500/5 border-b border-red-500/10 flex-shrink-0">{junkError}</div>}

        {/* Mail table */}
        {loading ? (
          <LoadingSkeleton rows={12} />
        ) : filteredMails.length === 0 ? (
          <EmptyState title={unreadOnly ? '未読メールはありません' : 'メールはありません'} />
        ) : (
          <MailTable
            mails={filteredMails}
            columns={activeColumns}
            selectedMail={selectedMail}
            expandedThreadId={expandedThreadId}
            threadMessages={threadMessages}
            threadLoading={threadLoading}
            selectedThreadMsgId={selectedThreadMsgId}
            checkedIds={checkedIds}
            junkMap={junkMap}
            noteMap={noteMap}
            senderColorMode={(settings.senderColorMode ?? 'text') as SenderColorMode}
            customTags={settings.customTags ?? []}
            onSelectMail={handleSelectMail}
            onToggleThread={handleToggleThread}
            onSelectThreadMsg={setSelectedThreadMsgId}
            onCheck={handleCheck}
            onCheckAll={handleCheckAll}
            onColumnsChange={handleColumnsChange}
          />
        )}
      </div>

      {/* Resizer */}
      <div className="w-1 flex-shrink-0 cursor-col-resize bg-surface-700/30 hover:bg-accent-500/30 transition-colors" onMouseDown={(e) => onDown(0, e)} />

      {/* ========== Col 2: ThreadDetailPane ========== */}
      <div className="flex flex-col border-r border-surface-700/50" style={{ width: `${widths[1]}%`, height: '100%' }}>
        <ThreadDetailPane
          selectedMail={selectedMail}
          threadMessages={threadMessages}
          threadLoading={threadLoading}
          selectedThreadMsgId={selectedThreadMsgId}
          apiKey={settings.apiKey}
          senderColorMode={(settings.senderColorMode ?? 'text') as SenderColorMode}
          onInvestigate={handleInvestigate}
          investigateLoading={investigateLoading}
          onSendToCli={handleSendToCli}
        />
      </div>

      {/* Resizer */}
      <div className="w-1 flex-shrink-0 cursor-col-resize bg-surface-700/30 hover:bg-accent-500/30 transition-colors" onMouseDown={(e) => onDown(1, e)} />

      {/* ========== Col 3: Proposal (top) + Chat (bottom) — vertically resizable ========== */}
      <div ref={col3Ref} className="flex flex-col" style={{ width: `${widths[2]}%`, height: '100%' }}>
        {/* Top: TodoProposalPanel */}
        <div className="flex flex-col overflow-hidden" style={{ height: `${col3TopPct}%`, minHeight: 0 }}>
          <TodoProposalPanel onNavigate={onNavigate} refreshTrigger={proposalRefreshTrigger} />
        </div>
        {/* Vertical resizer */}
        <div
          className="h-1 flex-shrink-0 cursor-row-resize bg-surface-700/30 hover:bg-accent-500/30 transition-colors"
          onMouseDown={col3RowDown}
        />
        {/* Bottom: ChatPanel (lazy-start terminal) */}
        <div className="flex flex-col flex-1 overflow-hidden" style={{ minHeight: 0 }}>
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
