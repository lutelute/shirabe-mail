import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PartnerState, ButlerCase, ButlerCaseStatus, ButlerGroup, OutboxItem, FollowUp, ViewType, HandoffTarget } from '../types';
import { useAppContext } from '../context/AppContext';
import BriefCard from '../components/partner/BriefCard';
import QueueRow from '../components/partner/QueueRow';
import CaseDetail from '../components/partner/CaseDetail';
import { OutboxDetail, FollowUpDetail, GroupDetail, JournalDetail } from '../components/partner/OtherDetails';
import { buildQueue, flattenQueue, SECTION_ORDER } from '../components/partner/queue';
import type { QueueItem, Section } from '../components/partner/queue';
import { groupQueue, useToast, useMediaQuery, todayLabel, fmtTime, Icon, HANDOFF_TARGET_LABEL } from '../components/partner/partnerUi';

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
    const un2 = window.electronAPI.onButlerProgress((p) => {
      setProgress(p);
      if (p.stage === 'done' || p.stage === 'error') {
        setRunning(false);
        setTimeout(() => setProgress(null), 4000);
        void refresh();
      } else {
        setRunning(true);
      }
    });
    return () => { mounted.current = false; un1(); un2(); };
  }, [refresh]);

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
      flash('eM Client の作成画面を開きました。内容を確認して送ってください');
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
    flash(res.fallback === 'compose' ? 'eM Client の作成画面を開きました' : 'eM Client の下書きに入れました(開いて送ってください)');
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
    flash(res.detail ?? `${HANDOFF_TARGET_LABEL[target]} で開きました`);
    await refresh();
  }), [withBusy, flash, refresh]);

  const onPickFolder = useCallback((c: ButlerCase) => withBusy(`handoff:${c.id}`, async () => {
    const res = await window.electronAPI.partnerPickFolder({ caseId: c.id });
    if (res.status === 'error') { flash(res.error ?? 'フォルダを選べませんでした'); return; }
    if (res.folder) {
      if (c.handoff) patchCase(c.id, { handoff: { ...c.handoff, folder: res.folder, folderExists: true } });
      flash('フォルダを変更しました');
      await refresh();
    }
  }), [withBusy, flash, patchCase, refresh]);

  const onAddToCalendar = useCallback((c: ButlerCase) => withBusy(c.id, async () => {
    const res = await window.electronAPI.partnerAddToCalendar({ caseId: c.id });
    if (res.status === 'error') { flash(res.error ?? 'カレンダーに登録できませんでした'); return; }
    flash('eM Client で登録ダイアログを開きました。保存すると次回の確認で消えます');
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
  const canSendFor = (email: string) => !!state?.canSend?.[email];
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
      if (flat.length === 0) return;
      const idx = flat.findIndex((i) => i.id === selectedId);
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setSelectedId(flat[Math.min(flat.length - 1, idx + 1)].id); return; }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setSelectedId(flat[Math.max(0, idx <= 0 ? 0 : idx - 1)].id); return; }
      if (!selected) return;
      if (e.key === 'Enter') { e.preventDefault(); primaryAction(selected); return; }
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
          onDraftToEmClient={onDraftToEmClient} onHandoffPrepare={onHandoffPrepare} onHandoffOpen={onHandoffOpen} onPickFolder={onPickFolder} onAddToCalendar={onAddToCalendar}
        />
      );
    }
    if (item.kind === 'outbox') return <OutboxDetail o={item.o} busy={busy.has(item.o.id)} onSendNow={onSendNow} onCancel={onCancelSend} />;
    if (item.kind === 'followup') return <FollowUpDetail f={item.f} busy={busy.has(item.f.id)} canSend={canSendFor(item.f.accountEmail)} onAction={onFollowUp} />;
    if (item.kind === 'group') return <GroupDetail g={item.g} busy={busy.has(item.g.id)} onUndoTidy={onUndoTidy} onApprove={onApproveGroup} onRule={onRule} />;
    return <JournalDetail j={item.j} />;
  };

  const list = (
    <div ref={listRef} className={`${wide ? 'w-[440px] flex-shrink-0 border-r border-hairline' : 'w-full'} h-full overflow-y-auto bg-card`}>
      {nothingToDo && !running && (
        <div className="px-5 py-8 text-center border-b border-hairline">
          <div className="mx-auto w-9 h-9 rounded-full bg-ok-soft text-ok flex items-center justify-center mb-2">{Icon.check}</div>
          <p className="text-[14px] text-ink">片付いています。</p>
          <p className="text-[12px] text-ink-2 mt-0.5">{state?.nextRunAt ? `次は ${fmtTime(state.nextRunAt)} に確認します。` : '新着があれば「今すぐ確認」で読みに行きます。'}</p>
        </div>
      )}
      {sections.map((s) => (
        <section key={s.section}>
          <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-hairline">
            <button
              onClick={() => s.collapsible && toggleSection(s.section)}
              className={`w-full flex items-center gap-2 px-4 h-9 text-left ${s.collapsible ? 'hover:bg-card-2' : 'cursor-default'}`}
            >
              {s.collapsible && <span className={`text-ink-3 transition-transform ${openSections[s.section] ? 'rotate-90' : ''}`}>{Icon.chevronRight}</span>}
              <span className="text-[12.5px] font-semibold text-ink">{s.label}</span>
              <span className={`tnum text-[11px] px-1.5 h-[18px] inline-flex items-center rounded-full ${s.section === 'decide' && s.count > 0 ? 'bg-warn-soft text-warn' : 'bg-card-2 text-ink-2'}`}>{s.count}</span>
              {s.hint && <span className="ml-auto text-[11px] text-ink-3 font-normal truncate">{s.hint}</span>}
            </button>
          </div>
          {s.items.length === 0 && !s.collapsible && (
            <div className="px-4 py-2.5 text-[12px] text-ink-3 border-b border-hairline/70">ありません</div>
          )}
          {s.items.map((item) => (
            <div key={item.id}>
              <QueueRow item={item} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />
              {!wide && item.id === selectedId && (
                <div className="border-b border-hairline bg-paper">{renderDetail(item)}</div>
              )}
            </div>
          ))}
        </section>
      ))}
      {SECTION_ORDER.length > 0 && digest?.sources && digest.sources.length > 0 && (
        <p className="px-4 py-3 text-[10.5px] text-ink-3">参照: {digest.sources.join(', ')} · j/k 移動 · Enter 主操作 · l 後で · x しない · e 下書き · 1〜4 決める · w 作業 · d eM Client 下書き</p>
      )}
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-paper relative">
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-3.5 py-2 bg-ink text-paper rounded-md text-[12.5px] shadow-card">{toast}</div>
      )}

      <div className="px-6 pt-4 pb-4 flex-shrink-0">
        <div className="flex items-baseline justify-between mb-3">
          <h1 className="text-[22px] font-semibold text-ink tracking-tight">今日</h1>
          <span className="text-[12.5px] text-ink-2">{todayLabel()}</span>
        </div>
        <BriefCard
          digest={digest} loaded={loaded} running={running} progress={progress}
          lastRunAt={state?.lastRunAt ?? null} nextRunAt={state?.nextRunAt ?? null}
          mode={mode} manual={!settings.partnerIntervalMinutes} onRunNow={runNow} onSettings={() => onNavigate('settings')}
        />
      </div>

      <div className="flex-1 min-h-0 mx-6 mb-6 rounded-xl border border-hairline overflow-hidden flex bg-card shadow-card">
        {list}
        {wide && (
          <div className="flex-1 min-w-0 h-full bg-paper">
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
