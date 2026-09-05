import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { dateToTicks, ticksToISO } from '../db/tick-converter.js';
import { formatAddress, withDbSync, getFolderInfo } from '../utils.js';
import type { MailSummary } from '../types.js';

interface RecentMailsParams {
  days_back: number;
  account?: string;
  limit: number;
  include_read: boolean;
}

function fetchRecentForAccount(
  accountEmail: string,
  cutoffTicks: number,
  limit: number,
  includeRead: boolean,
): MailSummary[] {
  const acc = findAccount(accountEmail);

  return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const readFilter = includeRead ? '' : 'AND (flags & 2) = 0';
    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder, conversationId
         FROM MailItems
         WHERE date >= ? AND (flags & 65536) = 0 ${readFilter}
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(cutoffTicks, limit) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
      conversationId: string | null;
    }>;

    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ? AND type IN (1, 4, 5)`,
    );

    const { folderMap, sentFolderIds } = getFolderInfo(acc.accountUid, acc.mailSubdir);

    const threadInfoStmt = db.prepare(
      `SELECT COUNT(*) as cnt,
              SUM(CASE WHEN folder IN (${[...sentFolderIds].join(',') || '-1'}) THEN 1 ELSE 0 END) as myReplies
       FROM MailItems
       WHERE conversationId = ?`,
    );

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number; displayName: string; address: string;
      }>;
      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 4);
      const ccAddrs = addrs.filter((a) => a.type === 5);

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
        accountEmail,
        isFlagged: (row.flags & 4) !== 0,
        isRead: (row.flags & 2) !== 0,
        conversationId: row.conversationId,
        hasMyReply,
        threadCount,
      };
    });
  });
}

export function getRecentMails(params: RecentMailsParams): { total: number; mails: MailSummary[] } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - params.days_back);
  const cutoffTicks = dateToTicks(cutoff);

  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  let allMails: MailSummary[] = [];
  for (const acc of accounts) {
    try {
      const mails = fetchRecentForAccount(acc.email, cutoffTicks, params.limit, params.include_read);
      allMails = allMails.concat(mails);
    } catch (e) {
      console.error(`Error reading ${acc.email}:`, e);
    }
  }

  allMails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const limited = allMails.slice(0, params.limit);
  return { total: allMails.length, mails: limited };
}
