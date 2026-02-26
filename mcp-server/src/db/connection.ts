import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DB_BASE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'eM Client',
);
const TMP_BASE = '/tmp/emclient_mcp';

/**
 * Open eM Client DB for reading.
 *
 * Strategy (same approach as Electron's db-reader.ts):
 * 1. Readonly mode — best: reads WAL data natively via shared lock
 * 2. VACUUM INTO — atomic snapshot that includes WAL data (no race condition)
 * 3. File copy fallback — copies DB + WAL + SHM to temp (last resort)
 *
 * The old approach (Strategy 3 only) had a race condition: if eM Client
 * wrote between copying the main DB and WAL files, queries would return
 * inconsistent data (e.g., wrong mail body for a given mail ID).
 */
function openDb(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`DB not found: ${srcPath}`);
  }

  // Strategy 1: Readonly on original — includes WAL, no copy needed
  try {
    return new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch {
    // eM Client holds exclusive lock — try snapshot approaches
  }

  const tmpDir = path.join(TMP_BASE, accountUid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, dbName);

  // Clean stale snapshot
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpPath + suffix); } catch { /* noop */ }
  }

  // Strategy 2: VACUUM INTO — atomic, consistent snapshot
  try {
    const srcDb = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      srcDb.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      srcDb.close();
    }
    return new Database(tmpPath, { readonly: true, fileMustExist: true });
  } catch {
    // VACUUM INTO may fail if DB is locked exclusively
  }

  // Strategy 3: File copy fallback (old behavior)
  fs.copyFileSync(srcPath, tmpPath);
  for (const suffix of ['-wal', '-shm']) {
    const walSrc = srcPath + suffix;
    if (fs.existsSync(walSrc)) {
      fs.copyFileSync(walSrc, tmpPath + suffix);
    }
  }
  return new Database(tmpPath, { readonly: true, fileMustExist: true });
}

export async function withDb<T>(
  accountUid: string,
  subdir: string,
  dbName: string,
  fn: (db: Database.Database) => T,
): Promise<T> {
  const db = openDb(accountUid, subdir, dbName);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function openDbSync(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  return openDb(accountUid, subdir, dbName);
}

/**
 * Open the ORIGINAL eM Client DB in read-write mode.
 * Use with extreme care — only for operations like move-to-trash.
 */
export function openDbForWrite(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`DB not found: ${srcPath}`);
  }
  return new Database(srcPath, { readonly: false, fileMustExist: true });
}
