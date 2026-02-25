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
