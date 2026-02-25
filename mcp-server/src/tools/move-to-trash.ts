import { findAccount } from '../db/accounts.js';
import { openDbSync, openDbForWrite } from '../db/connection.js';

interface MoveToTrashParams {
  mail_ids: number[];
  account: string;
}

interface MoveToTrashResult {
  moved: number;
  failed: number;
  trashFolderName: string;
  errors: string[];
}

const TRASH_NAMES = [
  'ゴミ箱',
  'trash',
  '[gmail]/ゴミ箱',
  '[gmail]/trash',
  'deleted items',
  '削除済みアイテム',
];

function findTrashFolderId(
  accountUid: string,
  mailSubdir: string,
): { id: number; name: string } | null {
  const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
  try {
    const folders = fdb
      .prepare(`SELECT id, name FROM Folders`)
      .all() as Array<{ id: number; name: string }>;

    for (const trashName of TRASH_NAMES) {
      const found = folders.find(
        (f) => f.name.toLowerCase() === trashName,
      );
      if (found) return found;
    }

    // Fallback: partial match
    const fallback = folders.find(
      (f) =>
        f.name.toLowerCase().includes('trash') ||
        f.name.includes('ゴミ箱'),
    );
    return fallback ?? null;
  } finally {
    fdb.close();
  }
}

export function moveToTrash(params: MoveToTrashParams): MoveToTrashResult {
  const acc = findAccount(params.account);

  const trashFolder = findTrashFolderId(acc.accountUid, acc.mailSubdir);
  if (!trashFolder) {
    return {
      moved: 0,
      failed: params.mail_ids.length,
      trashFolderName: '',
      errors: [`Trash folder not found for account ${params.account}`],
    };
  }

  const errors: string[] = [];
  let moved = 0;
  let failed = 0;

  const db = openDbForWrite(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const updateStmt = db.prepare(
      `UPDATE MailItems SET folder = ? WHERE id = ?`,
    );

    const checkStmt = db.prepare(
      `SELECT id, folder FROM MailItems WHERE id = ?`,
    );

    for (const mailId of params.mail_ids) {
      try {
        const row = checkStmt.get(mailId) as
          | { id: number; folder: number }
          | undefined;
        if (!row) {
          errors.push(`Mail ID ${mailId} not found`);
          failed++;
          continue;
        }
        if (row.folder === trashFolder.id) {
          // Already in trash
          moved++;
          continue;
        }
        updateStmt.run(trashFolder.id, mailId);
        moved++;
      } catch (e) {
        errors.push(`Mail ID ${mailId}: ${(e as Error).message}`);
        failed++;
      }
    }
  } finally {
    db.close();
  }

  return {
    moved,
    failed,
    trashFolderName: trashFolder.name,
    errors,
  };
}
