import { findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { ticksToISO } from '../db/tick-converter.js';
import type { MailDetail } from '../types.js';

interface MailDetailParams {
  mail_id: number;
  account: string;
}

function formatAddress(displayName: string | null, address: string | null): string {
  if (!address) return '';
  if (displayName) return `${displayName} <${address}>`;
  return address;
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

export function getMailDetail(params: MailDetailParams): MailDetail {
  const acc = findAccount(params.account);

  return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const row = db
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder
         FROM MailItems WHERE id = ?`,
      )
      .get(params.mail_id) as
      | {
          id: number;
          subject: string;
          date: number;
          preview: string;
          importance: number;
          flags: number;
          folder: number;
        }
      | undefined;

    if (!row) {
      throw new Error(`Mail not found: id=${params.mail_id} in ${params.account}`);
    }

    const addrs = db
      .prepare(
        `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
      )
      .all(params.mail_id) as Array<{
      type: number;
      displayName: string;
      address: string;
    }>;

    const fromAddr = addrs.find((a) => a.type === 1);
    const toAddrs = addrs.filter((a) => a.type === 3);
    const ccAddrs = addrs.filter((a) => a.type === 4);

    // Get folder name
    let folderName = '';
    try {
      const fdb = openDbSync(acc.accountUid, acc.mailSubdir, 'folders.dat');
      try {
        const fRow = fdb
          .prepare(`SELECT name FROM Folders WHERE id = ?`)
          .get(row.folder) as { name: string } | undefined;
        if (fRow) folderName = fRow.name;
      } finally {
        fdb.close();
      }
    } catch {
      // folders.dat may not exist
    }

    return {
      id: row.id,
      subject: row.subject ?? '',
      date: ticksToISO(row.date) ?? new Date(0).toISOString(),
      preview: row.preview ?? '',
      from: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
      to: toAddrs.map((a) => formatAddress(a.displayName, a.address)),
      cc: ccAddrs.map((a) => formatAddress(a.displayName, a.address)),
      folderName,
      isRead: (row.flags & 2) !== 0,
      isFlagged: (row.flags & 4) !== 0,
      importance: row.importance,
      accountEmail: params.account,
    };
  });
}
