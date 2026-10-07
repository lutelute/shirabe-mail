// === 返信先の解決(MCP 側。アプリの partner-ipc.buildReplyRecipients と同じ規則) ===
import { findAccount, getAccounts } from '../db/accounts.js';
import { withDbSync, formatAddress } from '../utils.js';

export interface ReplyRecipients { to: string[]; cc: string[]; subject: string }

export function resolveReplyRecipients(accountEmail: string, mailId: number, scope: 'sender' | 'all'): ReplyRecipients {
  const acc = findAccount(accountEmail);
  const mine = new Set(getAccounts().map((a) => a.email.toLowerCase()));
  return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const row = db.prepare('SELECT subject FROM MailItems WHERE id = ?').get(mailId) as { subject: string } | undefined;
    if (!row) throw new Error(`メールが見つかりません: id=${mailId} (${accountEmail})`);
    const addrs = db.prepare('SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?').all(mailId) as Array<{ type: number; displayName: string; address: string }>;
    // 1=From, 3=Reply-To, 4=To, 5=Cc
    const primary = addrs.find((a) => a.type === 3 && a.address) ?? addrs.find((a) => a.type === 1 && a.address);
    if (!primary) throw new Error('差出人が取れませんでした');
    const to = [formatAddress(primary.displayName, primary.address)];
    const seen = new Set([primary.address.toLowerCase()]);
    const cc: string[] = [];
    if (scope === 'all') {
      for (const a of addrs.filter((x) => (x.type === 4 || x.type === 5) && x.address)) {
        const k = a.address.toLowerCase();
        if (mine.has(k) || seen.has(k)) continue;
        seen.add(k);
        cc.push(formatAddress(a.displayName, a.address));
      }
    }
    return { to, cc, subject: row.subject ?? '' };
  });
}
