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

function copyDbFile(src: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, destFile);

  // Copy WAL/SHM if present
  for (const suffix of ['-wal', '-shm']) {
    const walSrc = src + suffix;
    if (fs.existsSync(walSrc)) {
      fs.copyFileSync(walSrc, destFile + suffix);
    }
  }

  return destFile;
}

function openDb(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`DB not found: ${srcPath}`);
  }
  const tmpDir = path.join(TMP_BASE, accountUid);
  const tmpPath = copyDbFile(srcPath, tmpDir);
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
