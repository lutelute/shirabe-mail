import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent, PartnerState, TaskItem, ViewType } from '../types';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { buildOutlook, fmtDayHeading, fmtLaterDate, isActiveFollowUp } from '../components/outlook/outlookModel';
import type { OutlookItem } from '../components/outlook/outlookModel';
import { Card, Mark, OIcon, SummaryChip, useMediaQuery, useToast } from '../components/outlook/outlookUi';
import Mascot from '../components/partner/Mascot';

// =====================================================================
// 見通し — 1〜2 週間先までを一画面で。いつ何の期限があり、どの予定が入っていて(未登録含む)、
// 誰の返事を待っていて、何が送信予定か。「今日」は目の前の処理用、ここは俯瞰用。
// =====================================================================

interface Props { onNavigate: (view: ViewType) => void }

const LS_RANGE = 'shirabe_outlook_range';
const PENDING_CASE_KEY = 'shirabe_pending_case';

function readRange(): 7 | 14 {
  try { return localStorage.getItem(LS_RANGE) === '14' ? 14 : 7; } catch { return 7; }
}

const PRIO_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function OutlookView({ onNavigate }: Props) {
  const [state, setState] = useState<PartnerState | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [range, setRange] = useState<7 | 14>(readRange);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, flash } = useToast();
  const wide = useMediaQuery('(min-width: 1180px)');
  const listRef = useRef<HTMLDivElement | null>(null);
  const dayRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    try {
      const [s, accounts] = await Promise.all([window.electronAPI.partnerGetState(), window.electronAPI.getAccounts()]);
      setState(s);
      const evs: CalendarEvent[] = [];
      const tks: TaskItem[] = [];
      await Promise.all(accounts.map(async (a) => {
        try { evs.push(...(await window.electronAPI.getEvents(a.email, 14))); } catch { /* カレンダーの無いアカウント */ }
        try { tks.push(...(await window.electronAPI.getTasks(a.email))); } catch { /* タスクの無いアカウント */ }
      }));
      setEvents(evs);
      setTasks(tks);
    } catch (e) {
      flash(e instanceof Error ? e.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const un = window.electronAPI.onPartnerState((s) => setState(s));
    return () => un();
  }, []);
  useAutoRefresh(5, () => { void load(); });

  const changeRange = (r: 7 | 14) => {
    setRange(r);
    try { localStorage.setItem(LS_RANGE, String(r)); } catch { /* ignore */ }
  };

  const data = useMemo(() => buildOutlook({ state, events, tasks, rangeDays: range }), [state, events, tasks, range]);
  const now = new Date();

  const followUps = useMemo(() => (state?.followUps ?? []).filter((f) => isActiveFollowUp(f, now)).sort((a, b) => b.daysWaiting - a.daysWaiting), [state]);
  const decisions = useMemo(
    () => (state?.digest?.cases ?? []).filter((c) => c.status === 'open' && c.decision && !c.decision.answer).sort((a, b) => (PRIO_ORDER[a.priority] ?? 9) - (PRIO_ORDER[b.priority] ?? 9)),
    [state],
  );
  const activity = useMemo(() => {
    const todayKey = now.toISOString().slice(0, 10);
    const todays = (state?.journal ?? []).filter((j) => j.at.slice(0, 10) === todayKey || new Date(j.at).toDateString() === now.toDateString());
    const count = (kind: string) => todays.filter((j) => j.kind === kind).length;
    return { sent: count('sent'), archived: count('archived'), scheduled: count('scheduled'), runs: count('run'), nudged: count('nudged') };
  }, [state]);

  const openCase = (caseId: string) => {
    try { localStorage.setItem(PENDING_CASE_KEY, caseId); } catch { /* ignore */ }
    onNavigate('today');
  };

  const addToCalendar = async (caseId: string) => {
    setBusy(caseId);
    try {
      const r = await window.electronAPI.partnerAddToCalendar({ caseId });
      flash(r.status === 'done'
        ? (r.target === 'emclient' ? 'eM Client で登録ダイアログを開きました。保存すると次回の確認で消えます' : `Google カレンダー${r.account ? `(${r.account})` : ''}の登録画面を開きました。「保存」を押してください`)
        : (r.error ?? '登録を開けませんでした'));
    } finally {
      setBusy(null);
    }
  };

  const jumpTo = (day: string | 'later') => {
    const el = dayRefs.current[day];
    if (el && listRef.current) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const firstDayWith = (pred: (i: OutlookItem) => boolean): string | 'later' | null => {
    for (const d of data.days) if (d.items.some(pred)) return d.day;
    if (data.later.some(pred)) return 'later';
    return null;
  };

  const renderItem = (it: OutlookItem) => {
    switch (it.kind) {
      case 'calendar':
        return (
          <div key={it.key} className="flex items-center gap-2.5 h-7 text-[13px]">
            <Mark kind="calendar" />
            <span className="w-11 tnum text-ink-2 flex-shrink-0">{it.time ?? '終日'}</span>
            <span className="truncate text-ink">{it.title}</span>
            {it.location && <span className="truncate text-[11.5px] text-ink-3">@{it.location}</span>}
          </div>
        );
      case 'missing':
        return (
          <div key={it.key} className="flex items-center gap-2.5 h-7 text-[13px] group">
            <Mark kind="missing" />
            <span className="w-11 tnum text-ink-2 flex-shrink-0">{it.time ?? '終日'}</span>
            <button onClick={() => openCase(it.caseId)} className="truncate text-ink hover:text-primary text-left">{it.title}</button>
            <span className="text-[10.5px] px-1.5 h-[18px] leading-[18px] rounded border border-danger/30 bg-danger-soft text-danger flex-shrink-0">未登録</span>
            <button onClick={() => void addToCalendar(it.caseId)} disabled={busy === it.caseId} className="ml-auto h-6 px-2 rounded-md text-[11.5px] bg-primary text-primary-ink hover:bg-primary-hover disabled:opacity-40 flex items-center gap-1 flex-shrink-0">
              {OIcon.plus}<span>登録</span>
            </button>
          </div>
        );
      case 'deadline':
        return (
          <div key={it.key} className="flex items-center gap-2.5 h-7 text-[13px]">
            <Mark kind="deadline" />
            <span className="w-11 text-[11.5px] text-danger flex-shrink-0">{it.overdueDays > 0 ? `超過${it.overdueDays}日` : '期限'}</span>
            <button onClick={() => openCase(it.caseId)} className={`truncate text-left hover:text-primary ${it.priority === 'P1' ? 'font-semibold text-ink' : 'text-ink'}`}>{it.title}</button>
            <span className="truncate text-[11.5px] text-ink-3 flex-shrink-0 max-w-[160px]">{it.from}</span>
          </div>
        );
      case 'task':
        return (
          <div key={it.key} className="flex items-center gap-2.5 h-7 text-[13px]">
            <Mark kind="task" />
            <span className="w-11 text-[11.5px] text-ink-3 flex-shrink-0">タスク</span>
            <span className="truncate text-ink">{it.title}</span>
          </div>
        );
      case 'send':
        return (
          <div key={it.key} className="flex items-center gap-2.5 h-7 text-[13px]">
            <Mark kind="send" />
            <span className="w-11 tnum text-ink-2 flex-shrink-0">{it.time}</span>
            <span className="truncate text-ink">送信 {it.label}</span>
            {it.status === 'failed' && <span className="text-[10.5px] px-1.5 h-[18px] leading-[18px] rounded border border-danger/30 bg-danger-soft text-danger flex-shrink-0">失敗</span>}
            {it.status === 'sending' && <span className="text-[10.5px] text-ink-3">送信中</span>}
          </div>
        );
    }
  };

  const empty = !loading && data.days.every((d) => d.items.length === 0) && data.later.length === 0;

  const aside = (
    <div className={`flex flex-col gap-3 ${wide ? 'w-[360px] flex-shrink-0' : ''}`}>
      <Card title="返事待ち" tone="warn" aside={<span className="text-[11px] opacity-80 tnum">{followUps.length}件</span>}>
        {followUps.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">返事を待っているものはありません。</p>
        ) : (
          <ul className="divide-y divide-hairline -my-1">
            {followUps.slice(0, 8).map((f) => (
              <li key={f.id} className="py-1.5 flex items-center gap-2 text-[12.5px]">
                <span className="w-10 tnum text-danger flex-shrink-0 font-medium">{f.daysWaiting}日</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">{f.to.split('<')[0].replace(/"/g, '').trim() || f.toAddress}</div>
                  <div className="truncate text-[11.5px] text-ink-3">{f.subject}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="決めてほしいこと" tone="danger" aside={<span className="text-[11px] opacity-80 tnum">{decisions.length}件</span>}>
        {decisions.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">今は決めることはありません。</p>
        ) : (
          <ul className="divide-y divide-hairline -my-1">
            {decisions.slice(0, 8).map((c) => (
              <li key={c.id} className="py-1.5">
                <button onClick={() => openCase(c.id)} className="w-full text-left group">
                  <div className="truncate text-[12.5px] text-ink group-hover:text-primary">{c.decision?.question}</div>
                  <div className="truncate text-[11.5px] text-ink-3">{c.fromName || c.fromAddress} · {c.subject}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="相棒の動き" tone="muted">
        <div className="flex items-start gap-3">
        <Mascot mode={state?.running ? 'working' : 'idle'} stage={state?.progress?.stage} size={40} bubble={false} className="flex-shrink-0 mt-0.5" />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px] flex-1 min-w-0">
          <dt className="text-ink-3">最終確認</dt><dd className="tnum text-ink">{fmtClock(state?.lastRunAt)}{state?.running ? '(確認中)' : ''}</dd>
          <dt className="text-ink-3">次回</dt><dd className="tnum text-ink">{fmtClock(state?.nextRunAt)}</dd>
          <dt className="text-ink-3">今日の動き</dt>
          <dd className="text-ink">
            送信 <span className="tnum">{activity.sent}</span> · 送信予定 <span className="tnum">{activity.scheduled}</span> · 片付け <span className="tnum">{activity.archived}</span> · 催促 <span className="tnum">{activity.nudged}</span>
          </dd>
          <dt className="text-ink-3">前回の確認</dt>
          <dd className="text-ink">新着 <span className="tnum">{state?.digest?.stats?.candidates ?? 0}</span> 通 → 案件 <span className="tnum">{state?.digest?.stats?.cases ?? 0}</span> 件</dd>
        </dl>
        </div>
      </Card>
    </div>
  );

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {toast && <div className="absolute top-3 right-6 z-30 px-3 py-1.5 bg-ink text-paper text-[12px] rounded-md shadow-card">{toast}</div>}
      <header className="flex items-center gap-3 px-6 pt-4 pb-4 flex-wrap bg-paper-2 border-b border-hairline flex-shrink-0">
        <h1 className="text-[22px] font-semibold text-ink leading-none">見通し</h1>
        <div className="flex items-center rounded-md border border-hairline overflow-hidden ml-1">
          {([7, 14] as const).map((r) => (
            <button key={r} onClick={() => changeRange(r)} className={`h-6 px-2.5 text-[11.5px] ${range === r ? 'bg-primary-soft text-primary' : 'text-ink-2 hover:bg-card-2'}`}>{r}日</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <SummaryChip label="期限" n={data.counts.deadlines} tone="danger" onClick={() => { const d = firstDayWith((i) => i.kind === 'deadline'); if (d) jumpTo(d); }} />
          <SummaryChip label="予定" n={data.counts.events} tone="primary" onClick={() => { const d = firstDayWith((i) => i.kind === 'calendar' || i.kind === 'missing'); if (d) jumpTo(d); }} />
          <SummaryChip label="未登録" n={data.counts.missing} tone="danger-outline" onClick={() => { const d = firstDayWith((i) => i.kind === 'missing'); if (d) jumpTo(d); }} />
          <SummaryChip label="返事待ち" n={data.counts.followUps} tone="warn" />
          <SummaryChip label="送信予定" n={data.counts.sends} tone="primary" onClick={() => { const d = firstDayWith((i) => i.kind === 'send'); if (d) jumpTo(d); }} />
          <button onClick={() => void load()} title="更新" className="h-6 w-6 rounded-md text-ink-3 hover:text-ink hover:bg-card-2 flex items-center justify-center">{OIcon.refresh}</button>
        </div>
      </header>

      <div className={`flex-1 overflow-hidden px-6 pt-5 pb-5 ${wide ? 'flex gap-4' : 'overflow-y-auto'}`}>
        <div ref={listRef} className={`${wide ? 'flex-1 overflow-y-auto pr-1' : ''}`}>
          {loading && !state ? (
            <p className="text-[13px] text-ink-3 py-6">読み込んでいます…</p>
          ) : empty ? (
            <p className="text-[13px] text-ink-3 py-6">この範囲に期限や予定はありません。</p>
          ) : (
            <div className="bg-card border border-hairline rounded-lg shadow-card divide-y divide-hairline">
              {data.days.map((d) => (
                <div key={d.day} ref={(el) => { dayRefs.current[d.day] = el; }}>
                  <div className={`flex items-center h-8 px-4 text-[12px] font-bold tracking-wide ${d.isToday ? 'bg-primary-soft text-primary' : d.isWeekend ? 'bg-card-2 text-ink-3' : 'bg-card text-ink'}`}>
                    {fmtDayHeading(d.date, now)}
                    {d.items.length > 0 && <span className={`ml-2 tnum text-[10.5px] min-w-[18px] px-1.5 h-[17px] inline-flex items-center justify-center rounded-full font-semibold ${d.isToday ? 'bg-primary text-primary-ink' : 'bg-card-2 text-ink-2'}`}>{d.items.length}</span>}
                  </div>
                  <div className="px-5 py-1.5">
                    {d.items.length === 0 ? <div className="h-6 text-[12px] text-hairline-2">—</div> : d.items.map(renderItem)}
                  </div>
                </div>
              ))}
              {data.later.length > 0 && (
                <div ref={(el) => { dayRefs.current.later = el; }}>
                  <div className="flex items-center h-8 px-4 text-[12px] font-bold tracking-wide bg-card-2 text-ink-2">それ以降<span className="ml-2 tnum text-[10.5px] min-w-[18px] px-1.5 h-[17px] inline-flex items-center justify-center rounded-full font-semibold bg-card text-ink-2">{data.later.length}</span></div>
                  <div className="px-5 py-1.5">
                    {data.later.map((it) => (
                      <div key={`later-${it.key}`} className="flex items-center gap-2.5">
                        <span className="w-16 text-[11.5px] text-ink-3 tnum flex-shrink-0">{fmtLaterDate(it)}</span>
                        <div className="min-w-0 flex-1">{renderItem(it)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {!wide && <div className="mt-4">{aside}</div>}
        </div>
        {wide && aside}
      </div>
    </div>
  );
}
