import { findAccount } from '../db/accounts.js';
import { ticksToISO } from '../db/tick-converter.js';
import { formatAddress, withDbSync, getFolderMap } from '../utils.js';
import type { MailDetail } from '../types.js';

interface MailDetailParams {
  mail_id: number;
  account: string;
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
    const toAddrs = addrs.filter((a) => a.type === 4);
    const ccAddrs = addrs.filter((a) => a.type === 5);

    // Get folder name
    const folderName = getFolderMap(acc.accountUid, acc.mailSubdir).get(row.folder) ?? '';

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
