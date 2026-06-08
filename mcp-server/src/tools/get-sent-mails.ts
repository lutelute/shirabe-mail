import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { dateToTicks, ticksToISO } from '../db/tick-converter.js';
import { formatAddress, withDbSync, getFolderInfo, escapeLike } from '../utils.js';
import type { MailSummary } from '../types.js';

interface SentMailsParams {
  days_back: number;
  account?: string;
  limit: number;
  keyword?: string;
}

function fetchSentForAccount(
  accountEmail: string,
  cutoffTicks: number,
  limit: number,
  keyword?: string,
): MailSummary[] {
  const acc = findAccount(accountEmail);

  // Read folders.dat once for both the folder name map and the Sent folder ids.
  const { folderMap, sentFolderIds: sentFolderIdSet } = getFolderInfo(
    acc.accountUid,
    acc.mailSubdir,
  );
  const sentFolderIds = [...sentFolderIdSet];

  if (sentFolderIds.length === 0) return [];

  return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const folderPlaceholders = sentFolderIds.map(() => '?').join(',');
    const keywordFilter = keyword
      ? "AND (subject LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')"
      : '';
    const params: (number | string)[] = [cutoffTicks, ...sentFolderIds];
    if (keyword) {
      const pattern = `%${escapeLike(keyword)}%`;
      params.push(pattern, pattern);
    }
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder, conversationId
         FROM MailItems
         WHERE date >= ? AND folder IN (${folderPlaceholders}) AND (flags & 65536) = 0
         ${keywordFilter}
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
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
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ? AND type IN (1, 3, 4)`,
    );

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number; displayName: string; address: string;
      }>;
      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3);
      const ccAddrs = addrs.filter((a) => a.type === 4);

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToISO(row.date) ?? new Date(0).toISOString(),
        preview: (row.preview ?? '').slice(0, 200),
        from: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
        to: toAddrs.length > 0 ? formatAddress(toAddrs[0].displayName, toAddrs[0].address) : '',
        ccCount: ccAddrs.length,
        folderName: folderMap.get(row.folder) ?? 'Sent',
        accountEmail,
        isFlagged: (row.flags & 4) !== 0,
        isRead: true, // Sent mails are always "read"
        conversationId: row.conversationId,
        hasMyReply: true, // These ARE sent by me
        threadCount: 1,
      };
    });
  });
}

export function getSentMails(params: SentMailsParams): { total: number; mails: MailSummary[] } {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - params.days_back);
  const cutoffTicks = dateToTicks(cutoff);

  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  let allMails: MailSummary[] = [];
  for (const acc of accounts) {
    try {
      const mails = fetchSentForAccount(acc.email, cutoffTicks, params.limit, params.keyword);
      allMails = allMails.concat(mails);
    } catch (e) {
      console.error(`Error reading sent mails for ${acc.email}:`, e);
    }
  }

  allMails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const limited = allMails.slice(0, params.limit);
  return { total: allMails.length, mails: limited };
}
