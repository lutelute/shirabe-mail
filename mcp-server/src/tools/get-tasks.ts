import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { ticksToISO } from '../db/tick-converter.js';
import type { TaskOutput } from '../types.js';

interface GetTasksParams {
  account?: string;
  include_completed: boolean;
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

function fetchTasksForAccount(
  accountEmail: string,
  includeCompleted: boolean,
): TaskOutput[] {
  const acc = findAccount(accountEmail);
  if (!acc.taskSubdir) return [];

  return withDbSync(acc.accountUid, acc.taskSubdir, 'task_index.dat', (db) => {
    const completedFilter = includeCompleted ? '' : 'WHERE completed = 0 OR completed IS NULL';
    const rows = db
      .prepare(
        `SELECT id, summary, description, start, end, completed, status, percentComplete
         FROM TaskItems
         ${completedFilter}
         ORDER BY end ASC`,
      )
      .all() as Array<{
      id: number;
      summary: string;
      description: string;
      start: number;
      end: number;
      completed: number;
      status: number;
      percentComplete: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      summary: row.summary ?? '',
      description: row.description ?? '',
      start: ticksToISO(row.start),
      end: ticksToISO(row.end),
      completed: ticksToISO(row.completed),
      status: row.status,
      percentComplete: row.percentComplete,
      accountEmail,
    }));
  });
}

export function getTasks(params: GetTasksParams): TaskOutput[] {
  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  let allTasks: TaskOutput[] = [];
  for (const acc of accounts) {
    try {
      const tasks = fetchTasksForAccount(acc.email, params.include_completed);
      allTasks = allTasks.concat(tasks);
    } catch (e) {
      console.error(`Error reading tasks for ${acc.email}:`, e);
    }
  }

  return allTasks;
}
