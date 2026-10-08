import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CalendarBatchDialog from '../components/partner/CalendarBatchDialog';
import { isComposingKey } from '../utils/ime';
import type { PartnerState, ButlerCase, ButlerCaseStatus, ButlerGroup, OutboxItem, FollowUp, ViewType, HandoffTarget } from '../types';
import { useAppContext } from '../context/AppContext';
import BriefCard from '../components/partner/BriefCard';
import QueueRow from '../components/partner/QueueRow';
import CaseDetail from '../components/partner/CaseDetail';
import { OutboxDetail, FollowUpDetail, GroupDetail, JournalDetail } from '../components/partner/OtherDetails';
import { buildQueue, flattenQueue, SECTION_ORDER } from '../components/partner/queue';
import type { QueueItem, Section } from '../components/partner/queue';
import { groupQueue, useToast, useMediaQuery, todayLabel, fmtTime, Icon, HANDOFF_TARGET_LABEL, SECTION_TONE_META, PrimaryButton } from '../components/partner/partnerUi';
import type { SectionTone } from '../components/partner/partnerUi';
import type { MascotMode } from '../components/partner/Mascot';

// =====================================================================
// 「今日」 — 机の上の相棒。
//   上: 相棒の一言  /  左: キュー(決める→送る→やる→送信予定→返事待ち→参考…)  /  右: 選んだものの詳細と操作
// =====================================================================

interface TodayViewProps {
  onNavigate: (view: ViewType) => void;
}

interface Progress { stage: string; message: string; done?: number; total?: number }

const DEFAULT_OPEN: Record<Section, boolean> = { decide: true, send: true, act: true, outbox: true, followup: true, fyi: false, later: false, tidied: false, journal: false };
const LS_OPEN_KEY = 'shirabe_today_sections';

