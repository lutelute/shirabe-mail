import { findAccount } from '../db/accounts.js';
import {
  openDbSync,
  openDbForWrite,
  isEmClientRunning,
  backupDbFile,
  resolveDbPath,
} from '../db/connection.js';

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
  backupPath?: string;
  warnings?: string[];
}

export function copyMailToFolder(params: CopyMailToFolderParams): CopyMailToFolderResult {
  const acc = findAccount(params.account);

  // Refuse to write while eM Client is running — its sync engine would race
  // with us and could silently roll the change back or corrupt the WAL.
  if (isEmClientRunning()) {
    return {
      copied: 0,
      skipped: 0,
      failed: params.mail_ids.length,
      targetFolderName: '',
      details: params.mail_ids.map((id) => ({
        mailId: id,
        status: 'failed' as const,
        reason:
          'eM Client が起動中のため書き込みを中断しました。eM Client を終了してから実行してください。',
      })),
    };
  }

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
  const warnings: string[] = [];
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  // Back up the DB before any destructive write so the user can recover by hand.
  const dbPath = resolveDbPath(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  let backupPath: string;
  try {
    backupPath = backupDbFile(dbPath);
  } catch (e) {
    return {
      copied: 0,
      skipped: 0,
      failed: params.mail_ids.length,
      targetFolderName,
      details: params.mail_ids.map((id) => ({
        mailId: id,
        status: 'failed' as const,
        reason: `Backup failed, aborting write: ${(e as Error).message}`,
      })),
    };
  }

  const db = openDbForWrite(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    // Discover MailItems columns dynamically
    const colInfo = db.pragma('table_info(MailItems)') as Array<{
      name: string;
      pk: number;
    }>;
    const pkCol = colInfo.find((c) => c.pk > 0)?.name ?? 'id';
    const copyableCols = colInfo.filter((c) => c.pk === 0).map((c) => c.name);
    const colNameSet = new Set(colInfo.map((c) => c.name));

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
        backupPath,
      };
    }

    // Body-completeness check: mail_index.dat is an INDEX DB. It stores metadata
    // and a short `preview` snippet, but NOT the full MIME body (which eM Client
    // keeps in a separate content store keyed by uniqueId/downloadState). There
    // is no body/content/html column to duplicate, so the copied mail will have
    // metadata + preview only; its full body may not render until eM Client
    // re-downloads it (and may never, for already-purged messages).
    const BODY_COL_CANDIDATES = ['body', 'content', 'html', 'text', 'bodyHtml', 'bodyText'];
    const hasBodyCol = BODY_COL_CANDIDATES.some((c) => colNameSet.has(c));
    if (!hasBodyCol) {
      warnings.push(
        'メタデータとプレビューのみコピーされます。mail_index.dat には本文（MIME本体）列が無いため、' +
          'コピー先メールの本文は eM Client が再取得するまで表示されない可能性があります（取得できない場合もあります）。',
      );
    }

    // INSERT ... SELECT with folder replaced by bind param
    const selectExprs = copyableCols.map((c) =>
      c === 'folder' ? '@targetFolder' : c,
    );
    const copyMailSql = `INSERT INTO MailItems (${copyableCols.join(', ')}) SELECT ${selectExprs.join(', ')} FROM MailItems WHERE ${pkCol} = @sourceId`;
    const copyMailStmt = db.prepare(copyMailSql);

    // Dedup: prefer a strong identity match on messageId (a globally-unique
    // RFC822 Message-ID) when present; otherwise fall back to subject+date.
    // subject+date alone is fragile (two distinct mails can share both).
    const hasMessageId = colNameSet.has('messageId');
    const dedupStmt = hasMessageId
      ? db.prepare(
          `SELECT COUNT(*) as cnt FROM MailItems t
           WHERE t.folder = @folder
             AND (
               (t.messageId IS NOT NULL
                 AND t.messageId != ''
                 AND t.messageId = (SELECT messageId FROM MailItems WHERE ${pkCol} = @id))
               OR (
                 -- messageId missing on source: fall back to subject+date
                 COALESCE((SELECT messageId FROM MailItems WHERE ${pkCol} = @id), '') = ''
                 AND t.subject = (SELECT subject FROM MailItems WHERE ${pkCol} = @id)
                 AND t.date = (SELECT date FROM MailItems WHERE ${pkCol} = @id)
               )
             )`,
        )
      : db.prepare(
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

    // Process the whole batch atomically. Per-mail "skipped/failed" decisions
    // are recorded as data; only an *unexpected* throw aborts & rolls back.
    const copyOne = (mailId: number): void => {
        const row = checkStmt.get(mailId) as
          | { id: number; folder: number }
          | undefined;
        if (!row) {
          details.push({ mailId, status: 'failed', reason: 'Mail not found' });
          failed++;
          return;
        }

        // Already in target folder
        if (row.folder === params.target_folder_id) {
          details.push({
            mailId,
            status: 'skipped',
            reason: 'Already in target folder',
          });
          skipped++;
          return;
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
          return;
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
    };

    const runBatch = db.transaction(() => {
      for (const mailId of params.mail_ids) {
        copyOne(mailId);
      }
    });

    try {
      runBatch();
    } catch (e) {
      // Whole batch rolled back — reset counters and report failure.
      details.length = 0;
      copied = 0;
      skipped = 0;
      failed = params.mail_ids.length;
      for (const id of params.mail_ids) {
        details.push({
          mailId: id,
          status: 'failed',
          reason: `Transaction failed and was rolled back: ${(e as Error).message}`,
        });
      }
    }
  } finally {
    db.close();
  }

  return {
    copied,
    skipped,
    failed,
    targetFolderName,
    details,
    backupPath,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
