// === IMAP でメールボックスを片付ける(可逆な操作だけ) ===
//
//  - 既読にする / 未読に戻す
//  - アーカイブへ移す(Gmail は「すべてのメール」へ = INBOX ラベルを外す) / 受信箱へ戻す
//  - 送信済みへ APPEND(SMTP で送ったメールを eM Client にも見せる)
//  - 元メールに \Answered を付ける
//
// eM Client の id → Message-ID → IMAP 検索、の流れは imap-operations.ts と同じ。
// 1接続で複数通を処理する(1通ごとの接続は 40通で1分かかっていた)。

import { ImapFlow } from 'imapflow';
import type { ListResponse } from 'imapflow';
import { getMessageIdById } from './db-reader';
import type { ImapCredentials } from '../../src/types/index';

export interface ActionResult {
  mailId: number;
  success: boolean;
  error?: string;
}

export interface ImapSession {
  client: ImapFlow;
  folders: ListResponse[];
}

function createClient(c: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.password },
    logger: false,
  });
}

export async function withImap<T>(creds: ImapCredentials, fn: (s: ImapSession) => Promise<T>): Promise<T> {
  const client = createClient(creds);
  await client.connect();
  try {
    const folders = await client.list();
    return await fn({ client, folders });
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

/** special-use か名前でフォルダを引く */
export function resolveFolder(folders: ListResponse[], specialUse: string | null, names: string[]): string | null {
  if (specialUse) {
    const su = folders.find((f) => (f.specialUse ?? '').toLowerCase() === specialUse.toLowerCase());
    if (su) return su.path;
  }
  const lower = names.map((n) => n.toLowerCase());
  const byName = folders.find((f) => lower.includes((f.name ?? '').toLowerCase()) || lower.includes(f.path.toLowerCase()));
  return byName?.path ?? null;
}

export const ARCHIVE_NAMES = ['Archive', 'Archives', 'アーカイブ', '[Gmail]/All Mail', '[Gmail]/すべてのメール', 'すべてのメール', 'All Mail'];
export const SENT_NAMES = ['Sent', 'Sent Items', 'Sent Messages', '送信済み', '送信済みアイテム', '[Gmail]/Sent Mail', '[Gmail]/送信済みメール'];
export const TRASH_NAMES = ['Trash', 'Deleted Items', 'ゴミ箱', '[Gmail]/Trash', '[Gmail]/ゴミ箱'];
export const DRAFTS_NAMES = ['Drafts', 'Draft', '下書き', '[Gmail]/Drafts', '[Gmail]/下書き'];

export function isGmailHost(host: string): boolean {
  return /gmail\.com$|googlemail\.com$/i.test(host);
}

/** アーカイブ先。Gmail は「すべてのメール」(\All) への MOVE が INBOX ラベル外しになる */
export function archiveFolderFor(s: ImapSession, host: string): string | null {
  if (isGmailHost(host)) return resolveFolder(s.folders, '\\All', ARCHIVE_NAMES);
  return resolveFolder(s.folders, '\\Archive', ARCHIVE_NAMES);
}

async function findUids(client: ImapFlow, messageId: string): Promise<number[]> {
  const r = (await client.search({ header: { 'message-id': messageId } }, { uid: true })) as number[] | false;
  return Array.isArray(r) ? r : [];
}

/**
 * mailbox を開いて、各 mailId を Message-ID で探し、見つかった uid に対して op を実行する。
 */
async function forEachFound(
  s: ImapSession,
  accountEmail: string,
  mailbox: string,
  mailIds: number[],
  op: (uids: number[], mailId: number) => Promise<void>,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const lock = await s.client.getMailboxLock(mailbox);
  try {
    for (const mailId of mailIds) {
      let messageId: string | null = null;
      try { messageId = getMessageIdById(accountEmail, mailId); } catch { /* db */ }
      if (!messageId) { results.push({ mailId, success: false, error: 'Message-ID が見つかりません' }); continue; }
      try {
        const uids = await findUids(s.client, messageId);
        if (uids.length === 0) { results.push({ mailId, success: false, error: `${mailbox} に見つかりません` }); continue; }
        await op(uids, mailId);
        results.push({ mailId, success: true });
      } catch (err) {
        results.push({ mailId, success: false, error: (err as Error).message });
      }
    }
  } finally {
    lock.release();
  }
  return results;
}

export async function markRead(creds: ImapCredentials, accountEmail: string, mailIds: number[], mailbox = 'INBOX'): Promise<ActionResult[]> {
  if (mailIds.length === 0) return [];
  return withImap(creds, (s) => forEachFound(s, accountEmail, mailbox, mailIds, async (uids) => {
    await s.client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
  }));
}

export async function markUnread(creds: ImapCredentials, accountEmail: string, mailIds: number[], mailbox = 'INBOX'): Promise<ActionResult[]> {
  if (mailIds.length === 0) return [];
  return withImap(creds, (s) => forEachFound(s, accountEmail, mailbox, mailIds, async (uids) => {
    await s.client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
  }));
}

/** 既読にしてアーカイブへ移す(片付け)。戻り値にアーカイブ先を含める(「戻す」に使う) */
export async function tidyToArchive(
  creds: ImapCredentials,
  accountEmail: string,
  mailIds: number[],
): Promise<{ results: ActionResult[]; archiveFolder: string | null }> {
  if (mailIds.length === 0) return { results: [], archiveFolder: null };
  return withImap(creds, async (s) => {
    const dest = archiveFolderFor(s, creds.host);
    if (!dest) return { results: mailIds.map((mailId) => ({ mailId, success: false, error: 'アーカイブフォルダが見つかりません' })), archiveFolder: null };
    const results = await forEachFound(s, accountEmail, 'INBOX', mailIds, async (uids) => {
      await s.client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      await s.client.messageMove(uids, dest, { uid: true });
    });
    return { results, archiveFolder: dest };
  });
}

/** 片付けを戻す: アーカイブから INBOX へ(Gmail は COPY でラベル付与)、未読に戻す */
export async function restoreToInbox(
  creds: ImapCredentials,
  accountEmail: string,
  mailIds: number[],
  archiveFolder: string,
): Promise<ActionResult[]> {
  if (mailIds.length === 0) return [];
  return withImap(creds, (s) => forEachFound(s, accountEmail, archiveFolder, mailIds, async (uids) => {
    await s.client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
    if (isGmailHost(creds.host)) await s.client.messageCopy(uids, 'INBOX', { uid: true });
    else await s.client.messageMove(uids, 'INBOX', { uid: true });
  }));
}

/** 返信済みの印(\Answered + \Seen)を元メールに付ける。失敗しても送信自体には影響しない */
export async function markAnswered(creds: ImapCredentials, accountEmail: string, mailId: number): Promise<ActionResult> {
  const [r] = await withImap(creds, (s) => forEachFound(s, accountEmail, 'INBOX', [mailId], async (uids) => {
    await s.client.messageFlagsAdd(uids, ['\\Answered', '\\Seen'], { uid: true });
  }));
  return r ?? { mailId, success: false, error: '不明' };
}

/** 送信したメール(生の RFC822)を送信済みフォルダへ置く */
export async function appendToSent(creds: ImapCredentials, raw: Buffer, preferred?: string): Promise<{ success: boolean; folder?: string; error?: string }> {
  try {
    return await withImap(creds, async (s) => {
      const folder = preferred || resolveFolder(s.folders, '\\Sent', SENT_NAMES);
      if (!folder) return { success: false, error: '送信済みフォルダが見つかりません' };
      await s.client.append(folder, raw, ['\\Seen']);
      return { success: true, folder };
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 下書きフォルダへ置く(eM Client が同期して「下書き」に出る。開いて送るのは先生) */
export async function appendToDrafts(creds: ImapCredentials, raw: Buffer): Promise<{ success: boolean; folder?: string; error?: string }> {
  try {
    return await withImap(creds, async (s) => {
      const folder = resolveFolder(s.folders, '\\Drafts', DRAFTS_NAMES);
      if (!folder) return { success: false, error: '下書きフォルダが見つかりません' };
      await s.client.append(folder, raw, ['\\Draft', '\\Seen']);
      return { success: true, folder };
    });
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function testImap(creds: ImapCredentials): Promise<{ success: boolean; error?: string; folders?: string[] }> {
  try {
    return await withImap(creds, async (s) => ({ success: true, folders: s.folders.map((f) => f.path) }));
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
