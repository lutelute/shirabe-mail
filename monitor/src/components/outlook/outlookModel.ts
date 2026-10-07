// === 見通し: 1〜2 週間先までを日ごとに並べるためのモデル(純関数) ===
import type { ButlerCase, CalendarEvent, TaskItem, OutboxItem, FollowUp, PartnerState } from '../../types';

export type OutlookItem =
  | { kind: 'calendar'; key: string; day: string; sortMs: number; time: string | null; title: string; location?: string }
  | { kind: 'missing'; key: string; day: string; sortMs: number; time: string | null; title: string; caseId: string; from: string }
  | { kind: 'deadline'; key: string; day: string; sortMs: number; title: string; from: string; caseId: string; priority: ButlerCase['priority']; overdueDays: number }
  | { kind: 'task'; key: string; day: string; sortMs: number; title: string }
  | { kind: 'send'; key: string; day: string; sortMs: number; time: string; label: string; outboxId: string; status: OutboxItem['status'] };

export interface OutlookDay { day: string; date: Date; isToday: boolean; isWeekend: boolean; items: OutlookItem[] }

export interface OutlookData {
  days: OutlookDay[];
  later: OutlookItem[];
  counts: { deadlines: number; events: number; missing: number; followUps: number; sends: number };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseLocal(s: string): Date | null {
  const m = (s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
}

export function fmtDayHeading(d: Date, today: Date): string {
  const base = `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_JA[d.getDay()]})`;
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(today).getTime()) / 86_400_000);
  if (diff === 0) return `${base} 今日`;
  if (diff === 1) return `${base} 明日`;
  if (diff === 2) return `${base} 明後日`;
  return base;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function isActiveFollowUp(f: FollowUp, now: Date): boolean {
  if (f.status === 'open' || f.status === 'nudged') return true;
  return f.status === 'snoozed' && (!f.snoozeUntil || new Date(f.snoozeUntil).getTime() <= now.getTime());
}

/** 案件・カレンダー・タスク・送信予定を日ごとの箱に入れる */
export function buildOutlook(input: {
  state: PartnerState | null;
  events: CalendarEvent[];
  tasks: TaskItem[];
  rangeDays: number;
  now?: Date;
}): OutlookData {
  const now = input.now ?? new Date();
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const endMs = today.getTime() + input.rangeDays * 86_400_000;
  const days: OutlookDay[] = [];
  const byDay = new Map<string, OutlookItem[]>();
  for (let i = 0; i < input.rangeDays; i += 1) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const key = dayKey(d);
    const items: OutlookItem[] = [];
    byDay.set(key, items);
    days.push({ day: key, date: d, isToday: i === 0, isWeekend: d.getDay() === 0 || d.getDay() === 6, items });
  }
  const later: OutlookItem[] = [];
  const place = (item: OutlookItem) => {
    const bucket = byDay.get(item.day);
    if (bucket) bucket.push(item);
    else if (item.sortMs >= endMs) later.push(item);
  };

  // カレンダー
  const seenCal = new Set<string>();
  for (const e of input.events) {
    const s = e.start instanceof Date ? e.start : new Date(e.start);
    if (isNaN(s.getTime())) continue;
    const key = `${dayKey(s)}|${(e.summary || '').trim()}|${e.isAllDay ? 'allday' : hhmm(s)}`;
    if (seenCal.has(key)) continue;   // 複数アカウントに同じ予定
    seenCal.add(key);
    if (s.getTime() < today.getTime() && !e.isAllDay) continue;
    place({ kind: 'calendar', key: `cal-${e.accountEmail}-${e.id}`, day: dayKey(s), sortMs: e.isAllDay ? startOfDay(s).getTime() : s.getTime(), time: e.isAllDay ? null : hhmm(s), title: e.summary || '(無題)', location: e.location || undefined });
  }

  // 案件: 期限 / 未登録の予定
  const cases = (input.state?.digest?.cases ?? []).filter((c) => c.status === 'open' || c.status === 'later' || c.status === 'scheduled');
  let missing = 0;
  let deadlines = 0;
  for (const c of cases) {
    if (c.deadline) {
      const d = parseLocal(c.deadline);
      if (d) {
        const overdue = Math.round((today.getTime() - startOfDay(d).getTime()) / 86_400_000);
        const day = overdue > 0 ? todayKey : dayKey(d);
        const item: OutlookItem = { kind: 'deadline', key: `dl-${c.id}`, day, sortMs: overdue > 0 ? today.getTime() : startOfDay(d).getTime(), title: c.subject, from: c.fromName || c.fromAddress, caseId: c.id, priority: c.priority, overdueDays: Math.max(0, overdue) };
        if (byDay.has(day)) deadlines += 1;
        place(item);
      }
    }
    if (c.event && c.calendarStatus === 'missing') {
      const d = parseLocal(c.event.start);
      if (d && d.getTime() >= today.getTime()) {
        const item: OutlookItem = { kind: 'missing', key: `ev-${c.id}`, day: dayKey(d), sortMs: c.event.allDay ? startOfDay(d).getTime() : d.getTime(), time: c.event.allDay ? null : hhmm(d), title: c.event.title, caseId: c.id, from: c.fromName || c.fromAddress };
        if (byDay.has(item.day)) missing += 1;
        place(item);
      }
    }
  }

  // タスク(期限付き・未完了)
  for (const t of input.tasks) {
    if (!t.end || t.completed) continue;
    const d = t.end instanceof Date ? t.end : new Date(t.end);
    if (isNaN(d.getTime()) || d.getTime() < today.getTime()) continue;
    place({ kind: 'task', key: `task-${t.accountEmail}-${t.id}`, day: dayKey(d), sortMs: startOfDay(d).getTime() + 1, title: t.summary });
  }

  // 送信予定
  let sends = 0;
  for (const o of input.state?.outbox ?? []) {
    if (o.status !== 'scheduled' && o.status !== 'sending' && o.status !== 'failed') continue;
    const d = new Date(o.sendAt);
    if (isNaN(d.getTime())) continue;
    const day = d.getTime() < today.getTime() ? todayKey : dayKey(d);
    sends += 1;
    place({ kind: 'send', key: `ob-${o.id}`, day, sortMs: Math.max(d.getTime(), today.getTime()), time: hhmm(d), label: o.label, outboxId: o.id, status: o.status });
  }

  const order: Record<OutlookItem['kind'], number> = { deadline: 0, missing: 1, calendar: 2, task: 3, send: 4 };
  for (const d of days) d.items.sort((a, b) => a.sortMs - b.sortMs || order[a.kind] - order[b.kind]);
  later.sort((a, b) => a.sortMs - b.sortMs);

  const events = days.reduce((n, d) => n + d.items.filter((i) => i.kind === 'calendar' || i.kind === 'missing').length, 0);
  const followUps = (input.state?.followUps ?? []).filter((f) => isActiveFollowUp(f, now)).length;
  return { days, later: later.slice(0, 20), counts: { deadlines, events, missing, followUps, sends } };
}

export function fmtLaterDate(item: OutlookItem): string {
  const d = new Date(item.sortMs);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_JA[d.getDay()]})`;
}
