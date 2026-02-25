import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { dateToTicks, ticksToISO } from '../db/tick-converter.js';

interface DeadlineItemsParams {
  days_forward: number;
  account?: string;
  include_mail_deadlines: boolean;
}

interface DeadlineItem {
  type: 'calendar' | 'task' | 'mail';
  date: string; // ISO
  summary: string;
  detail: string;
  source: string; // account email or tool name
  urgency: 'overdue' | 'today' | 'this_week' | 'upcoming';
}

interface DeadlineResult {
  asOf: string; // ISO
  items: DeadlineItem[];
  counts: {
    overdue: number;
    today: number;
    this_week: number;
    upcoming: number;
  };
}

const DEADLINE_KEYWORDS = [
  '締切', '〆切', '期限', 'deadline', 'due', 'until', 'まで',
];

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

function classifyUrgency(dateStr: string): DeadlineItem['urgency'] {
  const itemDate = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);

  if (itemDate < today) return 'overdue';
  if (itemDate < tomorrow) return 'today';
  if (itemDate < weekEnd) return 'this_week';
  return 'upcoming';
}

function fetchCalendarDeadlines(
  accountEmail: string,
  startTicks: number,
  endTicks: number,
): DeadlineItem[] {
  const acc = findAccount(accountEmail);
  if (!acc.eventSubdir) return [];

  return withDbSync(acc.accountUid, acc.eventSubdir, 'event_index.dat', (db) => {
    const rows = db
      .prepare(
        `SELECT id, summary, description, location, start, end
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
    }>;

    return rows.map((row) => {
      const startISO = ticksToISO(row.start) ?? new Date(0).toISOString();
      return {
        type: 'calendar' as const,
        date: startISO,
        summary: row.summary ?? '',
        detail: row.location ? `場所: ${row.location}` : '',
        source: accountEmail,
        urgency: classifyUrgency(startISO),
      };
    });
  });
}

function fetchTaskDeadlines(
  accountEmail: string,
  startTicks: number,
  endTicks: number,
): DeadlineItem[] {
  const acc = findAccount(accountEmail);
  if (!acc.taskSubdir) return [];

  return withDbSync(acc.accountUid, acc.taskSubdir, 'task_index.dat', (db) => {
    // Include overdue tasks (end < now but not completed) and upcoming tasks
    const rows = db
      .prepare(
        `SELECT id, summary, description, start, end, completed, status, percentComplete
         FROM TaskItems
         WHERE (completed = 0 OR completed IS NULL)
           AND end IS NOT NULL AND end != 0
           AND end <= ?
         ORDER BY end ASC`,
      )
      .all(endTicks) as Array<{
      id: number;
      summary: string;
      description: string;
      start: number;
      end: number;
      completed: number;
      status: number;
      percentComplete: number;
    }>;

    return rows.map((row) => {
      const endISO = ticksToISO(row.end) ?? new Date(0).toISOString();
      return {
        type: 'task' as const,
        date: endISO,
        summary: row.summary ?? '',
        detail: row.percentComplete > 0 ? `進捗: ${row.percentComplete}%` : '',
        source: accountEmail,
        urgency: classifyUrgency(endISO),
      };
    });
  });
}

function fetchMailDeadlineMentions(
  accountEmail: string,
  cutoffTicks: number,
  limit: number,
): DeadlineItem[] {
  const acc = findAccount(accountEmail);

  return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    // Build keyword OR condition for subject search
    const conditions = DEADLINE_KEYWORDS.map(() => 'subject LIKE ?').join(' OR ');
    const params: (number | string)[] = [
      cutoffTicks,
      ...DEADLINE_KEYWORDS.map((k) => `%${k}%`),
      limit,
    ];

    const rows = db
      .prepare(
        `SELECT id, subject, date, preview
         FROM MailItems
         WHERE date >= ? AND (flags & 65536) = 0 AND (flags & 2) = 0
           AND (${conditions})
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
    }>;

    return rows.map((row) => {
      const dateISO = ticksToISO(row.date) ?? new Date(0).toISOString();
      return {
        type: 'mail' as const,
        date: dateISO,
        summary: row.subject ?? '',
        detail: (row.preview ?? '').slice(0, 100),
        source: accountEmail,
        urgency: classifyUrgency(dateISO),
      };
    });
  });
}

export function getDeadlineItems(params: DeadlineItemsParams): DeadlineResult {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + params.days_forward);

  // For calendar/task: include overdue items from the past too
  const startTicks = dateToTicks(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));
  const endTicks = dateToTicks(end);

  // For mail deadline keyword search: past 7 days
  const mailCutoff = new Date(now);
  mailCutoff.setDate(mailCutoff.getDate() - 7);
  const mailCutoffTicks = dateToTicks(mailCutoff);

  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  let allItems: DeadlineItem[] = [];

  for (const acc of accounts) {
    try {
      allItems = allItems.concat(
        fetchCalendarDeadlines(acc.email, startTicks, endTicks),
      );
    } catch (e) {
      console.error(`Error reading calendar deadlines for ${acc.email}:`, e);
    }

    try {
      allItems = allItems.concat(
        fetchTaskDeadlines(acc.email, startTicks, endTicks),
      );
    } catch (e) {
      console.error(`Error reading task deadlines for ${acc.email}:`, e);
    }

    if (params.include_mail_deadlines) {
      try {
        allItems = allItems.concat(
          fetchMailDeadlineMentions(acc.email, mailCutoffTicks, 30),
        );
      } catch (e) {
        console.error(`Error reading mail deadline mentions for ${acc.email}:`, e);
      }
    }
  }

  // Sort by date
  allItems.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const counts = {
    overdue: allItems.filter((i) => i.urgency === 'overdue').length,
    today: allItems.filter((i) => i.urgency === 'today').length,
    this_week: allItems.filter((i) => i.urgency === 'this_week').length,
    upcoming: allItems.filter((i) => i.urgency === 'upcoming').length,
  };

  return {
    asOf: now.toISOString(),
    items: allItems,
    counts,
  };
}
