/**
 * Lightweight client-side spam filter for Dashboard use.
 * Mirrors the patterns from electron/services/junk-detector.ts
 * but runs in the renderer process without API calls.
 */
import type { MailItem } from '../types';

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
 * Does NOT filter by folder name — content-only analysis.
 * Returns true only for high-confidence spam (2+ pattern matches).
 */
export function isObviousSpam(mail: MailItem): boolean {
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
