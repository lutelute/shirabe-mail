import { ACCOUNTS } from '../db/accounts.js';
import type { AccountInfo } from '../types.js';

export function getAccounts(): AccountInfo[] {
  return ACCOUNTS.map((acc) => ({
    email: acc.email,
    label: acc.label,
    type: acc.type,
    hasCalendar: acc.eventSubdir !== null,
    hasTasks: acc.taskSubdir !== null,
  }));
}
