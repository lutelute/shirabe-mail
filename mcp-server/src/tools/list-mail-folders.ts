import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';

interface FolderInfo {
  id: number;
  name: string;
  path: string;
  parentFolderId: number;
  mailCount: number;
  accountEmail: string;
}

interface ListFoldersParams {
  account?: string;
}

function fetchFoldersForAccount(accountEmail: string): FolderInfo[] {
  const acc = findAccount(accountEmail);

  // Load folders
  let folders: Array<{ id: number; name: string; path: string; parentFolderId: number }> = [];
  try {
    const fdb = openDbSync(acc.accountUid, acc.mailSubdir, 'folders.dat');
    try {
      folders = fdb
        .prepare(`SELECT id, name, path, parentFolderId FROM Folders ORDER BY path`)
        .all() as typeof folders;
    } finally {
      fdb.close();
    }
  } catch {
    return [];
  }

  // Count mails per folder
  const countMap = new Map<number, number>();
  try {
    const mdb = openDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
    try {
      const counts = mdb
        .prepare(`SELECT folder, COUNT(*) as cnt FROM MailItems WHERE (flags & 65536) = 0 GROUP BY folder`)
        .all() as Array<{ folder: number; cnt: number }>;
      for (const c of counts) {
        countMap.set(c.folder, c.cnt);
      }
    } finally {
      mdb.close();
    }
  } catch {
    // mail_index.dat may fail
  }

  return folders
    .filter((f) => f.name !== 'Root')
    .map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      parentFolderId: f.parentFolderId,
      mailCount: countMap.get(f.id) ?? 0,
      accountEmail,
    }));
}

export function listMailFolders(params: ListFoldersParams): FolderInfo[] {
  const accounts = params.account
    ? [findAccount(params.account)]
    : ACCOUNTS;

  const allFolders: FolderInfo[] = [];
  for (const acc of accounts) {
    try {
      allFolders.push(...fetchFoldersForAccount(acc.email));
    } catch (e) {
      console.error(`Error listing folders for ${acc.email}:`, e);
    }
  }

  return allFolders;
}
