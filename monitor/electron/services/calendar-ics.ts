// === 予定 → ICS(eM Client / カレンダーの登録ダイアログに渡す) ===
// eM Client のカレンダー DB には書かない(起動中の SQLite を外から触らない)。ICS を開いて先生が「保存」する。

import { randomUUID } from 'crypto';
import type { CaseEvent } from '../../src/types/index';

function pad(n: number): string { return String(n).padStart(2, '0'); }

/** ローカル時刻の ISO/`YYYY-MM-DD HH:MM` を ICS の形式に */
export function toIcsDateTime(s: string): { value: string; allDay: boolean } | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  if (!m[4]) return { value: `${m[1]}${m[2]}${m[3]}`, allDay: true };
  return { value: `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`, allDay: false };
}

function esc(s: string): string {
  return (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\;');
}

function addDays(yyyymmdd: string, days: number): string {
  const d = new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)) + days);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function buildIcs(ev: CaseEvent & { description?: string }, now = new Date()): string {
  const start = toIcsDateTime(ev.start);
  if (!start) throw new Error(`予定の日時が読めません: ${ev.start}`);
  const allDay = ev.allDay || start.allDay;
  let dtstart: string;
  let dtend: string;
  if (allDay) {
    const s = start.value.slice(0, 8);
    const e = ev.end ? (toIcsDateTime(ev.end)?.value.slice(0, 8) ?? s) : s;
    dtstart = `DTSTART;VALUE=DATE:${s}`;
    dtend = `DTEND;VALUE=DATE:${addDays(e >= s ? e : s, 1)}`;
  } else {
    const e = ev.end ? toIcsDateTime(ev.end) : null;
    let endValue = e && !e.allDay ? e.value : '';
    if (!endValue) {
      // 終了が無ければ 1 時間
      const [, y, mo, d, h, mi] = start.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)!;
      const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h) + 1, Number(mi));
      endValue = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    }
    dtstart = `DTSTART;TZID=Asia/Tokyo:${start.value}`;
    dtend = `DTEND;TZID=Asia/Tokyo:${endValue}`;
  }
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shirabe//partner//JA',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${randomUUID()}@shirabe`,
    `DTSTAMP:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${esc(ev.title)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${esc(ev.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}


/**
 * Google カレンダーの「予定を作成」画面を、件名・日時・場所・メモを埋めた状態で開く URL。
 * OAuth 不要。先生が開いた画面で「保存」を押すと Google カレンダーに入る(eM Client にも同期される)。
 *  - 時刻あり: dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS + ctz=Asia/Tokyo(ローカル時刻として解釈)
 *  - 終日: dates=YYYYMMDD/YYYYMMDD(終了日は翌日、排他的)
 *  - authuser=<メール> でどの Google アカウントに入れるかを選ぶ
 */
export function googleCalendarTemplateUrl(ev: CaseEvent & { description?: string }, authuser?: string): string {
  const start = toIcsDateTime(ev.start);
  if (!start) throw new Error(`予定の日時が読めません: ${ev.start}`);
  const allDay = ev.allDay || start.allDay;
  let dates: string;
  if (allDay) {
    const s = start.value.slice(0, 8);
    const e = ev.end ? (toIcsDateTime(ev.end)?.value.slice(0, 8) ?? s) : s;
    dates = `${s}/${addDays(e >= s ? e : s, 1)}`;
  } else {
    const e = ev.end ? toIcsDateTime(ev.end) : null;
    let endValue = e && !e.allDay ? e.value : '';
    if (!endValue) {
      const [, y, mo, d, h, mi] = start.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)!;
      const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h) + 1, Number(mi));
      endValue = `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    }
    dates = `${start.value}/${endValue}`;
  }
  const q = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates });
  if (!allDay) q.set('ctz', 'Asia/Tokyo');
  if (ev.location) q.set('location', ev.location);
  if (ev.description) q.set('details', ev.description.slice(0, 1500));
  if (authuser) q.set('authuser', authuser);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
