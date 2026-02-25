import { findAccount } from '../db/accounts.js';
import { openDbSync, openDbForWrite } from '../db/connection.js';

interface CopyMailToFolderParams {
  mail_ids: number[];
  account: string;
  target_folder_id: number;
}

interface CopyMailToFolderResult {
  copied: number;
  skipped: number;
  failed: number;
  targetFolderName: string;
  details: Array<{ mailId: number; status: 'copied' | 'skipped' | 'failed'; reason?: string }>;
}

export function copyMailToFolder(params: CopyMailToFolderParams): CopyMailToFolderResult {
  const acc = findAccount(params.account);

  // Validate target folder
  let targetFolderName = '';
  {
    const fdb = openDbSync(acc.accountUid, acc.mailSubdir, 'folders.dat');
    try {
      const row = fdb
        .prepare('SELECT name FROM Folders WHERE id = ?')
        .get(params.target_folder_id) as { name: string } | undefined;
      if (!row) {
        return {
          copied: 0,
          skipped: 0,
          failed: params.mail_ids.length,
          targetFolderName: '',
          details: params.mail_ids.map((id) => ({
            mailId: id,
            status: 'failed' as const,
            reason: `Target folder ID ${params.target_folder_id} not found`,
          })),
        };
      }
      targetFolderName = row.name;
    } finally {
      fdb.close();
    }
  }

  const details: CopyMailToFolderResult['details'] = [];
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  const db = openDbForWrite(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    // Discover MailItems columns dynamically
    const colInfo = db.pragma('table_info(MailItems)') as Array<{
      name: string;
      pk: number;
    }>;
    const pkCol = colInfo.find((c) => c.pk > 0)?.name ?? 'id';
    const copyableCols = colInfo.filter((c) => c.pk === 0).map((c) => c.name);

    if (!copyableCols.includes('folder')) {
      return {
        copied: 0,
        skipped: 0,
        failed: params.mail_ids.length,
        targetFolderName,
        details: params.mail_ids.map((id) => ({
          mailId: id,
          status: 'failed' as const,
          reason: 'Column "folder" not found in MailItems',
        })),
      };
    }

    // INSERT ... SELECT with folder replaced by bind param
    const selectExprs = copyableCols.map((c) =>
      c === 'folder' ? '@targetFolder' : c,
    );
    const copyMailSql = `INSERT INTO MailItems (${copyableCols.join(', ')}) SELECT ${selectExprs.join(', ')} FROM MailItems WHERE ${pkCol} = @sourceId`;
    const copyMailStmt = db.prepare(copyMailSql);

    // Dedup: check if mail with same subject+date already exists in target folder
    const dedupStmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM MailItems
       WHERE folder = @folder
         AND subject = (SELECT subject FROM MailItems WHERE ${pkCol} = @id)
         AND date = (SELECT date FROM MailItems WHERE ${pkCol} = @id)`,
    );

    const checkStmt = db.prepare(
      `SELECT ${pkCol} as id, folder FROM MailItems WHERE ${pkCol} = ?`,
    );

    // Discover MailAddresses columns for copying
    let copyAddrStmt: ReturnType<typeof db.prepare> | null = null;
    try {
      const addrInfo = db.pragma('table_info(MailAddresses)') as Array<{
        name: string;
        pk: number;
      }>;
      if (addrInfo.length > 0) {
        // Include all columns except auto-increment pk (but keep parentId even if pk)
        const addrCopyCols = addrInfo
          .filter((c) => c.pk === 0 || c.name === 'parentId')
          .map((c) => c.name);
        if (addrCopyCols.includes('parentId')) {
          const addrSelectExprs = addrCopyCols.map((c) =>
            c === 'parentId' ? '@newParentId' : c,
          );
          copyAddrStmt = db.prepare(
            `INSERT INTO MailAddresses (${addrCopyCols.join(', ')}) SELECT ${addrSelectExprs.join(', ')} FROM MailAddresses WHERE parentId = @oldParentId`,
          );
        }
      }
    } catch {
      // MailAddresses might not be accessible
    }

    for (const mailId of params.mail_ids) {
      try {
        const row = checkStmt.get(mailId) as
          | { id: number; folder: number }
          | undefined;
        if (!row) {
          details.push({ mailId, status: 'failed', reason: 'Mail not found' });
          failed++;
          continue;
        }

        // Already in target folder
        if (row.folder === params.target_folder_id) {
          details.push({
            mailId,
            status: 'skipped',
            reason: 'Already in target folder',
          });
          skipped++;
          continue;
        }

        // Dedup check
        const dup = dedupStmt.get({
          folder: params.target_folder_id,
          id: mailId,
        }) as { cnt: number };
        if (dup.cnt > 0) {
          details.push({
            mailId,
            status: 'skipped',
            reason: 'Duplicate exists in target folder',
          });
          skipped++;
          continue;
        }

        // Copy the mail row
        const result = copyMailStmt.run({
          targetFolder: params.target_folder_id,
          sourceId: mailId,
        });

        // Copy addresses
        if (copyAddrStmt && result.lastInsertRowid) {
          const newId = Number(result.lastInsertRowid);
          copyAddrStmt.run({ newParentId: newId, oldParentId: mailId });
        }

        details.push({ mailId, status: 'copied' });
        copied++;
      } catch (e) {
        details.push({
          mailId,
          status: 'failed',
          reason: (e as Error).message,
        });
        failed++;
      }
    }
  } finally {
    db.close();
  }

  return { copied, skipped, failed, targetFolderName, details };
}
