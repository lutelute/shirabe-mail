import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ticksToDate, dateToTicks } from './tick-converter';
import {
  AddressType,
} from '../../src/types/index';
import type {
  AccountConfig,
  MailItem,
  MailAddress,
  CalendarEvent,
  TaskItem,
  FolderItem,
} from '../../src/types/index';

// --- Account loading from external config ---
const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'shirabe',
  'accounts.json',
);
// Fallback: try old path if new path doesn't exist
const CONFIG_PATH_LEGACY = path.join(
  os.homedir(),
  '.config',
  'emclient-monitor',
  'accounts.json',
);

let _cachedAccounts: AccountConfig[] | null = null;

function loadAccounts(): AccountConfig[] {
  if (_cachedAccounts) return _cachedAccounts;

  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_PATH_LEGACY;

  if (!fs.existsSync(configPath)) {
    console.error(
      `[db-reader] Account config not found: ${CONFIG_PATH}\n` +
        'Create this file with your account configuration.',
    );
    _cachedAccounts = [];
    return _cachedAccounts;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('accounts.json must be a JSON array');
    }
    _cachedAccounts = parsed as AccountConfig[];
    return _cachedAccounts;
  } catch (err) {
    console.error(`[db-reader] Failed to load ${configPath}:`, err);
    _cachedAccounts = [];
    return _cachedAccounts;
  }
}

const DB_BASE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'eM Client',
);

function findAccount(email: string): AccountConfig {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.email === email);
  if (!acc) throw new Error(`Unknown account: ${email}`);
  return acc;
}

/**
 * Open eM Client DB for reading.
 *
 * Strategy:
 * 1. Readonly mode — best: reads WAL data natively via shared lock
 * 2. Copy fallback — copies DB + WAL + SHM to temp, reads from snapshot
 * 3. Immutable last resort — reads stale main DB only (no WAL)
 *
 * The copy fallback is needed when eM Client holds an exclusive WAL lock
 * that prevents shared readonly access.
 */
const TMP_DIR = path.join(os.tmpdir(), 'shirabe-snap');

function openDb(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`DB not found: ${srcPath}`);
  }

  // 1. Primary: open directly in readonly mode
  try {
    return new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch (err1) {
    console.warn(`[db-reader] readonly open failed for ${dbName}:`, (err1 as Error).message);
  }

  // 2. Fallback: snapshot copy (DB + WAL + SHM)
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const safeName = accountUid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tmpPath = path.join(TMP_DIR, `${safeName}_${dbName}`);

    fs.copyFileSync(srcPath, tmpPath);
    const walSrc = srcPath + '-wal';
    const shmSrc = srcPath + '-shm';
    if (fs.existsSync(walSrc)) {
      fs.copyFileSync(walSrc, tmpPath + '-wal');
    } else {
      try { fs.unlinkSync(tmpPath + '-wal'); } catch { /* noop */ }
    }
    if (fs.existsSync(shmSrc)) {
      fs.copyFileSync(shmSrc, tmpPath + '-shm');
    } else {
      try { fs.unlinkSync(tmpPath + '-shm'); } catch { /* noop */ }
    }

    return new Database(tmpPath, { fileMustExist: true });
  } catch (err2) {
    console.warn(`[db-reader] copy fallback failed for ${dbName}:`, (err2 as Error).message);
  }

  // 3. Last resort: immutable (stale — ignores WAL)
  console.warn(`[db-reader] using immutable mode for ${dbName} (data may be stale)`);
  const uri = `file:${srcPath}?immutable=1`;
  return new Database(uri, { readonly: true, fileMustExist: true });
}

// --- Exports ---

export function getAccounts(): AccountConfig[] {
  return loadAccounts();
}

