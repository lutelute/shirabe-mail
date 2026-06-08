/**
 * Single source of truth for client-side spam / junk classification in the
 * renderer. Previously the logic was split across two systems:
 *   - utils/spamFilter.ts  : content heuristic (isObviousSpam)
 *   - hooks/useMailData.ts : folder-name list (isSpamFolder)
 * which disagreed and — worse — the folder list lumped Drafts / Trash / Sent
 * in with real spam folders, causing those mails to be silently dropped.
 *
 * This module unifies both. The content heuristic mirrors the patterns from
 * electron/services/junk-detector.ts but runs in the renderer without API calls.
 *
 * Folder taxonomy:
 *   - JUNK folders      : actual spam / junk mail (safe to exclude).
 *   - PROTECTED folders : Drafts / Trash / Deleted / Sent — user content that
 *                         must NEVER be judged or excluded as spam.
 */
import type { MailItem } from '../types';

// === Folder classification ===

// Folders that genuinely hold spam / junk mail.
const JUNK_FOLDER_NAMES = new Set([
  'spam', 'junk', 'junk e-mail', 'junk email',
  '迷惑メール', 'スパム',
  'bulk mail', 'bulk',
]);

// Folders whose mail is legitimate user content and must be exempt from any
// spam judgement (drafts the user is writing, trashed items, sent mail).
const PROTECTED_FOLDER_NAMES = new Set([
  'trash', 'deleted items', 'deleted', 'ゴミ箱', '削除済みアイテム',
  'drafts', 'draft', '下書き',
  'sent', 'sent items', 'sent mail', '送信済み', '送信済みアイテム',
  'outbox', '送信トレイ',
]);

/** True only for folders that actually hold spam / junk mail. */
export function isJunkFolder(folderName?: string): boolean {
  if (!folderName) return false;
  return JUNK_FOLDER_NAMES.has(folderName.trim().toLowerCase());
}

/**
 * True for folders that must be exempt from spam judgement
 * (Drafts / Trash / Deleted / Sent / Outbox).
 */
export function isProtectedFolder(folderName?: string): boolean {
  if (!folderName) return false;
  return PROTECTED_FOLDER_NAMES.has(folderName.trim().toLowerCase());
}

/**
 * @deprecated Use {@link isJunkFolder} (real spam folders only) or
 * {@link shouldExcludeAsSpam} (full exclusion decision). Retained as the union
 * of junk + protected folders only for any callers that relied on the old
 * "is this a non-inbox folder" semantics; new code should not use it.
 */
export function isSpamFolder(folderName?: string): boolean {
  return isJunkFolder(folderName) || isProtectedFolder(folderName);
}

// === Content heuristic ===

// Keywords that indicate marketing/spam content
const SPAM_KEYWORDS = [
  'unsubscribe', '配信停止', 'メルマガ', 'newsletter', 'セール',
  'キャンペーン', 'クーポン', '広告', 'noreply', 'no-reply',
  'sale', 'discount', 'promotion', 'opt out', 'opt-out',
  '購読解除', 'メール配信', 'お知らせメール',
  'limited time', '期間限定', '特別価格', 'special offer',
  'click here', 'act now', '今すぐ',
  'free trial', '無料', 'ポイント還元', '当選', 'congratulations',
  'verify your account', 'アカウントを確認',
];

// Sender address patterns typical of automated/marketing mail
const SPAM_SENDER_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /newsletter@/i,
  /marketing@/i,
  /promo@/i,
  /mailer@/i,
  /updates@.*\.(com|net|org)$/i,
  /bounce@/i,
  /campaign@/i,
  /bulk@/i,
];

// Domains that are always considered safe (academic, government, non-profit)
const SAFE_DOMAIN_SUFFIXES = [
  '.ac.jp', '.edu', '.go.jp', '.gov', '.lg.jp', '.or.jp',
];

function isSafeDomain(address: string): boolean {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  return SAFE_DOMAIN_SUFFIXES.some(s => domain.endsWith(s));
}

function isReplyOrForward(subject: string): boolean {
  return /^(Re:|Fwd:|Fw:|RE:|FW:)/i.test(subject.trim());
}

/**
 * Quick check if a mail is obviously spam based on content patterns.
 * Does NOT filter by folder name — content-only analysis — except that mails in
 * protected folders (Drafts / Trash / Sent) are never judged as spam.
 * Returns true only for high-confidence spam (2+ pattern matches).
 */
export function isObviousSpam(mail: MailItem): boolean {
  // Never judge user content in protected folders.
  if (isProtectedFolder(mail.folderName)) return false;

  const senderAddr = mail.from?.address?.toLowerCase() ?? '';

  // Safe domains are never spam
  if (senderAddr && isSafeDomain(senderAddr)) return false;

  // Reply/Forward = part of a conversation, not spam
  if (isReplyOrForward(mail.subject)) return false;

  // Flagged or high-importance mails are unlikely spam
  if (mail.isFlagged || mail.importance > 1) return false;

  // Count pattern matches
  const text = `${mail.subject} ${mail.preview ?? ''}`.toLowerCase();
  let matchCount = 0;

  for (const kw of SPAM_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      matchCount++;
      if (matchCount >= 2) return true; // early exit
    }
  }

  if (SPAM_SENDER_PATTERNS.some(pat => pat.test(senderAddr))) {
    matchCount++;
  }

  return matchCount >= 2;
}

/**
 * Unified decision used when fetching mail with "exclude spam" enabled.
 * A mail is excluded only when it lives in a genuine junk/spam folder.
 * Protected folders (Drafts / Trash / Sent) are always kept.
 */
export function shouldExcludeAsSpam(mail: { folderName?: string }): boolean {
  if (isProtectedFolder(mail.folderName)) return false;
  return isJunkFolder(mail.folderName);
}
