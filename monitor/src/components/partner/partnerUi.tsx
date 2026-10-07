import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ButlerPriority, ButlerCaseCategory, SenderTier, PartnerMode, ButlerCase, PartnerState, OutboxItem, FollowUp, ButlerGroup, JournalEntry, CaseEvent, HandoffTarget } from '../../types';

// =====================================================================
// 相棒 UI の共通部品 — 「机の上の相棒」トークン(paper/card/ink/primary/danger/warn/ok)
// =====================================================================

// ---- 表示メタ ----
export const PRIORITY_META: Record<ButlerPriority, { label: string; cls: string; bar: string }> = {
  P1: { label: '今日', cls: 'bg-danger-soft text-danger border-danger/30', bar: 'bg-danger' },
  P2: { label: '今週', cls: 'bg-warn-soft text-warn border-warn/30', bar: 'bg-warn' },
  P3: { label: 'いずれ', cls: 'bg-card-2 text-ink-2 border-hairline', bar: 'bg-hairline-2' },
  P4: { label: '参考', cls: 'bg-card-2 text-ink-3 border-hairline', bar: 'bg-hairline' },
};

export const CATEGORY_META: Record<ButlerCaseCategory, { label: string; cls: string }> = {
  reply: { label: '要返信', cls: 'bg-primary-soft text-primary border-primary/30' },
  action: { label: '要対応', cls: 'bg-warn-soft text-warn border-warn/30' },
  fyi: { label: '参考', cls: 'bg-card-2 text-ink-2 border-hairline' },
  noise: { label: '不要', cls: 'bg-card-2 text-ink-3 border-hairline' },
  spam: { label: '迷惑', cls: 'bg-danger-soft text-danger border-danger/30' },
  unknown: { label: '未判定', cls: 'bg-card-2 text-ink-3 border-hairline' },
};

export const TIER_META: Record<SenderTier, { label: string; cls: string }> = {
  vip: { label: '常連', cls: 'bg-ok-soft text-ok border-ok/30' },
  internal: { label: '学内', cls: 'bg-ok-soft text-ok border-ok/30' },
  known: { label: '面識あり', cls: 'bg-primary-soft text-primary border-primary/30' },
  auto: { label: '自動送信', cls: 'bg-card-2 text-ink-3 border-hairline' },
  unknown: { label: '初見', cls: 'bg-card-2 text-ink-2 border-hairline' },
  noise: { label: '不要(学習)', cls: 'bg-card-2 text-ink-3 border-hairline' },
};

export const MODE_LABEL: Record<PartnerMode, string> = {
  observe: '見るだけ',
  assist: '下書きまで',
  delegate: '任せる',
};

export const STAGE_LABEL: Record<string, string> = {
  collect: '集めています',
  classify: '判断しています',
  draft: '下書きを用意しています',
  brief: 'まとめています',
  tidy: '片付けています',
  watch: '返事待ちを見ています',
  done: '完了',
  error: 'エラー',
};

// ---- 日付・時間 ----
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function daysLeft(deadline: string | null | undefined): number | null {
  if (!deadline) return null;
  const t = new Date(`${deadline}T00:00:00`);
  if (isNaN(t.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t.getTime() - today.getTime()) / 86_400_000);
}

/** 残り時間を「2分30秒」「1時間5分」のように */
export function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'まもなく';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}分${String(rs).padStart(2, '0')}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  return `${h}時間${m % 60}分`;
}