export function getMails(accountEmail: string, daysBack: number): MailItem[] {
  const acc = findAccount(accountEmail);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffTicks = dateToTicks(cutoff);

    const rows = db
      .prepare(
        `SELECT id, subject, date, receivedDate, preview, importance, flags, folder, conversationId
         FROM MailItems
         WHERE date >= ? AND (flags & 65536) = 0
         ORDER BY date DESC`,
      )
      .all(cutoffTicks) as Array<{
      id: number;
      subject: string;
      date: number;
      receivedDate: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
      conversationId: string | null;
    }>;

    // Build thread count map from conversationId (N+1 avoidance)
    const threadCountMap = new Map<string, number>();
    for (const row of rows) {
      if (row.conversationId) {
        threadCountMap.set(row.conversationId, (threadCountMap.get(row.conversationId) ?? 0) + 1);
      }
    }

    // Preload addresses
    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
    );

    // Preload folders from folders.dat (Folders table is NOT in mail_index.dat)
    const folderMap = new Map<number, string>();
    try {
      const fdb = openDb(acc.accountUid, acc.mailSubdir, 'folders.dat');
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        folderMap.set(f.id, f.name);
      }
      fdb.close();
    } catch {
      // folders.dat may not exist for some accounts
    }

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number;
        displayName: string;
        address: string;
      }>;

      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs
        .filter((a) => a.type === 3)
        .map(
          (a): MailAddress => ({
            displayName: a.displayName,
            address: a.address,
            type: 3 as AddressType,
          }),
        );

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToDate(row.date) ?? new Date(0),
        receivedDate: ticksToDate(row.receivedDate),
        preview: row.preview ?? '',
        importance: row.importance,
        flags: row.flags,
        folder: row.folder,
        folderName: folderMap.get(row.folder) ?? undefined,
        from: fromAddr
          ? {
              displayName: fromAddr.displayName,
              address: fromAddr.address,
              type: 1 as AddressType,
            }
          : null,
        to: toAddrs,
        isRead: (row.flags & 2) !== 0,
        isFlagged: (row.flags & 4) !== 0,
        accountEmail,
        conversationId: row.conversationId ?? undefined,
        threadCount: row.conversationId ? (threadCountMap.get(row.conversationId) ?? 1) : undefined,
      };
    });
  } finally {
    db.close();
  }
}

export function getEvents(
  accountEmail: string,
  daysForward: number,
): CalendarEvent[] {
  const acc = findAccount(accountEmail);
  if (!acc.eventSubdir) return [];

  const db = openDb(acc.accountUid, acc.eventSubdir, 'event_index.dat');

  try {
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + daysForward);
    const nowTicks = dateToTicks(now);
    const futureTicks = dateToTicks(future);

    const rows = db
      .prepare(
        `SELECT id, summary, description, location, start, end, status, type,
                organizerDisplayName, organizerAddress
         FROM EventItems
         WHERE end >= ? AND start <= ?
         ORDER BY start ASC`,
      )
      .all(nowTicks, futureTicks) as Array<{
      id: number;
      summary: string;
      description: string;
      location: string;
      start: number;
      end: number;
      status: number;
      type: number;
      organizerDisplayName: string;
      organizerAddress: string;
    }>;

    return rows.map((row) => {
      const startDate = ticksToDate(row.start) ?? new Date(0);
      const endDate = ticksToDate(row.end) ?? new Date(0);

      // All-day heuristic: duration is exactly a multiple of 24h and starts at midnight
      const durationMs = endDate.getTime() - startDate.getTime();
      const isAllDay =
        durationMs % (24 * 60 * 60 * 1000) === 0 &&
        startDate.getHours() === 0 &&
        startDate.getMinutes() === 0;

      return {
        id: row.id,
        summary: row.summary ?? '',
        description: row.description ?? '',
        location: row.location ?? '',
        start: startDate,
        end: endDate,
        status: row.status,
        type: row.type,
        organizerName: row.organizerDisplayName ?? '',
        organizerAddress: row.organizerAddress ?? '',
        accountEmail,
        isAllDay,
      };
    });
  } finally {
    db.close();
  }
}

export function getTasks(accountEmail: string): TaskItem[] {
  const acc = findAccount(accountEmail);
  if (!acc.taskSubdir) return [];

  const db = openDb(acc.accountUid, acc.taskSubdir, 'task_index.dat');

  try {
    const rows = db
      .prepare(
        `SELECT id, summary, description, start, end, completed, status, percentComplete
         FROM TaskItems
         ORDER BY end ASC`,
      )
      .all() as Array<{
      id: number;
      summary: string;
      description: string;
      start: number;
      end: number;
      completed: number;
      status: number;
      percentComplete: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      summary: row.summary ?? '',
      description: row.description ?? '',
      start: ticksToDate(row.start),
      end: ticksToDate(row.end),
      completed: ticksToDate(row.completed),
      status: row.status,
      percentComplete: row.percentComplete,
      accountEmail,
    }));
  } finally {
    db.close();
  }
}

export function getFolders(accountEmail: string): FolderItem[] {
  const acc = findAccount(accountEmail);

  // Try from mail_index.dat first, then folders.dat
  let db: Database.Database;
  try {
    db = openDb(acc.accountUid, acc.mailSubdir, 'folders.dat');
  } catch {
    db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  }

  try {
    const rows = db
      .prepare(`SELECT id, name, path, parentFolderId FROM Folders`)
      .all() as Array<{
      id: number;
      name: string;
      path: string;
      parentFolderId: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      path: row.path ?? '',
      parentFolderId: row.parentFolderId ?? null,
    }));
  } finally {
    db.close();
  }
}

