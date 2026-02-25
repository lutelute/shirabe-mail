import { findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { dateToTicks, ticksToISO } from '../db/tick-converter.js';
import type { MailSummary } from '../types.js';

interface ScanHistoricalEmailsParams {
  account: string;
  date_from: string;   // ISO date string (e.g. "2023-01-01")
  date_to: string;     // ISO date string (e.g. "2025-12-31")
  topic?: string;      // optional keyword filter
  limit: number;       // default 100
  offset: number;      // default 0
}

interface KeyThread {
  conversationId: string;
  subject: string;
  messageCount: number;
  lastDate: string;
}

interface ScanHistoricalEmailsResult {
  totalCount: number;
  scannedCount: number;
  monthlyActivity: Record<string, number>;
  keyThreads: KeyThread[];
  mails: MailSummary[];
}

/** .NET epoch offset in ticks (used for SQLite date grouping) */
const EPOCH_OFFSET_TICKS = 621355968000000000;

/** 100-nanosecond intervals per second */
const TICKS_PER_SECOND = 10000000;

function formatAddress(displayName: string | null, address: string | null): string {
  if (!address) return '';
  if (displayName) return `${displayName} <${address}>`;
  return address;
}

export function scanHistoricalEmails(params: ScanHistoricalEmailsParams): ScanHistoricalEmailsResult {
  const acc = findAccount(params.account);

  const fromTicks = dateToTicks(new Date(params.date_from));
  const toTicks = dateToTicks(new Date(params.date_to));

  // Build dynamic WHERE clause with optional topic filter
  const conditions = [
    'date >= ? AND date < ?',
    '(flags & 65536) = 0',
  ];
  const bindParams: (number | string)[] = [fromTicks, toTicks];

  if (params.topic) {
    const pattern = `%${params.topic}%`;
    conditions.push('(subject LIKE ? OR preview LIKE ?)');
    bindParams.push(pattern, pattern);
  }

  const whereClause = conditions.join(' AND ');

  const mdb = openDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    // 1. Total count (full range, not paginated)
    const countRow = mdb
      .prepare(`SELECT COUNT(*) as cnt FROM MailItems WHERE ${whereClause}`)
      .get(...bindParams) as { cnt: number };

    // 2. Monthly activity — convert .NET ticks to unix seconds in SQL for strftime grouping
    //    SQLite supports 64-bit integers, so (date - EPOCH_OFFSET) / TICKS_PER_SECOND is safe.
    const monthlyRows = mdb
      .prepare(
        `SELECT strftime('%Y-%m', (date - ${EPOCH_OFFSET_TICKS}) / ${TICKS_PER_SECOND}, 'unixepoch') as month,
                COUNT(*) as cnt
         FROM MailItems
         WHERE ${whereClause}
         GROUP BY month
         ORDER BY month`,
      )
      .all(...bindParams) as Array<{ month: string; cnt: number }>;

    const monthlyActivity: Record<string, number> = {};
    for (const row of monthlyRows) {
      if (row.month) {
        monthlyActivity[row.month] = row.cnt;
      }
    }

    // 3. Key threads — top conversations by message count within the date range
    const threadRows = mdb
      .prepare(
        `SELECT conversationId, MAX(subject) as subject, COUNT(*) as cnt, MAX(date) as lastDate
         FROM MailItems
         WHERE ${whereClause} AND conversationId IS NOT NULL
         GROUP BY conversationId
         ORDER BY cnt DESC
         LIMIT 20`,
      )
      .all(...bindParams) as Array<{
      conversationId: string;
      subject: string;
      cnt: number;
      lastDate: number;
    }>;

    const keyThreads: KeyThread[] = threadRows.map((row) => ({
      conversationId: row.conversationId,
      subject: row.subject ?? '',
      messageCount: row.cnt,
      lastDate: ticksToISO(row.lastDate) ?? new Date(0).toISOString(),
    }));

    // 4. Paginated mail results (LIMIT/OFFSET to avoid OOM on multi-year ranges)
    const rows = mdb
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder, conversationId
         FROM MailItems
         WHERE ${whereClause}
         ORDER BY date DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...bindParams, params.limit, params.offset) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
      conversationId: string | null;
    }>;

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

    return {
      totalCount: countRow.cnt,
      scannedCount: mails.length,
      monthlyActivity,
      keyThreads,
      mails,
    };
  } finally {
    mdb.close();
  }
}
