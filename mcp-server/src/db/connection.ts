import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
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

/** Time (ms) to wait for a SQLite lock before giving up on write operations. */
const WRITE_BUSY_TIMEOUT_MS = 5000;

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
 * Resolve the absolute path of an eM Client DB file without opening it.
 */
export function resolveDbPath(
  accountUid: string,
  subdir: string,
  dbName: string,
): string {
  return path.join(DB_BASE, accountUid, subdir, dbName);
}

/**
 * Check whether eM Client is currently running on macOS.
 *
 * Writing to the live DB while the app is running races against eM Client's
 * sync engine and can be silently rolled back (or corrupt the WAL), so callers
 * should refuse to write when this returns true.
 *
 * The app bundle executable is literally named "eM Client" (with a space), so
 * the full process command line contains "eM Client.app/Contents/MacOS/eM Client".
 * We match against that to avoid false positives from this MCP server itself.
 */
export function isEmClientRunning(): boolean {
  try {
    // pgrep -f matches against the full argv; the .app path is stable.
    // Exit code 0 = at least one match, 1 = no match, >1 = error.
    execFileSync('pgrep', ['-f', 'eM Client.app/Contents/MacOS/eM Client'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 1) return false; // no matching process
    // pgrep missing or errored — try a coarser fallback before giving up.
    try {
      execFileSync('pgrep', ['-x', 'eM Client'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch (err2) {
      if ((err2 as { status?: number }).status === 1) return false;
      // Unable to determine — assume NOT running so we don't block legitimate
      // use on systems without pgrep. (Backup + transaction still protect data.)
      return false;
    }
  }
}

/**
 * Make a timestamped backup copy of a DB file before a destructive write.
 *
 * Tries `VACUUM INTO` first (atomic, compacted, WAL-inclusive snapshot); falls
 * back to a plain file copy (incl. -wal/-shm) if that fails. Returns the path
 * of the backup so callers can surface it for manual recovery.
 */
export function backupDbFile(srcPath: string): string {
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Cannot back up — DB not found: ${srcPath}`);
  }
  const stamp = Math.floor(Date.now() / 1000);
  const backupPath = `${srcPath}.shirabe-backup-${stamp}`;

  // Strategy 1: VACUUM INTO — atomic & consistent, includes WAL data.
  try {
    const srcDb = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      srcDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } finally {
      srcDb.close();
    }
    return backupPath;
  } catch {
    // VACUUM INTO may fail (locked exclusively, disk, etc.) — fall back.
  }

  // Strategy 2: plain file copy of DB + WAL + SHM sidecars.
  fs.copyFileSync(srcPath, backupPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(srcPath + suffix)) {
      fs.copyFileSync(srcPath + suffix, backupPath + suffix);
    }
  }
  return backupPath;
}

/**
 * Open the ORIGINAL eM Client DB in read-write mode.
 * Use with extreme care — only for operations like move-to-trash.
 *
 * Sets a busy_timeout so transient locks from eM Client's own access don't
 * immediately fail the write.
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
  const db = new Database(srcPath, { readonly: false, fileMustExist: true });
  db.pragma(`busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`);
  return db;
}