export function searchMails(accountEmail: string, keyword: string, daysBack: number): MailItem[] {
  const acc = findAccount(accountEmail);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysBack);
    const cutoffTicks = dateToTicks(cutoff);
    const likePattern = `%${keyword}%`;

    const rows = db
      .prepare(
        `SELECT id, subject, date, receivedDate, preview, importance, flags, folder
         FROM MailItems
         WHERE date >= ? AND (flags & 65536) = 0
           AND (subject LIKE ? OR preview LIKE ?)
         ORDER BY date DESC
         LIMIT 200`,
      )
      .all(cutoffTicks, likePattern, likePattern) as Array<{
      id: number;
      subject: string;
      date: number;
      receivedDate: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
    }>;

    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
    );

    const folderMap = new Map<number, string>();
    try {
      const fdb = openDb(acc.accountUid, acc.mailSubdir, 'folders.dat');
      const fRows = fdb.prepare(`SELECT id, name FROM Folders`).all() as Array<{ id: number; name: string }>;
      for (const f of fRows) folderMap.set(f.id, f.name);
      fdb.close();
    } catch { /* folders.dat may not exist */ }

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{ type: number; displayName: string; address: string }>;
      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3).map((a): MailAddress => ({
        displayName: a.displayName, address: a.address, type: 3 as AddressType,
      }));

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToDate(row.date) ?? new Date(0),
        receivedDate: ticksToDate(row.receivedDate),
        preview: row.preview ?? '',
        importance: row.importance,
        flags: row.flags,
        folder: row.folder,
        folderName: folderMap.get(row.folder) ?? undefined,
        from: fromAddr ? { displayName: fromAddr.displayName, address: fromAddr.address, type: 1 as AddressType } : null,
        to: toAddrs,
        isRead: (row.flags & 2) !== 0,
        isFlagged: (row.flags & 4) !== 0,
        accountEmail,
      };
    });
  } finally {
    db.close();
  }
}

export function getMessageIdById(accountEmail: string, mailId: number): string | null {
  const acc = findAccount(accountEmail);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');

  try {
    const row = db
      .prepare('SELECT messageId FROM MailItems WHERE id = ?')
      .get(mailId) as { messageId: string } | undefined;
    return row?.messageId ?? null;
  } finally {
    db.close();
  }
}

export function getMailsByFolder(accountEmail: string, folderId: number, daysBack?: number): MailItem[] {
  const acc = findAccount(accountEmail);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');

  try {
    let query: string;
    let params: unknown[];

    if (daysBack) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      const cutoffTicks = dateToTicks(cutoff);
      query = `SELECT id, subject, date, receivedDate, preview, importance, flags, folder
               FROM MailItems
               WHERE folder = ? AND date >= ? AND (flags & 65536) = 0
               ORDER BY date DESC LIMIT 200`;
      params = [folderId, cutoffTicks];
    } else {
      query = `SELECT id, subject, date, receivedDate, preview, importance, flags, folder
               FROM MailItems
               WHERE folder = ? AND (flags & 65536) = 0
               ORDER BY date DESC LIMIT 200`;
      params = [folderId];
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: number; subject: string; date: number; receivedDate: number;
      preview: string; importance: number; flags: number; folder: number;
    }>;

    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
    );

    const folderMap = new Map<number, string>();
    try {
      const fdb = openDb(acc.accountUid, acc.mailSubdir, 'folders.dat');
      const fRows = fdb.prepare(`SELECT id, name FROM Folders`).all() as Array<{ id: number; name: string }>;
      for (const f of fRows) folderMap.set(f.id, f.name);
      fdb.close();
    } catch { /* folders.dat may not exist */ }

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{ type: number; displayName: string; address: string }>;
      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3).map((a): MailAddress => ({
        displayName: a.displayName, address: a.address, type: 3 as AddressType,
      }));

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToDate(row.date) ?? new Date(0),
        receivedDate: ticksToDate(row.receivedDate),
        preview: row.preview ?? '',
        importance: row.importance,
        flags: row.flags,
        folder: row.folder,
        folderName: folderMap.get(row.folder) ?? undefined,
        from: fromAddr ? { displayName: fromAddr.displayName, address: fromAddr.address, type: 1 as AddressType } : null,
        to: toAddrs,
        isRead: (row.flags & 2) !== 0,
        isFlagged: (row.flags & 4) !== 0,
        accountEmail,
      };
    });
  } finally {
    db.close();
  }
}
