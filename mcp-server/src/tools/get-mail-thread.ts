import { ACCOUNTS, findAccount, type AccountConfig } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { ticksToISO } from '../db/tick-converter.js';

interface MailThreadParams {
  mail_id: number;
  account: string;
}

interface ThreadMessage {
  id: number;
  subject: string;
  date: string;
  preview: string;
  from: string;
  to: string[];
  cc: string[];
  folderName: string;
  isRead: boolean;
  isSentByMe: boolean;
  sourceAccount: string;
}

interface CrossAccountSent {
  id: number;
  subject: string;
  date: string;
  to: string[];
  cc: string[];
  sourceAccount: string;
}

interface RelatedThread {
  conversationId: string;
  messageCount: number;
  latestDate: string;
  latestSubject: string;
  latestFrom: string;
  sourceAccount: string;
}

interface ThreadResult {
  conversationId: string;
  normalizedSubject: string;
  messageCount: number;
  myRepliesInThread: number;
  myRepliesAcrossAccounts: number;
  myRole: 'direct_recipient' | 'cc_recipient' | 'sender' | 'unknown';
  participants: string[];
  messages: ThreadMessage[];
  crossAccountSentMails: CrossAccountSent[];
  relatedThreads: RelatedThread[];
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

/** Strip Re:/RE:/Fw:/Fwd:/Re[N]: prefixes and whitespace */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(Re|RE|Fw|FW|Fwd|転送|返信)\s*(\[\d+\])?\s*:\s*)+/g, '')
    .trim();
}

function getSentFolderIds(accountUid: string, mailSubdir: string): Set<number> {
  const sentFolderIds = new Set<number>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        const lower = f.name.toLowerCase();
        if (
          lower === 'sent' || lower === '送信済み' || lower === '送信箱' ||
          lower === 'sent mail' || lower === 'sent items'
        ) {
          sentFolderIds.add(f.id);
        }
      }
    } finally {
      fdb.close();
    }
  } catch {
    // folders.dat may not exist
  }
  return sentFolderIds;
}

function getFolderMap(accountUid: string, mailSubdir: string): Map<number, string> {
  const folderMap = new Map<number, string>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        folderMap.set(f.id, f.name);
      }
    } finally {
      fdb.close();
    }
  } catch {
    // folders.dat may not exist
  }
  return folderMap;
}