export function todayLabel(): string {
  return new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

export function addrOf(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from;
}

export function nameOf(from: string): string {
  const m = from.match(/^(.*?)\s*<[^>]+>/);
  return (m?.[1] ?? from).replace(/^"|"$/g, '').trim() || from;
}

// ---- 案件の振り分け(「今日」画面とレールのバッジで共有) ----
export interface QueueGroups {
  cases: ButlerCase[];
  decisions: ButlerCase[];
  sendables: ButlerCase[];
  actions: ButlerCase[];
  fyi: ButlerCase[];
  later: ButlerCase[];
  tidied: ButlerGroup[];
  noise: ButlerGroup[];
  spamPending: ButlerGroup[];
  tidiedCount: number;
  outboxActive: OutboxItem[];
  followActive: FollowUp[];
  journal: JournalEntry[];
  pending: number;   // 決める + 送る + やる
}

export function isFollowUpActive(f: FollowUp): boolean {
  if (f.status === 'open' || f.status === 'nudged') return true;
  if (f.status === 'snoozed') return !f.snoozeUntil || new Date(f.snoozeUntil).getTime() <= Date.now();
  return false;
}

export function groupQueue(state: PartnerState | null): QueueGroups {
  const cases = state?.digest?.cases ?? [];
  const open = cases.filter((c) => c.status === 'open');
  const decisions = open.filter((c) => c.decision && !c.decision.answer);
  const decided = new Set(decisions.map((c) => c.id));
  const sendables = open.filter((c) => !decided.has(c.id) && c.category === 'reply' && (!!c.draft || c.needsDraft));
  const sendableIds = new Set(sendables.map((c) => c.id));
  const actions = open.filter((c) => !decided.has(c.id) && !sendableIds.has(c.id) && (c.category === 'action' || (c.category === 'reply' && !c.draft && !c.needsDraft)));
  const fyi = open.filter((c) => c.category === 'fyi');
  const later = cases.filter((c) => c.status === 'later');
  const groups = state?.digest?.groups ?? [];
  const tidied = groups.filter((g) => g.kind === 'tidied');
  const noise = groups.filter((g) => g.kind === 'noise_list');
  const spamPending = groups.filter((g) => g.kind === 'spam_delete' && (g.status === 'pending' || g.status === 'failed'));
  const tidiedCount = [...tidied, ...noise, ...spamPending].reduce((n, g) => n + g.items.length, 0);
  const outboxActive = (state?.outbox ?? []).filter((o) => o.status === 'scheduled' || o.status === 'sending' || o.status === 'failed');
  const followActive = (state?.followUps ?? []).filter(isFollowUpActive).sort((a, b) => b.daysWaiting - a.daysWaiting);
  const journal = [...(state?.journal ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  return {
    cases, decisions, sendables, actions, fyi, later, tidied, noise, spamPending, tidiedCount, outboxActive, followActive, journal,
    pending: decisions.length + sendables.length + actions.length,
  };
}

// ---- 小部品 ----
export function Chip({ label, cls, title, mono }: { label: string; cls: string; title?: string; mono?: boolean }) {
  return <span title={title} className={`inline-flex items-center h-[18px] px-1.5 rounded border text-[10.5px] leading-none whitespace-nowrap ${mono ? 'tnum' : ''} ${cls}`}>{label}</span>;
}

export function DeadlineChip({ deadline, compact }: { deadline: string | null | undefined; compact?: boolean }) {
  if (!deadline) return null;
  const d = daysLeft(deadline);
  const [, m, day] = deadline.split('-');
  const label = `${Number(m)}/${Number(day)}`;
  let cls = 'bg-card-2 text-ink-2 border-hairline';
  let tail = '';
  if (d !== null) {
    if (d < 0) { cls = 'bg-danger-soft text-danger border-danger/40'; tail = `${-d}日超過`; }
    else if (d === 0) { cls = 'bg-danger-soft text-danger border-danger/40'; tail = '今日'; }
    else if (d <= 2) { cls = 'bg-danger-soft text-danger border-danger/30'; tail = `あと${d}日`; }
    else if (d <= 7) { cls = 'bg-warn-soft text-warn border-warn/30'; tail = `あと${d}日`; }
    else tail = `あと${d}日`;
  }
  return <Chip mono label={compact ? `${label}${tail ? ` ${tail}` : ''}` : `期限 ${label}${tail ? ` · ${tail}` : ''}`} cls={cls} />;
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block w-3 h-3 rounded-full border-2 border-hairline-2 border-t-ink-2 animate-spin ${className}`} />;
}

type BtnProps = { children: ReactNode; onClick: () => void; disabled?: boolean; title?: string; className?: string; size?: 'sm' | 'md' | 'lg' };

const SIZE: Record<NonNullable<BtnProps['size']>, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-[13px]',
  lg: 'h-9 px-4 text-[13px]',
};

export function PrimaryButton({ children, onClick, disabled, title, className = '', size = 'md' }: BtnProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`app-no-drag inline-flex items-center gap-1.5 rounded-md font-medium bg-primary text-primary-ink hover:bg-primary-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${SIZE[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function SubtleButton({ children, onClick, disabled, title, danger, className = '', size = 'md' }: BtnProps & { danger?: boolean }) {
  const cls = danger
    ? 'bg-card text-danger border-danger/30 hover:bg-danger-soft'
    : 'bg-card text-ink-2 border-hairline hover:bg-card-2 hover:text-ink';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`app-no-drag inline-flex items-center gap-1.5 rounded-md border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${SIZE[size]} ${cls} ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, onClick, disabled, title, className = '' }: BtnProps) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} className={`app-no-drag inline-flex items-center gap-1 h-7 px-2 rounded text-xs text-ink-2 hover:text-ink hover:bg-card-2 transition-colors disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

/** 小さなトースト */
export function useToast(): { toast: string | null; flash: (msg: string) => void } {
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { toast, flash };
}

/** 1秒ごとに now を更新(カウントダウン用) */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

/** メディアクエリ */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState<boolean>(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatch(e.matches);
    setMatch(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return match;
}

/** 高さが内容に追従する textarea */
export function AutoTextarea({ value, onChange, placeholder, className = '', minRows = 4, autoFocus, inputRef }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; minRows?: number; autoFocus?: boolean; inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, minRows * 22)}px`;
  }, [value, minRows]);
  return (
    <textarea
      ref={(el) => { ref.current = el; inputRef?.(el); }}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={minRows}
      className={`draft-editor draft-text w-full px-3 py-2.5 bg-card text-ink border border-hairline rounded-md focus:border-primary/60 ${className}`}
    />
  );
}

/** 線画アイコン(1.5px) */
export const Icon = {
  send: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.5 12h15m0 0l-6-6m6 6l-6 6" /></svg>
  ),
  check: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.5 12.75l6 6 9-13.5" /></svg>
  ),
  clock: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" /></svg>
  ),
  x: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" /></svg>
  ),
  external: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
  ),
  refresh: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
  ),
  star: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" /></svg>
  ),
  ban: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
  ),
  undo: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>
  ),
  chevronRight: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
  ),
  terminal: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" /></svg>
  ),
  folder: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
  ),
  calendar: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" /></svg>
  ),
  draft: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
  ),
};

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/** 予定の日時を短く: 10/29(木) 17:00〜19:00 / 10/29(木) 終日 */
export function fmtEvent(ev: CaseEvent): string {
  const parse = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const s = parse(ev.start);
  if (!s) return ev.start;
  const day = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const e = parse(ev.end);
  if (ev.allDay || /^\d{4}-\d{2}-\d{2}$/.test(ev.start)) {
    if (e && day(e) !== day(s)) return `${day(s)}〜${day(e)}`;
    return `${day(s)} 終日`;
  }
  let out = `${day(s)} ${hm(s)}`;
  if (e) out += day(e) === day(s) ? `〜${hm(e)}` : `〜${day(e)} ${hm(e)}`;
  return out;
}

export const HANDOFF_TARGET_LABEL: Record<HandoffTarget, string> = { terminal: 'ターミナル', finderai: 'FinderAI', folder: 'Finder' };
