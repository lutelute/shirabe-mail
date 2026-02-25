import { findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { dateToTicks, ticksToISO } from '../db/tick-converter.js';
import type { MailSummary } from '../types.js';

interface FolderMailsParams {
  folder_id: number;
  account: string;
  year?: number;       // specific year (e.g. 2024). Overrides date_from/date_to.
  date_from?: string;  // ISO date string (e.g. "2023-04-01")
  date_to?: string;    // ISO date string (e.g. "2024-03-31")
  limit: number;
  include_subfolders: boolean;
}

function formatAddress(displayName: string | null, address: string | null): string {
  if (!address) return '';
  if (displayName) return `${displayName} <${address}>`;
  return address;
}

export function getFolderMails(params: FolderMailsParams): { total: number; mails: MailSummary[] } {
  const acc = findAccount(params.account);

  // Determine date range
  let fromTicks: number;
  let toTicks: number;

  if (params.year) {
    // Academic year or calendar year - use calendar year
    fromTicks = dateToTicks(new Date(params.year, 0, 1));
    toTicks = dateToTicks(new Date(params.year + 1, 0, 1));
  } else if (params.date_from || params.date_to) {
    fromTicks = params.date_from ? dateToTicks(new Date(params.date_from)) : 0;
    toTicks = params.date_to ? dateToTicks(new Date(params.date_to)) : dateToTicks(new Date());
  } else {
    // Default: all time (last 10 years)
    const tenYearsAgo = new Date();
    tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);
    fromTicks = dateToTicks(tenYearsAgo);
    toTicks = dateToTicks(new Date());
  }

  // Collect target folder IDs
  const folderIds = new Set<number>([params.folder_id]);

  if (params.include_subfolders) {
    try {
      const fdb = openDbSync(acc.accountUid, acc.mailSubdir, 'folders.dat');
      try {
        const allFolders = fdb
          .prepare(`SELECT id, parentFolderId FROM Folders`)
          .all() as Array<{ id: number; parentFolderId: number }>;

        // BFS to find all descendants
        const queue = [params.folder_id];
        while (queue.length > 0) {
          const parentId = queue.shift()!;
          for (const f of allFolders) {
            if (f.parentFolderId === parentId && !folderIds.has(f.id)) {
              folderIds.add(f.id);
              queue.push(f.id);
            }
          }
        }
      } finally {
        fdb.close();
      }
    } catch {
      // folders.dat may not exist
    }
  }

  // Fetch mails
  const mdb = openDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const folderList = [...folderIds].join(',');
    const rows = mdb
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder, conversationId
         FROM MailItems
         WHERE folder IN (${folderList})
           AND date >= ? AND date < ?
           AND (flags & 65536) = 0
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(fromTicks, toTicks, params.limit) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
      conversationId: string | null;
    }>;

    // Count total (without limit)
    const countRow = mdb
      .prepare(
        `SELECT COUNT(*) as cnt
         FROM MailItems
         WHERE folder IN (${folderList})
           AND date >= ? AND date < ?
           AND (flags & 65536) = 0`,
      )
      .get(fromTicks, toTicks) as { cnt: number };

    const addrStmt = mdb.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ? AND type IN (1, 3, 4)`,
    );

    // Folder names
    const folderMap = new Map<number, string>();
    const sentFolderIds = new Set<number>();
    try {
      const fdb = openDbSync(acc.accountUid, acc.mailSubdir, 'folders.dat');
      try {
        const fRows = fdb
          .prepare(`SELECT id, name FROM Folders`)
          .all() as Array<{ id: number; name: string }>;
        for (const f of fRows) {
          folderMap.set(f.id, f.name);
          const lower = f.name.toLowerCase();
          if (lower === 'sent' || lower === '送信済み' || lower === '送信箱' || lower === 'sent mail' || lower === 'sent items') {
            sentFolderIds.add(f.id);
          }
        }
      } finally {
        fdb.close();
      }
    } catch {
      // folders.dat may not exist
    }

    const threadInfoStmt = mdb.prepare(
      `SELECT COUNT(*) as cnt,
              SUM(CASE WHEN folder IN (${[...sentFolderIds].join(',') || '-1'}) THEN 1 ELSE 0 END) as myReplies
       FROM MailItems
       WHERE conversationId = ?`,
    );

    const mails: MailSummary[] = rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number; displayName: string; address: string;
      }>;
      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3);
      const ccAddrs = addrs.filter((a) => a.type === 4);

      let hasMyReply = false;
      let threadCount = 1;
      if (row.conversationId) {
        const info = threadInfoStmt.get(row.conversationId) as { cnt: number; myReplies: number };
        threadCount = info.cnt;
        hasMyReply = info.myReplies > 0;
      }

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToISO(row.date) ?? new Date(0).toISOString(),
        preview: (row.preview ?? '').slice(0, 200),
        from: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
        to: toAddrs.length > 0 ? formatAddress(toAddrs[0].displayName, toAddrs[0].address) : '',
        ccCount: ccAddrs.length,
        folderName: folderMap.get(row.folder) ?? '',
        accountEmail: params.account,
        isFlagged: (row.flags & 4) !== 0,
        isRead: (row.flags & 2) !== 0,
        conversationId: row.conversationId,
        hasMyReply,
        threadCount,
      };
    });

    return { total: countRow.cnt, mails };
  } finally {
    mdb.close();
  }
}