/** Search all accounts' Sent folders for mails with matching normalized subject */
function searchCrossAccountSent(
  normalizedSubj: string,
  excludeAccount: string,
): CrossAccountSent[] {
  const results: CrossAccountSent[] = [];

  for (const acc of ACCOUNTS) {
    if (acc.email === excludeAccount) continue;

    try {
      const sentIds = getSentFolderIds(acc.accountUid, acc.mailSubdir);
      if (sentIds.size === 0) continue;

      withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
        const folderList = [...sentIds].join(',');
        const rows = db
          .prepare(
            `SELECT id, subject, date FROM MailItems
             WHERE folder IN (${folderList})
             ORDER BY date DESC
             LIMIT 200`,
          )
          .all() as Array<{ id: number; subject: string; date: number }>;

        const addrStmt = db.prepare(
          `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
        );

        for (const row of rows) {
          if (normalizeSubject(row.subject ?? '') === normalizedSubj) {
            const addrs = addrStmt.all(row.id) as Array<{
              type: number; displayName: string; address: string;
            }>;
            results.push({
              id: row.id,
              subject: row.subject ?? '',
              date: ticksToISO(row.date) ?? new Date(0).toISOString(),
              to: addrs.filter((a) => a.type === 3).map((a) => formatAddress(a.displayName, a.address)),
              cc: addrs.filter((a) => a.type === 4).map((a) => formatAddress(a.displayName, a.address)),
              sourceAccount: acc.email,
            });
          }
        }
      });
    } catch {
      // Skip accounts with errors
    }
  }

  return results;
}

/** Find related threads in the same account with similar subject but different conversationId */
function findRelatedThreads(
  acc: AccountConfig,
  normalizedSubj: string,
  excludeConvId: string,
): RelatedThread[] {
  const results: RelatedThread[] = [];

  try {
    withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
      // Get recent conversations
      const rows = db
        .prepare(
          `SELECT conversationId, COUNT(*) as cnt, MAX(date) as maxDate,
                  MAX(subject) as latestSubject
           FROM MailItems
           WHERE conversationId IS NOT NULL
             AND conversationId != ?
             AND (flags & 65536) = 0
           GROUP BY conversationId
           ORDER BY maxDate DESC
           LIMIT 500`,
        )
        .all(excludeConvId) as Array<{
        conversationId: string;
        cnt: number;
        maxDate: number;
        latestSubject: string;
      }>;

      const addrStmt = db.prepare(
        `SELECT a.displayName, a.address FROM MailAddresses a
         JOIN MailItems m ON a.parentId = m.id
         WHERE m.conversationId = ? AND a.type = 1
         ORDER BY m.date DESC LIMIT 1`,
      );

      for (const row of rows) {
        if (normalizeSubject(row.latestSubject ?? '') === normalizedSubj) {
          const fromAddr = addrStmt.get(row.conversationId) as
            | { displayName: string; address: string }
            | undefined;
          results.push({
            conversationId: row.conversationId,
            messageCount: row.cnt,
            latestDate: ticksToISO(row.maxDate) ?? '',
            latestSubject: row.latestSubject ?? '',
            latestFrom: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
            sourceAccount: acc.email,
          });
        }
      }
    });
  } catch {
    // Skip on error
  }

  // Also check other accounts for related threads
  for (const otherAcc of ACCOUNTS) {
    if (otherAcc.email === acc.email) continue;
    try {
      withDbSync(otherAcc.accountUid, otherAcc.mailSubdir, 'mail_index.dat', (db) => {
        const rows = db
          .prepare(
            `SELECT conversationId, COUNT(*) as cnt, MAX(date) as maxDate,
                    MAX(subject) as latestSubject
             FROM MailItems
             WHERE conversationId IS NOT NULL
               AND (flags & 65536) = 0
             GROUP BY conversationId
             ORDER BY maxDate DESC
             LIMIT 500`,
          )
          .all() as Array<{
          conversationId: string;
          cnt: number;
          maxDate: number;
          latestSubject: string;
        }>;

        const addrStmt = db.prepare(
          `SELECT a.displayName, a.address FROM MailAddresses a
           JOIN MailItems m ON a.parentId = m.id
           WHERE m.conversationId = ? AND a.type = 1
           ORDER BY m.date DESC LIMIT 1`,
        );

        for (const row of rows) {
          if (normalizeSubject(row.latestSubject ?? '') === normalizedSubj) {
            const fromAddr = addrStmt.get(row.conversationId) as
              | { displayName: string; address: string }
              | undefined;
            results.push({
              conversationId: row.conversationId,
              messageCount: row.cnt,
              latestDate: ticksToISO(row.maxDate) ?? '',
              latestSubject: row.latestSubject ?? '',
              latestFrom: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
              sourceAccount: otherAcc.email,
            });
          }
        }
      });
    } catch {
      // Skip on error
    }
  }

  return results;
}

/** Determine my role in the thread based on To/CC analysis */
function determineMyRole(
  messages: ThreadMessage[],
  myEmails: string[],
): 'direct_recipient' | 'cc_recipient' | 'sender' | 'unknown' {
  const myEmailSet = new Set(myEmails.map((e) => e.toLowerCase()));

  // Check the most recent non-sent message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.isSentByMe) continue;

    // Check To
    for (const to of m.to) {
      const addr = to.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? to.toLowerCase();
      if (myEmailSet.has(addr)) return 'direct_recipient';
    }
    // Check CC
    for (const cc of m.cc) {
      const addr = cc.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? cc.toLowerCase();
      if (myEmailSet.has(addr)) return 'cc_recipient';
    }
  }

  // If I sent messages but wasn't addressed
  if (messages.some((m) => m.isSentByMe)) return 'sender';

  return 'unknown';
}

export function getMailThread(params: MailThreadParams): ThreadResult {
  const acc = findAccount(params.account);
  const myEmails = ACCOUNTS.map((a) => a.email);

  const mainResult = withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const targetMail = db
      .prepare(`SELECT conversationId, subject FROM MailItems WHERE id = ?`)
      .get(params.mail_id) as { conversationId: string | null; subject: string } | undefined;

    if (!targetMail || !targetMail.conversationId) {
      throw new Error(`Mail not found or has no conversation: id=${params.mail_id}`);
    }

    const convId = targetMail.conversationId;
    const normalizedSubj = normalizeSubject(targetMail.subject ?? '');

    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder,
                replyDate, forwardDate
         FROM MailItems
         WHERE conversationId = ?
         ORDER BY date ASC`,
      )
      .all(convId) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
      replyDate: number;
      forwardDate: number;
    }>;

    const folderMap = getFolderMap(acc.accountUid, acc.mailSubdir);
    const sentFolderIds = getSentFolderIds(acc.accountUid, acc.mailSubdir);

    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
    );

    const participantSet = new Set<string>();

    const messages: ThreadMessage[] = rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number; displayName: string; address: string;
      }>;

      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3);
      const ccAddrs = addrs.filter((a) => a.type === 4);

      if (fromAddr?.address) participantSet.add(fromAddr.address);
      for (const a of [...toAddrs, ...ccAddrs]) {
        if (a.address) participantSet.add(a.address);
      }

      const isSentByMe = sentFolderIds.has(row.folder);

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToISO(row.date) ?? new Date(0).toISOString(),
        preview: (row.preview ?? '').slice(0, 500),
        from: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
        to: toAddrs.map((a) => formatAddress(a.displayName, a.address)),
        cc: ccAddrs.map((a) => formatAddress(a.displayName, a.address)),
        folderName: folderMap.get(row.folder) ?? '',
        isRead: (row.flags & 2) !== 0,
        isSentByMe,
        sourceAccount: acc.email,
      };
    });

    const myRepliesInThread = messages.filter((m) => m.isSentByMe).length;

    return { convId, normalizedSubj, messages, myRepliesInThread, participants: [...participantSet] };
  });

  // Cross-account sent mail search
  const crossAccountSent = searchCrossAccountSent(mainResult.normalizedSubj, params.account);

  // Also check same account's Sent for subject match (different conversationId)
  const sameAccountSent: CrossAccountSent[] = [];
  try {
    const sentIds = getSentFolderIds(acc.accountUid, acc.mailSubdir);
    if (sentIds.size > 0) {
      withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
        const folderList = [...sentIds].join(',');
        const rows = db
          .prepare(
            `SELECT id, subject, date, conversationId FROM MailItems
             WHERE folder IN (${folderList})
               AND (conversationId IS NULL OR conversationId != ?)
             ORDER BY date DESC
             LIMIT 200`,
          )
          .all(mainResult.convId) as Array<{
          id: number; subject: string; date: number; conversationId: string | null;
        }>;

        const addrStmt = db.prepare(
          `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
        );

        for (const row of rows) {
          if (normalizeSubject(row.subject ?? '') === mainResult.normalizedSubj) {
            const addrs = addrStmt.all(row.id) as Array<{
              type: number; displayName: string; address: string;
            }>;
            sameAccountSent.push({
              id: row.id,
              subject: row.subject ?? '',
              date: ticksToISO(row.date) ?? new Date(0).toISOString(),
              to: addrs.filter((a) => a.type === 3).map((a) => formatAddress(a.displayName, a.address)),
              cc: addrs.filter((a) => a.type === 4).map((a) => formatAddress(a.displayName, a.address)),
              sourceAccount: acc.email,
            });
          }
        }
      });
    }
  } catch {
    // skip
  }

  const allCrossAccountSent = [...crossAccountSent, ...sameAccountSent];

  // Related threads
  const relatedThreads = findRelatedThreads(acc, mainResult.normalizedSubj, mainResult.convId);

  // My role
  const myRole = determineMyRole(mainResult.messages, myEmails);

  const totalMyReplies = mainResult.myRepliesInThread + allCrossAccountSent.length;

  return {
    conversationId: mainResult.convId,
    normalizedSubject: mainResult.normalizedSubj,
    messageCount: mainResult.messages.length,
    myRepliesInThread: mainResult.myRepliesInThread,
    myRepliesAcrossAccounts: totalMyReplies,
    myRole,
    participants: mainResult.participants,
    messages: mainResult.messages,
    crossAccountSentMails: allCrossAccountSent,
    relatedThreads,
  };
}
