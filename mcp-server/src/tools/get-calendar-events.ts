import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { dateToTicks, ticksToDate } from '../db/tick-converter.js';
import type { CalendarEventOutput } from '../types.js';

interface CalendarEventsParams {
  days_forward: number;
  days_back: number;
  account?: string;
}

function withDbSync<T>(
  accountUid: string,
  subdir: string,
  dbName: string,
  fn: (db: import('better-sqlite3').Database) => T,
): T {
  const db = openDbSync(accountUid, subdir, dbName);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function fetchEventsForAccount(
  accountEmail: string,
  startTicks: number,
  endTicks: number,
): CalendarEventOutput[] {
  const acc = findAccount(accountEmail);
  if (!acc.eventSubdir) return [];

  return withDbSync(acc.accountUid, acc.eventSubdir, 'event_index.dat', (db) => {
    const rows = db
      .prepare(
        `SELECT id, summary, description, location, start, end, status, type,
                organizerDisplayName, organizerAddress
         FROM EventItems
         WHERE end >= ? AND start <= ?
         ORDER BY start ASC`,
      )
      .all(startTicks, endTicks) as Array<{
      id: number;
      summary: string;
      description: string;
      location: string;
      start: number;
      end: number;
      status: number;
      type: number;
      organizerDisplayName: string;
      organizerAddress: string;
    }>;

    return rows.map((row) => {
      const startDate = ticksToDate(row.start) ?? new Date(0);
      const endDate = ticksToDate(row.end) ?? new Date(0);

      // All-day heuristic: duration is exactly a multiple of 24h and starts at midnight
      const durationMs = endDate.getTime() - startDate.getTime();
      const isAllDay =
        durationMs % (24 * 60 * 60 * 1000) === 0 &&
        startDate.getHours() === 0 &&
        startDate.getMinutes() === 0;

      return {
        id: row.id,
        summary: row.summary ?? '',
        description: row.description ?? '',
        location: row.location ?? '',
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        isAllDay,
        organizerName: row.organizerDisplayName ?? '',
        organizerAddress: row.organizerAddress ?? '',
        accountEmail,
      };
    });
  });
}

export function getCalendarEvents(params: CalendarEventsParams): CalendarEventOutput[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - params.days_back);
  const end = new Date(now);
  end.setDate(end.getDate() + params.days_forward);

  const startTicks = dateToTicks(start);
  const endTicks = dateToTicks(end);

  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  let allEvents: CalendarEventOutput[] = [];
  for (const acc of accounts) {
    try {
      const events = fetchEventsForAccount(acc.email, startTicks, endTicks);
      allEvents = allEvents.concat(events);
    } catch (e) {
      console.error(`Error reading events for ${acc.email}:`, e);
    }
  }

  allEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return allEvents;
}