export default function TodayView({ onNavigate }: TodayViewProps) {
  const { settings } = useAppContext();
  const [state, setState] = useState<PartnerState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [mascotFlash, setMascotFlash] = useState<'done' | 'error' | null>(null);   // 実行直後の 2 秒だけ
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editRequest, setEditRequest] = useState(0);
  const [handoffRequest, setHandoffRequest] = useState(0);
  const [emDraftRequest, setEmDraftRequest] = useState(0);
  const [openSections, setOpenSections] = useState<Record<Section, boolean>>(() => {
    try { return { ...DEFAULT_OPEN, ...(JSON.parse(localStorage.getItem(LS_OPEN_KEY) ?? '{}') as Partial<Record<Section, boolean>>) }; } catch { return DEFAULT_OPEN; }
  });
  const { toast, flash } = useToast();
  const mounted = useRef(true);
  const wide = useMediaQuery('(min-width: 1180px)');
  const listRef = useRef<HTMLDivElement | null>(null);

  // ---- 読み込み・購読 ----
  const refresh = useCallback(async () => {
    try {
      const s = await window.electronAPI.partnerGetState();
      if (mounted.current) { setState(s); setLoaded(true); setRunning(!!s.running); }
    } catch (e) {
      if (mounted.current) { setLoaded(true); flash(e instanceof Error ? e.message : '状態の取得に失敗しました'); }
    }
  }, [flash]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const un1 = window.electronAPI.onPartnerState((s) => {
      setState(s);
      setLoaded(true);
      setRunning(!!s.running);
      if (!s.running) setBusy(new Set());
    });
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    const un2 = window.electronAPI.onButlerProgress((p) => {
      setProgress(p);
      if (p.stage === 'done' || p.stage === 'error') {
        setRunning(false);
        setMascotFlash(p.stage);
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => { setMascotFlash(null); setProgress(null); }, p.stage === 'error' ? 6000 : 2200);
        void refresh();
      } else {
        setMascotFlash(null);
        setRunning(true);
      }
    });
    return () => { mounted.current = false; un1(); un2(); if (flashTimer) clearTimeout(flashTimer); };
  }, [refresh]);

  const mascotMode: MascotMode = running ? 'working' : mascotFlash ?? 'idle';

  useEffect(() => {
    try { localStorage.setItem(LS_OPEN_KEY, JSON.stringify(openSections)); } catch { /* ignore */ }
  }, [openSections]);

  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try { await fn(); } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, []);

  const patchCase = useCallback((id: string, patch: Partial<ButlerCase>) => {
    setState((prev) => {
      if (!prev?.digest?.cases) return prev;
      return { ...prev, digest: { ...prev.digest, cases: prev.digest.cases.map((x) => x.id === id ? { ...x, ...patch } : x) } };
    });
  }, []);

  // ---- 操作 ----
  const runNow = useCallback(async () => {
    setRunning(true);
    setProgress({ stage: 'collect', message: '準備しています…' });
    try {
      const s = await window.electronAPI.partnerRunNow();
      if (mounted.current) setState(s);
    } catch (e) {
      flash(e instanceof Error ? e.message : '実行に失敗しました');
    } finally {
      if (mounted.current) setRunning(false);
    }
  }, [flash]);

  const onStatus = useCallback((c: ButlerCase, status: ButlerCaseStatus) => withBusy(c.id, async () => {
    const res = await window.electronAPI.updateButlerCase({ caseId: c.id, status });
    if (res.status === 'error') flash(res.error ?? '更新に失敗しました');
    else {
      patchCase(c.id, { status });
      flash(status === 'later' ? '「後で」に移しました' : status === 'dismissed' ? '閉じました' : status === 'done' ? '済みにしました' : '戻しました');
    }
  }), [withBusy, flash, patchCase]);

  const onRule = useCallback((address: string, tier: 'vip' | 'noise' | null) => withBusy(`rule:${address}`, async () => {
    await window.electronAPI.setButlerSenderRule({ address, tier });
    flash(tier === 'vip' ? `${address} を「常に重要」として覚えました` : tier === 'noise' ? `${address} を「不要」として覚えました` : '指定を解除しました');
    await refresh();
  }), [withBusy, flash, refresh]);

  const onDraft = useCallback((c: ButlerCase, instruction?: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.generateCaseDraft({ caseId: c.id, instruction });
    if (res.status === 'error') flash(res.error ?? '下書きの生成に失敗しました');
    else if (res.draft) patchCase(c.id, { draft: res.draft, draftStatus: 'prepared', draftEdited: false });
  }), [withBusy, flash, patchCase]);

  const onSaveDraft = useCallback(async (c: ButlerCase, body: string) => {
    await withBusy(c.id, async () => {
      const res = await window.electronAPI.partnerSaveDraft({ caseId: c.id, body });
      if (res.status === 'error') flash(res.error ?? '保存に失敗しました');
      else { patchCase(c.id, { draft: body, draftEdited: true }); flash('下書きを保存しました'); }
    });
  }, [withBusy, flash, patchCase]);

  const onSend = useCallback((c: ButlerCase, body?: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerSend({ caseId: c.id, body });
    if (res.status === 'error') { flash(res.error ?? '送信の準備に失敗しました'); return; }
    if (res.fallback === 'compose') {
      flash('接続が未設定のため eM Client の作成画面を開きました。「接続する」を済ませると相棒が直接送れます');
    } else if (res.outboxId) {
      const delay = settings.partnerSendDelayMinutes ?? 0;
      flash(delay > 0 ? `${delay}分後に送信します(取り消せます)` : '送信します');
      patchCase(c.id, { status: 'scheduled', outboxId: res.outboxId, ...(body ? { draft: body } : {}) });
    }
    await refresh();
  }), [withBusy, flash, patchCase, refresh, settings.partnerSendDelayMinutes]);

  const onAnswer = useCallback((c: ButlerCase, answer: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerAnswerDecision({ caseId: c.id, answer });
    if (res.status === 'error') { flash(res.error ?? '下書きの生成に失敗しました'); return; }
    patchCase(c.id, {
      decision: c.decision ? { ...c.decision, answer, answeredAt: new Date().toISOString() } : null,
      ...(res.draft ? { draft: res.draft, draftStatus: 'prepared' as const } : {}),
    });
    flash('下書きを用意しました');
    await refresh();
  }), [withBusy, flash, patchCase, refresh]);

  // ---- 作業に移る / eM Client の下書き / カレンダー ----
  const onDraftToEmClient = useCallback((c: ButlerCase, body?: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerDraftToEmClient({ caseId: c.id, body });
    if (res.status === 'error') { flash(res.error ?? 'eM Client の下書きに入れられませんでした'); return; }
    if (body) patchCase(c.id, { draft: body, draftEdited: true });
    flash(res.fallback === 'compose' ? '接続が未設定のため eM Client の作成画面を開きました。「接続する」を済ませると下書きフォルダに直接入ります' : 'eM Client の下書きに入れました(開いて送ってください)');
    await refresh();
  }), [withBusy, flash, patchCase, refresh]);

  const onHandoffPrepare = useCallback((c: ButlerCase, instruction?: string) => withBusy(`handoff:${c.id}`, async () => {
    const res = await window.electronAPI.partnerHandoffPrepare({ caseId: c.id, instruction });
    if (res.status === 'error') { flash(res.error ?? '作業指示書を用意できませんでした'); return; }
    if (res.handoff) patchCase(c.id, { handoff: res.handoff });
    flash(res.handoff?.folder ? '作業指示書を用意しました' : '作業指示書を用意しました。フォルダを選んでください');
    await refresh();
  }), [withBusy, flash, patchCase, refresh]);

  const onHandoffOpen = useCallback((c: ButlerCase, target: HandoffTarget) => withBusy(`handoff:${c.id}`, async () => {
    const res = await window.electronAPI.partnerHandoffOpen({ caseId: c.id, target });
    if (res.status === 'error') { flash(res.error ?? '開けませんでした'); return; }
    if (target === 'app') {
      try {
        localStorage.setItem('shirabe_pending_pty', JSON.stringify({ cwd: res.cwd, command: ['claude', res.prompt ?? ''], title: res.title || c.handoff?.title || c.subject.slice(0, 20), caseId: c.id }));
      } catch { /* ignore */ }
      flash('アプリ内ターミナルで Claude Code を起動しました');
      await refresh();
      onNavigate('terminal');
      return;
    }
    flash(res.detail ?? `${HANDOFF_TARGET_LABEL[target]} で開きました`);
    await refresh();
  }), [withBusy, flash, refresh, onNavigate]);

  const onPickFolder = useCallback((c: ButlerCase) => withBusy(`handoff:${c.id}`, async () => {
    const res = await window.electronAPI.partnerPickFolder({ caseId: c.id });
    if (res.status === 'error') { flash(res.error ?? 'フォルダを選べませんでした'); return; }
    if (res.folder) {
      if (c.handoff) patchCase(c.id, { handoff: { ...c.handoff, folder: res.folder, folderExists: true } });
      flash('フォルダを変更しました');
      await refresh();
    }
  }), [withBusy, flash, patchCase, refresh]);

  const onHandoffCopy = useCallback((c: ButlerCase) => withBusy(`handoff:${c.id}`, async () => {
    const res = await window.electronAPI.partnerHandoffCopy({ caseId: c.id });
    if (res.status === 'error') flash(res.error ?? 'コピーに失敗しました');
    else flash('作業指示をコピーしました。場所を移してから開いた Claude や ChatGPT に貼り付けてください');
  }), [withBusy]);
  const onCalendarCopy = useCallback((c: ButlerCase, target: 'chatgpt' | 'clipboard') => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerCalendarCopy({ caseId: c.id, target });
    if (res.status === 'error') flash(res.error ?? 'コピーに失敗しました');
    else flash(res.opened ? '予定の文面をコピーして ChatGPT を開きました。貼り付けて登録を頼んでください' : '予定の文面をコピーしました');
  }), [withBusy]);
  const calendarToast = (res: { target?: string; account?: string; inserted?: boolean }) =>
    res.inserted
      ? `Google カレンダー${res.account ? `(${res.account})` : ''}に登録しました。間違いなら「取り消す」で消せます`
      : res.target === 'emclient'
        ? 'eM Client で登録ダイアログを開きました。保存すると次回の確認で消えます'
        : `Google カレンダー${res.account ? `(${res.account})` : ''}の登録画面を開きました。内容を確かめて「保存」を押してください`;
  // つないだ Google アカウント(予定の登録先の切り替え用)
  const [googleAccounts, setGoogleAccounts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => window.electronAPI.calendarTargets().then((s) => { if (alive) setGoogleAccounts(s.targets); }).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const onAddToCalendarAs = useCallback((c: ButlerCase, account: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerAddToCalendar({ caseId: c.id, target: 'google', account });
    if (res.status === 'error') { flash(res.error ?? 'カレンダーに登録できませんでした'); return; }
    flash(calendarToast(res));
  }), [withBusy, flash]);
  const onRemoveFromCalendar = useCallback((c: ButlerCase) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerRemoveFromCalendar({ caseId: c.id });
    flash(res.status === 'error' ? (res.error ?? '取り消せませんでした') : 'Google カレンダーから取り消しました');
  }), [withBusy, flash]);
  const onAddToCalendar = useCallback((c: ButlerCase) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerAddToCalendar({ caseId: c.id });
    if (res.status === 'error') { flash(res.error ?? 'カレンダーに登録できませんでした'); return; }
    flash(calendarToast(res));
  }), [withBusy, flash]);
  const onAddToCalendarVia = useCallback((c: ButlerCase, target: 'google' | 'emclient') => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerAddToCalendar({ caseId: c.id, target });
    if (res.status === 'error') { flash(res.error ?? 'カレンダーに登録できませんでした'); return; }
    flash(calendarToast(res));
  }), [withBusy, flash]);

  const onSendNow = useCallback((o: OutboxItem) => withBusy(o.id, async () => {
    const res = await window.electronAPI.partnerSendNow({ outboxId: o.id });
    if (res.status === 'error') flash(res.error ?? '送信に失敗しました');
    else flash('送信しました');
    await refresh();
  }), [withBusy, flash, refresh]);

  const onCancelSend = useCallback((o: OutboxItem) => withBusy(o.id, async () => {
    const res = await window.electronAPI.partnerCancelSend({ outboxId: o.id });
    if (res.status === 'error') flash(res.error ?? '取り消しに失敗しました');
    else flash('送信を取り消しました');
    await refresh();
  }), [withBusy, flash, refresh]);

  const onFollowUp = useCallback(async (f: FollowUp, action: 'nudge' | 'snooze' | 'close' | 'draft', body?: string): Promise<string | undefined> => {
    let draft: string | undefined;
    await withBusy(f.id, async () => {
      const res = await window.electronAPI.partnerFollowUpAction({ id: f.id, action, body, days: action === 'snooze' ? 3 : undefined });
      if (res.status === 'error') { flash(res.error ?? '処理に失敗しました'); return; }
      if (action === 'draft') {
        draft = res.draft;
        if (res.draft) setState((prev) => prev ? { ...prev, followUps: prev.followUps.map((x) => x.id === f.id ? { ...x, nudgeDraft: res.draft } : x) } : prev);
        return;
      }
      if (action === 'nudge') flash(res.outboxId ? '催促を送信予定に載せました(取り消せます)' : 'eM Client の作成画面を開きました');
      if (action === 'snooze') flash('3日後にまた出します');
      if (action === 'close') flash('閉じました');
      await refresh();
    });
    return draft;
  }, [withBusy, flash, refresh]);

  const onUndoTidy = useCallback((g: ButlerGroup) => withBusy(g.id, async () => {
    const res = await window.electronAPI.partnerUndoTidy({ groupId: g.id });
    if (res.status === 'error') flash(res.error ?? '戻せませんでした');
    else flash(`${res.restored ?? g.items.length}通を受信箱へ戻しました`);
    await refresh();
  }), [withBusy, flash, refresh]);

  const onApproveGroup = useCallback((g: ButlerGroup, approved: boolean) => withBusy(g.id, async () => {
    const res = await window.electronAPI.approveButlerGroup({ groupId: g.id, approved });
    if (res.status === 'error') flash(res.error ?? '処理に失敗しました');
    else if (approved && res.moved) flash(`${res.moved}通をゴミ箱へ移動しました`);
    await refresh();
  }), [withBusy, flash, refresh]);

  // ---- キュー ----
  const groups = useMemo(() => groupQueue(state), [state]);
  const sections = useMemo(() => buildQueue(groups, openSections), [groups, openSections]);
  const flat = useMemo(() => flattenQueue(sections), [sections]);
  const selected: QueueItem | null = useMemo(() => flat.find((i) => i.id === selectedId) ?? null, [flat, selectedId]);

  // 選択が消えたら、先頭の「やること」を選ぶ
  useEffect(() => {
    if (selected) return;
    const first = flat.find((i) => i.section !== 'journal') ?? flat[0];
    setSelectedId(first ? first.id : null);
  }, [flat, selected]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-queue-row][aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const nothingToDo = loaded && !!state?.digest && groups.pending === 0 && groups.outboxActive.length === 0 && groups.followActive.length === 0;

  // ---- 上部の要約チップ(クリックで該当セクションへ) ----
  const [showCalendarBatch, setShowCalendarBatch] = useState(false);
  const missingCases = useMemo(() => groups.cases.filter((c) => c.status === 'open' && !!c.event && c.calendarStatus === 'missing'), [groups]);
  type SummaryKey = Section | 'missing';
  type SummaryTone = SectionTone | 'danger-outline';
  const summary = useMemo(() => ([
    { key: 'decide' as SummaryKey, label: '決める', n: groups.decisions.length, tone: 'danger' },
    { key: 'send' as SummaryKey, label: '送る', n: groups.sendables.length, tone: 'primary' },
    { key: 'act' as SummaryKey, label: 'やる', n: groups.actions.length, tone: 'ink' },
    { key: 'outbox' as SummaryKey, label: '送信予定', n: groups.outboxActive.length, tone: 'primary' },
    { key: 'followup' as SummaryKey, label: '返事待ち', n: groups.followActive.length, tone: 'warn' },
    { key: 'missing' as SummaryKey, label: '未登録', n: missingCases.length, tone: 'danger-outline' },
  ] as Array<{ key: SummaryKey; label: string; n: number; tone: SummaryTone }>).filter((s) => s.n > 0), [groups, missingCases]);
  const chipClass = (tone: SummaryTone) => (tone === 'danger-outline' ? 'bg-card text-danger border-danger/50 hover:bg-danger-soft' : SECTION_TONE_META[tone].chip);

  const sectionOf = useCallback((c: ButlerCase): Section => (
    groups.decisions.includes(c) ? 'decide' : groups.sendables.includes(c) ? 'send' : groups.actions.includes(c) ? 'act' : groups.fyi.includes(c) ? 'fyi' : 'later'
  ), [groups]);

  const jumpTo = useCallback((key: SummaryKey) => {
    let section: Section;
    let targetId: string | null = null;
    if (key === 'missing') {
      setShowCalendarBatch(true);
      return;
    }
    if (key === ('missing-jump' as SummaryKey)) {
      const c = missingCases[0];
      if (!c) return;
      section = sectionOf(c);
      targetId = `case:${c.id}`;
    } else {
      section = key;
    }
    setOpenSections((prev) => (prev[section] ? prev : { ...prev, [section]: true }));
    // 展開を待ってから選択・スクロール
    setTimeout(() => {
      const header = listRef.current?.querySelector(`[data-section="${section}"]`);
      header?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (targetId) setSelectedId(targetId);
      else {
        const first = listRef.current?.querySelector(`[data-section-rows="${section}"] [data-queue-row]`) as HTMLElement | null;
        const id = first?.getAttribute('data-queue-id');
        if (id) setSelectedId(id);
      }
    }, 30);
  }, [missingCases, sectionOf]);

  // 「見通し」などから案件を指定して来たとき(localStorage 'shirabe_pending_case' 経由)
  useEffect(() => {
    if (!state?.digest) return;
    let pending: string | null = null;
    try { pending = localStorage.getItem('shirabe_pending_case'); } catch { /* ignore */ }
    if (!pending) return;
    try { localStorage.removeItem('shirabe_pending_case'); } catch { /* ignore */ }
    const c = (state.digest.cases ?? []).find((x) => x.id === pending);
    if (!c) return;
    const section = sectionOf(c);
    setOpenSections((prev) => (prev[section] ? prev : { ...prev, [section]: true }));
    setTimeout(() => {
      setSelectedId(`case:${c.id}`);
      listRef.current?.querySelector(`[data-queue-id="case:${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: 'center' });
    }, 60);
  }, [state?.digest, sectionOf]);
  const canSendFor = (email: string) => !!state?.canSend?.[email];
  // IMAP か SMTP のどちらかが未設定のアカウント(= 下書き投入・送信が eM Client 直結になっていない)
  const unconnected = useMemo(() => (settings.selectedAccounts ?? []).filter((e) => !(state?.canSend?.[e] && state?.canTidy?.[e])), [settings.selectedAccounts, state?.canSend, state?.canTidy]);
  const sendDelay = settings.partnerSendDelayMinutes ?? 0;

  const toggleSection = (s: Section) => setOpenSections((prev) => ({ ...prev, [s]: !prev[s] }));

  // ---- 主操作(Enter) ----
  const primaryAction = useCallback((item: QueueItem) => {
    if (item.kind === 'case') {
      const { c, variant } = item;
      if (busy.has(c.id)) return;
      if (variant === 'send' && c.draft) void onSend(c);
      else if (variant === 'action' || variant === 'fyi') void onStatus(c, 'done');
      else if (variant === 'later') void onStatus(c, 'open');
    } else if (item.kind === 'outbox') {
      if (!busy.has(item.o.id) && (item.o.status === 'scheduled' || item.o.status === 'failed')) void onSendNow(item.o);
    } else if (item.kind === 'followup') {
      if (busy.has(item.f.id)) return;
      if (item.f.nudgeDraft) void onFollowUp(item.f, 'nudge', item.f.nudgeDraft);
      else void onFollowUp(item.f, 'draft');
    } else if (item.kind === 'group') {
      if (item.g.kind === 'tidied' && !item.g.undone && !busy.has(item.g.id)) void onUndoTidy(item.g);
    }
  }, [busy, onSend, onStatus, onSendNow, onFollowUp, onUndoTidy]);

  // ---- キーボード: j/k 移動、Enter 主操作、l 後で、x しない、e 下書き、1〜4 決める ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isComposingKey(e)) return;   // 日本語変換中・確定直後のキーは拾わない
      if (flat.length === 0) return;
      const idx = flat.findIndex((i) => i.id === selectedId);
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelectedId(flat[Math.min(flat.length - 1, idx + 1)].id); return; }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelectedId(flat[Math.max(0, idx <= 0 ? 0 : idx - 1)].id); return; }
      if (!selected) return;
      if (e.key === 'Enter') { if (isComposingKey(e)) return; e.preventDefault(); primaryAction(selected); return; }
      if (selected.kind === 'case') {
        const { c } = selected;
        if (busy.has(c.id)) return;
        if (e.key === 'l') { e.preventDefault(); void onStatus(c, 'later'); }
        else if (e.key === 'x') { e.preventDefault(); void onStatus(c, 'dismissed'); }
        else if (e.key === 'e') { e.preventDefault(); setEditRequest((n) => n + 1); }
        else if (e.key === 'w') { if (!busy.has(`handoff:${c.id}`)) { e.preventDefault(); setHandoffRequest((n) => n + 1); } }
        else if (e.key === 'd') { e.preventDefault(); setEmDraftRequest((n) => n + 1); }
        else if (/^[1-4]$/.test(e.key) && c.decision && !c.decision.answer) {
          const opt = c.decision.options[Number(e.key) - 1];
          if (opt) { e.preventDefault(); void onAnswer(c, opt); }
        }
      } else if (selected.kind === 'outbox') {
        if (e.key === 'x' && !busy.has(selected.o.id)) { e.preventDefault(); void onCancelSend(selected.o); }
      } else if (selected.kind === 'followup') {
        if (busy.has(selected.f.id)) return;
        if (e.key === 'l') { e.preventDefault(); void onFollowUp(selected.f, 'snooze'); }
        else if (e.key === 'x') { e.preventDefault(); void onFollowUp(selected.f, 'close'); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flat, selected, selectedId, busy, primaryAction, onStatus, onAnswer, onCancelSend, onFollowUp]);

  // ---- 描画 ----
  const mode = state?.mode ?? settings.partnerMode ?? 'assist';
  const digest = state?.digest ?? null;

  const renderDetail = (item: QueueItem) => {
    if (item.kind === 'case') {
      return (
        <CaseDetail
          c={item.c} variant={item.variant} canSend={canSendFor(item.c.accountEmail)} busy={busy.has(item.c.id)} handoffBusy={busy.has(`handoff:${item.c.id}`)} sendDelayMinutes={sendDelay}
          editRequest={editRequest} handoffRequest={handoffRequest} emDraftRequest={emDraftRequest}
          onStatus={onStatus} onRule={onRule} onDraft={onDraft} onSaveDraft={onSaveDraft} onSend={onSend} onAnswer={onAnswer}
          onDraftToEmClient={onDraftToEmClient} onHandoffPrepare={onHandoffPrepare} onHandoffOpen={onHandoffOpen} onPickFolder={onPickFolder} onAddToCalendar={onAddToCalendar} onAddToCalendarVia={onAddToCalendarVia} onRemoveFromCalendar={onRemoveFromCalendar} googleAccounts={googleAccounts} onAddToCalendarAs={onAddToCalendarAs} onHandoffCopy={onHandoffCopy} onCalendarCopy={onCalendarCopy}
        />
      );
    }
    if (item.kind === 'outbox') return <OutboxDetail o={item.o} busy={busy.has(item.o.id)} onSendNow={onSendNow} onCancel={onCancelSend} />;
    if (item.kind === 'followup') return <FollowUpDetail f={item.f} busy={busy.has(item.f.id)} canSend={canSendFor(item.f.accountEmail)} onAction={onFollowUp} />;
    if (item.kind === 'group') return <GroupDetail g={item.g} busy={busy.has(item.g.id)} onUndoTidy={onUndoTidy} onApprove={onApproveGroup} onRule={onRule} />;
    return <JournalDetail j={item.j} />;
  };

  const list = (
    <div ref={listRef} className="h-full overflow-y-auto bg-card">
      {nothingToDo && !running && (
        <div className="px-5 py-8 text-center border-b border-hairline">
          <div className="mx-auto w-9 h-9 rounded-full bg-ok-soft text-ok flex items-center justify-center mb-2">{Icon.check}</div>
          <p className="text-[14px] text-ink">片付いています。</p>
          <p className="text-[12px] text-ink-2 mt-0.5">{state?.nextRunAt ? `次は ${fmtTime(state.nextRunAt)} に確認します。` : '新着があれば「今すぐ確認」で読みに行きます。'}</p>
        </div>
      )}
      {sections.map((s) => {
        const tone = SECTION_TONE_META[s.tone];
        return (
        <section key={s.section}>
          <div className={`sticky top-0 z-10 sec-band ${tone.band}`} data-section={s.section}>
            <button
              onClick={() => s.collapsible && toggleSection(s.section)}
              className={`w-full flex items-center gap-2 px-4 h-8 text-left ${s.collapsible ? 'hover:brightness-[0.98]' : 'cursor-default'}`}
            >
              {s.collapsible && <span className={`opacity-70 transition-transform ${openSections[s.section] ? 'rotate-90' : ''}`}>{Icon.chevronRight}</span>}
              <span className="text-[12px] font-bold tracking-wide">{s.label}</span>
              <span className={`tnum text-[10.5px] min-w-[18px] px-1.5 h-[17px] inline-flex items-center justify-center rounded-full font-semibold ${s.count > 0 ? tone.badge : 'bg-card-2 text-ink-3'}`}>{s.count}</span>
              {s.hint && <span className="ml-auto text-[11px] opacity-70 font-normal truncate">{s.hint}</span>}
            </button>
          </div>
          {s.items.length === 0 && !s.collapsible && (
            <div className="px-4 py-2.5 text-[12px] text-ink-3 border-b border-hairline/70">ありません</div>
          )}
          <div data-section-rows={s.section}>
          {s.items.map((item) => (
            <div key={item.id} data-queue-id={item.id}>
              <QueueRow item={item} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />
              {!wide && item.id === selectedId && (
                <div className="border-b border-hairline bg-paper">{renderDetail(item)}</div>
              )}
            </div>
          ))}
          </div>
        </section>
        );
      })}
      {SECTION_ORDER.length > 0 && digest?.sources && digest.sources.length > 0 && (
        <p className="px-4 py-3 text-[10.5px] text-ink-3">参照: {digest.sources.join(', ')} · j/k 移動 · Enter 主操作 · l 後で · x しない · e 下書き · 1〜4 決める · w 作業 · d eM Client 下書き</p>
      )}
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-paper relative">
      {showCalendarBatch && (
        <CalendarBatchDialog cases={missingCases} targets={googleAccounts} onClose={() => setShowCalendarBatch(false)} onDone={flash} />
      )}
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 bg-ink text-paper rounded-md text-[12.5px] shadow-card">{toast}</div>
      )}

      {/* ゾーン A: 相棒(見出し・要約・しらべ・申し送り)。和紙より少し濃い帯の上に白カード */}
      <div className="px-6 pt-4 pb-5 flex-shrink-0 bg-paper-2 border-b border-hairline">
        <div className="flex items-center gap-4 mb-3">
          <h1 className="text-[22px] font-semibold text-ink tracking-tight flex-shrink-0">今日</h1>
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {summary.map((s) => (
              <button
                key={s.key}
                onClick={() => jumpTo(s.key)}
                title={`${s.label}へ`}
                className={`app-no-drag inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11.5px] transition-colors ${chipClass(s.tone)}`}
              >
                <span>{s.label}</span>
                <span className="tnum font-semibold">{s.n}</span>
              </button>
            ))}
          </div>
          <span className="ml-auto text-[12.5px] text-ink-2 flex-shrink-0">{todayLabel()}</span>
        </div>
        <BriefCard
          digest={digest} loaded={loaded} running={running} progress={progress} mascotMode={mascotMode}
          lastRunAt={state?.lastRunAt ?? null} nextRunAt={state?.nextRunAt ?? null}
          mode={mode} manual={!settings.partnerIntervalMinutes} onRunNow={runNow} onSettings={() => onNavigate('settings')} onNotice={flash}
        />
        {unconnected.length > 0 && (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-2.5 flex items-center gap-3 text-[12.5px] text-ink">
            <span className="text-warn flex-shrink-0">{Icon.draft}</span>
            <span className="flex-1 min-w-0">
              <span className="font-semibold">eM Client とまだ接続していません</span>
              <span className="text-ink-2">（{unconnected.length === (settings.selectedAccounts?.length ?? 0) ? '全アカウント' : unconnected.map((e) => e.split('@')[0]).join('・')}）。
              接続すると、下書きは eM Client の「下書き」に直接入り、送信は eM Client を開かずに相棒が行います。今は代わりに eM Client の作成画面を開いています。</span>
            </span>
            <PrimaryButton size="sm" onClick={() => onNavigate('settings')}>接続する</PrimaryButton>
          </div>
        )}
      </div>

      {/* ゾーン B(キュー)/ C(詳細): A との間 20px、B と C の間 16px */}
      <div className="flex-1 min-h-0 mx-6 mt-5 mb-6 flex gap-4">
        <div className={`${wide ? 'w-[440px] flex-shrink-0' : 'w-full'} h-full rounded-xl border border-hairline overflow-hidden bg-card shadow-card`}>
          {list}
        </div>
        {wide && (
          <div className="flex-1 min-w-0 h-full rounded-xl border border-hairline overflow-hidden bg-card shadow-card">
            {selected ? (
              <div className="h-full">{renderDetail(selected)}</div>
            ) : (
              <div className="h-full flex items-center justify-center text-[12.5px] text-ink-3">{loaded ? '左の一覧から選んでください' : '読み込んでいます…'}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
