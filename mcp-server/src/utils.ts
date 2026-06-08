/**
 * Shared utility functions for MCP server tools.
 * Extracted from duplicated implementations across tool files.
 */

import { openDbSync } from './db/connection.js';
import { findAccount } from './db/accounts.js';

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

/**
 * Read folders.dat ONCE and return both the id→name map and the set of Sent
 * folder ids. Several tools need both; this avoids opening folders.dat twice
 * (which is what calling getFolderMap + getSentFolderIds separately would do).
 */
export function getFolderInfo(
  accountUid: string,
  mailSubdir: string,
): { folderMap: Map<number, string>; sentFolderIds: Set<number> } {
  const folderMap = new Map<number, string>();
  const sentFolderIds = new Set<number>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        folderMap.set(f.id, f.name);
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
  return { folderMap, sentFolderIds };
}

/**
 * Escape `%`, `_`, and the escape char itself for safe use in a SQL LIKE
 * pattern. Pair with an `ESCAPE '\\'` clause so user input is matched literally
 * instead of as wildcards. Returns the inner pattern WITHOUT surrounding `%`.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

/**
 * Look up the conversationId for a mail so notes can be keyed the same way the
 * GUI keys them (`conv-{conversationId}` when present, else `mail-{mailId}`).
 *
 * Returns null if the account/mail can't be resolved — callers then fall back
 * to the mail-based note id. Never throws.
 */
export function getConversationId(mailId: number, accountEmail: string): string | null {
  try {
    const acc = findAccount(accountEmail);
    return withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
      const row = db
        .prepare('SELECT conversationId FROM MailItems WHERE id = ?')
        .get(mailId) as { conversationId: string | null } | undefined;
      return row?.conversationId ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * Find the note file for a mail.
 *
 * Resolution order (matches the GUI's NoteService keying):
 *   1. If an existing `conv-{conversationId}.json` is present, use it.
 *   2. Else if an existing `mail-{mailId}.json` is present, use it (legacy /
 *      notes created before conversationId was threaded through).
 *   3. For a brand-new note: prefer `conv-{conversationId}` when a
 *      conversationId is known, otherwise `mail-{mailId}`.
 *
 * Step 3 is the key fix for the "note id split" bug: the GUI writes
 * `conv-{convId}` whenever a conversationId exists, so MCP must do the same or
 * the two sides create separate, mutually-invisible note files.
 */
export function findNotePath(mailId: number, conversationId?: string | null): { path: string; id: string; exists: boolean } {
  const notesDir = getNotesDir();

  // 1. Existing conversation-based note
  const convId = conversationId ? `conv-${conversationId}` : null;
  const convPath = convId ? path.join(notesDir, `${convId}.json`) : null;
  if (convId && convPath && fs.existsSync(convPath)) {
    return { path: convPath, id: convId, exists: true };
  }

  // 2. Existing mail-based note
  const mailNoteId = `mail-${mailId}`;
  const mailPath = path.join(notesDir, `${mailNoteId}.json`);
  if (fs.existsSync(mailPath)) {
    return { path: mailPath, id: mailNoteId, exists: true };
  }

  // 3. New note — match the GUI: conv-{convId} when available, else mail-{mailId}.
  if (convId && convPath) {
    return { path: convPath, id: convId, exists: false };
  }
  return { path: mailPath, id: mailNoteId, exists: false };
}
