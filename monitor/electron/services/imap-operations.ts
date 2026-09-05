import { ImapFlow } from 'imapflow';
import { getMessageIdById } from './db-reader';
import type { ImapCredentials, MoveToTrashResult } from '../../src/types/index';

function createClient(credentials: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    auth: {
      user: credentials.user,
      pass: credentials.password,
    },
    logger: false,
  });
}

export async function testImapConnection(
  credentials: ImapCredentials,
): Promise<{ success: boolean; error?: string }> {
  const client = createClient(credentials);
  try {
    await client.connect();
    await client.logout();
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

export async function listImapFolders(
  credentials: ImapCredentials,
): Promise<string[]> {
  const client = createClient(credentials);
  try {
    await client.connect();
    const folders: string[] = [];
    const list = await client.list();
    for (const folder of list) {
      folders.push(folder.path);
    }
    await client.logout();
    return folders;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`フォルダ一覧の取得に失敗しました: ${msg}`);
  }
}

export async function moveToTrash(
  mailId: number,
  accountEmail: string,
  credentials: ImapCredentials,
  trashFolderPath: string,
): Promise<MoveToTrashResult> {
  // Get RFC Message-ID from eM Client DB
  const messageId = getMessageIdById(accountEmail, mailId);
  if (!messageId) {
    return { mailId, success: false, error: 'Message-IDが見つかりませんでした' };
  }

  const client = createClient(credentials);
  try {
    await client.connect();

    // Search across INBOX first (most common)
    const mailboxes = ['INBOX'];
    let found = false;

    for (const mailbox of mailboxes) {
      try {
        const lock = await client.getMailboxLock(mailbox);
        try {
          // Search by Message-ID header
          const result = await client.search({
            header: { 'Message-ID': messageId },
          }) as number[];

          if (result && result.length > 0) {
            // Move to trash
            await client.messageMove(result, trashFolderPath);
            found = true;
            break;
          }
        } finally {
          lock.release();
        }
      } catch {
        // Mailbox not accessible, skip
      }
    }

    if (!found) {
      // Try searching all mailboxes
      const list = await client.list();
      for (const folder of list) {
        if (folder.path === trashFolderPath) continue;
        if (folder.specialUse === '\\Trash') continue;

        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            const result = await client.search({
              header: { 'Message-ID': messageId },
            }) as number[];

            if (result && result.length > 0) {
              await client.messageMove(result, trashFolderPath);
              found = true;
              break;
            }
          } finally {
            lock.release();
          }
        } catch {
          // Skip inaccessible mailboxes
        }
      }
    }

    await client.logout();

    if (!found) {
      return { mailId, success: false, error: 'IMAPサーバーでメールが見つかりませんでした' };
    }
    return { mailId, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { mailId, success: false, error: msg };
  }
}

export async function moveToTrashBatch(
  mailIds: number[],
  accountEmail: string,
  credentials: ImapCredentials,
  trashFolderPath: string,
): Promise<MoveToTrashResult[]> {
  const results: MoveToTrashResult[] = [];

  // Process sequentially to avoid IMAP connection issues
  for (const mailId of mailIds) {
    const result = await moveToTrash(mailId, accountEmail, credentials, trashFolderPath);
    results.push(result);
  }

  return results;
}

/**
 * Move a single mail to an arbitrary destination folder (e.g. a quarantine
 * folder). Mirrors moveToTrash but targets `destFolderPath` and creates the
 * destination mailbox if it does not exist. This is a *reversible* operation:
 * the mail is relocated, never deleted — the user can drag it back.
 */
export async function moveToFolder(
  mailId: number,
  accountEmail: string,
  credentials: ImapCredentials,
  destFolderPath: string,
): Promise<MoveToTrashResult> {
  // Get RFC Message-ID from eM Client DB
  const messageId = getMessageIdById(accountEmail, mailId);
  if (!messageId) {
    return { mailId, success: false, error: 'Message-IDが見つかりませんでした' };
  }

  const client = createClient(credentials);
  try {
    await client.connect();

    // Ensure destination folder exists (idempotent — ignore "already exists").
    try {
      const existing = await client.list();
      const hasDest = existing.some((f) => f.path === destFolderPath);
      if (!hasDest) {
        await client.mailboxCreate(destFolderPath);
      }
    } catch {
      // Creation may fail if it already exists (race) — continue regardless.
    }

    let found = false;

    // Search INBOX first (most common), then fall back to all other mailboxes.
    const searchMailboxes = ['INBOX'];
    for (const mailbox of searchMailboxes) {
      try {
        const lock = await client.getMailboxLock(mailbox);
        try {
          const result = (await client.search({
            header: { 'Message-ID': messageId },
          })) as number[];
          if (result && result.length > 0) {
            await client.messageMove(result, destFolderPath);
            found = true;
            break;
          }
        } finally {
          lock.release();
        }
      } catch {
        // Mailbox not accessible, skip
      }
    }

    if (!found) {
      const list = await client.list();
      for (const folder of list) {
        if (folder.path === destFolderPath) continue; // don't search the target
        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            const result = (await client.search({
              header: { 'Message-ID': messageId },
            })) as number[];
            if (result && result.length > 0) {
              await client.messageMove(result, destFolderPath);
              found = true;
              break;
            }
          } finally {
            lock.release();
          }
        } catch {
          // Skip inaccessible mailboxes
        }
      }
    }

    await client.logout();

    if (!found) {
      return { mailId, success: false, error: 'IMAPサーバーでメールが見つかりませんでした' };
    }
    return { mailId, success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { mailId, success: false, error: msg };
  }
}

/**
 * 複数メールを1接続でゴミ箱へ移動する(一括承認用)。
 * moveToTrash を回すと1通ごとに接続するため、40通で1分かかっていた。
 * ここでは接続を1回、INBOX のロックも1回にして、Message-ID 検索→移動を繰り返す。
 * 安全ライン: 移動のみ(完全削除はしない)。INBOX に無いものは失敗として返す。
 */
export async function moveManyToTrash(
  mailIds: number[],
  accountEmail: string,
  credentials: ImapCredentials,
  trashFolderPath: string,
): Promise<MoveToTrashResult[]> {
  const results: MoveToTrashResult[] = [];
  if (mailIds.length === 0) return results;

  const client = createClient(credentials);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const mailId of mailIds) {
        const messageId = getMessageIdById(accountEmail, mailId);
        if (!messageId) {
          results.push({ mailId, success: false, error: 'Message-IDが見つかりませんでした' });
          continue;
        }
        try {
          const found = (await client.search({ header: { 'Message-ID': messageId } })) as number[];
          if (found && found.length > 0) {
            await client.messageMove(found, trashFolderPath);
            results.push({ mailId, success: true });
          } else {
            results.push({ mailId, success: false, error: 'IMAPサーバーの受信箱に見つかりませんでした' });
          }
        } catch (err) {
          results.push({ mailId, success: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const mailId of mailIds) {
      if (!results.some((r) => r.mailId === mailId)) results.push({ mailId, success: false, error: msg });
    }
  }
  return results;
}
