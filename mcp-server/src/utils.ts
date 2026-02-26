/**
 * Shared utility functions for MCP server tools.
 * Extracted from duplicated implementations across tool files.
 */

import { openDbSync } from './db/connection.js';

// ---------------------------------------------------------------------------
// Address formatting
// ---------------------------------------------------------------------------

/** Format email address as "DisplayName <address>" or just address */
export function formatAddress(displayName: string | null, address: string | null): string {
  if (!address) return '';
  if (displayName) return `${displayName} <${address}>`;
  return address;
}

// ---------------------------------------------------------------------------
// Subject normalization
// ---------------------------------------------------------------------------

/** Strip Re:/RE:/Fw:/Fwd:/Re[N]: prefixes and whitespace */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(Re|RE|Fw|FW|Fwd|転送|返信)\s*(\[\d+\])?\s*:\s*)+/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** Open a DB, run a function, then close. Ensures DB is always closed. */
export function withDbSync<T>(
  accountUid: string,
  subdir: string,
  dbName: string,
  fn: (db: import('better-sqlite3').Database) => T,
): T {
  const db = openDbSync(accountUid, subdir, dbName);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

const SENT_FOLDER_NAMES = new Set([
  'sent', '送信済み', '送信箱', 'sent mail', 'sent items',
]);

/** Get Set of folder IDs that are Sent folders for an account */
export function getSentFolderIds(accountUid: string, mailSubdir: string): Set<number> {
  const sentFolderIds = new Set<number>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        if (SENT_FOLDER_NAMES.has(f.name.toLowerCase())) {
          sentFolderIds.add(f.id);
        }
      }
    } finally {
      fdb.close();
    }
  } catch {
    // folders.dat may not exist
  }
  return sentFolderIds;
}

/** Get Map of folder ID → folder name for an account */
export function getFolderMap(accountUid: string, mailSubdir: string): Map<number, string> {
  const folderMap = new Map<number, string>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        folderMap.set(f.id, f.name);
      }
    } finally {
      fdb.close();
    }
  } catch {
    // folders.dat may not exist
  }
  return folderMap;
}

// ---------------------------------------------------------------------------
// Notes directory (shared with tag_mail, get_note, update_note)
// ---------------------------------------------------------------------------

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/** Get the path to the Shirabe notes directory */
export function getNotesDir(): string {
  return path.join(
    os.homedir(), 'Library', 'Application Support', '調 - Shirabe', 'notes',
  );
}

/** Ensure the notes directory exists */
export function ensureNotesDir(): string {
  const dir = getNotesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Find an existing note file for a mail (tries conv-{convId} then mail-{mailId}) */
export function findNotePath(mailId: number, conversationId?: string | null): { path: string; id: string; exists: boolean } {
  const notesDir = getNotesDir();

  // Try conversation-based ID first
  if (conversationId) {
    const convId = `conv-${conversationId}`;
    const convPath = path.join(notesDir, `${convId}.json`);
    if (fs.existsSync(convPath)) {
      return { path: convPath, id: convId, exists: true };
    }
  }

  // Try mail-based ID
  const mailNoteId = `mail-${mailId}`;
  const mailPath = path.join(notesDir, `${mailNoteId}.json`);
  if (fs.existsSync(mailPath)) {
    return { path: mailPath, id: mailNoteId, exists: true };
  }

  // Default: prefer mail-based ID for new notes (matches tag_mail behavior)
  return { path: mailPath, id: mailNoteId, exists: false };
}
