import { ACCOUNTS, findAccount } from '../db/accounts.js';
import { openDbSync } from '../db/connection.js';
import { ticksToISO } from '../db/tick-converter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalyzeThreadParams {
  mail_id: number;
  account: string;
}

interface ThreadMessage {
  id: number;
  subject: string;
  date: string;
  preview: string;
  from: string;
  to: string[];
  cc: string[];
  folderName: string;
  isRead: boolean;
  isSentByMe: boolean;
  importance: number;
}

interface ActionItem {
  text: string;
  source: 'subject' | 'preview';
  messageId: number;
  messageDate: string;
  from: string;
}

interface ThreadAnalysis {
  conversationId: string;
  normalizedSubject: string;
  messageCount: number;
  myRole: 'direct_recipient' | 'cc_recipient' | 'sender' | 'unknown';
  threadState: 'awaiting_reply' | 'needs_action' | 'informational' | 'resolved';
  personalTasks: ActionItem[];
  actionItems: ActionItem[];
  participants: string[];
  urgencyLevel: 'high' | 'medium' | 'low';
}

// ---------------------------------------------------------------------------
// Helper functions (same patterns as get-mail-thread.ts)
// ---------------------------------------------------------------------------

function formatAddress(displayName: string | null, address: string | null): string {
  if (!address) return '';
  if (displayName) return `${displayName} <${address}>`;
  return address;
}

function withDbSync<T>(
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

/** Strip Re:/RE:/Fw:/Fwd:/Re[N]: prefixes and whitespace */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(Re|RE|Fw|FW|Fwd|転送|返信)\s*(\[\d+\])?\s*:\s*)+/g, '')
    .trim();
}

function getSentFolderIds(accountUid: string, mailSubdir: string): Set<number> {
  const sentFolderIds = new Set<number>();
  try {
    const fdb = openDbSync(accountUid, mailSubdir, 'folders.dat');
    try {
      const fRows = fdb
        .prepare(`SELECT id, name FROM Folders`)
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        const lower = f.name.toLowerCase();
        if (
          lower === 'sent' || lower === '送信済み' || lower === '送信箱' ||
          lower === 'sent mail' || lower === 'sent items'
        ) {
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

function getFolderMap(accountUid: string, mailSubdir: string): Map<number, string> {
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

/** Determine my role in the thread based on To/CC analysis */
function determineMyRole(
  messages: ThreadMessage[],
  myEmails: string[],
): 'direct_recipient' | 'cc_recipient' | 'sender' | 'unknown' {
  const myEmailSet = new Set(myEmails.map((e) => e.toLowerCase()));

  // Check the most recent non-sent message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.isSentByMe) continue;

    // Check To
    for (const to of m.to) {
      const addr = to.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? to.toLowerCase();
      if (myEmailSet.has(addr)) return 'direct_recipient';
    }
    // Check CC
    for (const cc of m.cc) {
      const addr = cc.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? cc.toLowerCase();
      if (myEmailSet.has(addr)) return 'cc_recipient';
    }
  }

  // If I sent messages but wasn't addressed
  if (messages.some((m) => m.isSentByMe)) return 'sender';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Analysis-specific logic
// ---------------------------------------------------------------------------

/** Japanese and English action keywords for task extraction */
const ACTION_KEYWORDS_JA = [
  'お願い', 'ください', '確認', '対応', '提出', '報告', '連絡',
  '回答', '返信', '至急', '期限', '締切', '必要',
];

const ACTION_KEYWORDS_EN = [
  'please', 'action required', 'urgent', 'deadline', 'asap',
  'by end of', 'respond', 'confirm', 'submit', 'review',
  'approval needed', 'follow up', 'reminder',
];

const ALL_ACTION_KEYWORDS = [...ACTION_KEYWORDS_JA, ...ACTION_KEYWORDS_EN];

/** Urgency keywords (subset of action keywords + extras) */
const URGENCY_KEYWORDS = [
  'urgent', '至急', '緊急', 'asap', '急ぎ', '重要', '急募',
  'action required', 'immediately', '直ちに',
];

/** Check if a recipient address matches any of my emails */
function isMyAddress(addrField: string, myEmailSet: Set<string>): boolean {
  const addr = addrField.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? addrField.toLowerCase();
  return myEmailSet.has(addr);
}

/** Extract action items from thread messages */
function extractActionItems(
  messages: ThreadMessage[],
  myEmails: string[],
): { personalTasks: ActionItem[]; actionItems: ActionItem[] } {
  const myEmailSet = new Set(myEmails.map((e) => e.toLowerCase()));
  const personalTasks: ActionItem[] = [];
  const actionItems: ActionItem[] = [];
  const seenMessageIds = new Set<number>();

  for (const msg of messages) {
    // Skip messages sent by me
    if (msg.isSentByMe) continue;

    const preview = msg.preview ?? '';
    const subject = msg.subject ?? '';
    const previewLower = preview.toLowerCase();
    const subjectLower = subject.toLowerCase();

    // Check preview for action keywords
    let found = false;
    for (const keyword of ALL_ACTION_KEYWORDS) {
      const kwLower = keyword.toLowerCase();
      const idx = previewLower.indexOf(kwLower);
      if (idx !== -1) {
        // Extract surrounding context (up to 200 chars around keyword)
        const start = Math.max(0, idx - 50);
        const end = Math.min(preview.length, idx + keyword.length + 150);
        const contextText = preview.slice(start, end).trim();

        const item: ActionItem = {
          text: contextText,
          source: 'preview',
          messageId: msg.id,
          messageDate: msg.date,
          from: msg.from,
        };
        actionItems.push(item);
        seenMessageIds.add(msg.id);

        // Personal task if addressed to me directly
        if (msg.to.some((to) => isMyAddress(to, myEmailSet))) {
          personalTasks.push(item);
        }
        found = true;
        break; // One action item per message
      }
    }

    // Check subject for action keywords (only if not already captured from preview)
    if (!found) {
      for (const keyword of ALL_ACTION_KEYWORDS) {
        if (subjectLower.includes(keyword.toLowerCase())) {
          const item: ActionItem = {
            text: normalizeSubject(subject),
            source: 'subject',
            messageId: msg.id,
            messageDate: msg.date,
            from: msg.from,
          };
          actionItems.push(item);
          seenMessageIds.add(msg.id);

          if (msg.to.some((to) => isMyAddress(to, myEmailSet))) {
            personalTasks.push(item);
          }
          break;
        }
      }
    }
  }

  return { personalTasks, actionItems };
}

/** Determine thread state based on message flow and my role */
function determineThreadState(
  messages: ThreadMessage[],
  myRole: 'direct_recipient' | 'cc_recipient' | 'sender' | 'unknown',
): 'awaiting_reply' | 'needs_action' | 'informational' | 'resolved' {
  if (messages.length === 0) return 'informational';

  const lastMessage = messages[messages.length - 1];

  // If I sent the last message, I'm awaiting a reply
  if (lastMessage.isSentByMe) return 'awaiting_reply';

  // If I'm a direct recipient and the last message is from someone else
  if (myRole === 'direct_recipient') return 'needs_action';

  // If I'm the sender but the last message is from someone else, may need follow-up
  if (myRole === 'sender') return 'needs_action';

  // If I'm CC'd, it's informational
  if (myRole === 'cc_recipient') return 'informational';

  return 'informational';
}

/** Determine urgency level based on importance flags, keywords, and recency */
function determineUrgencyLevel(
  messages: ThreadMessage[],
  threadState: 'awaiting_reply' | 'needs_action' | 'informational' | 'resolved',
): 'high' | 'medium' | 'low' {
  // Check for high importance flags (importance=2 in eM Client)
  if (messages.some((m) => m.importance === 2)) return 'high';

  // Check for urgency keywords in subject or preview
  for (const msg of messages) {
    const text = ((msg.subject ?? '') + ' ' + (msg.preview ?? '')).toLowerCase();
    if (URGENCY_KEYWORDS.some((kw) => text.includes(kw))) return 'high';
  }

  // Needs action and recent (within last 2 days) is medium urgency
  if (threadState === 'needs_action' && messages.length > 0) {
    const lastDate = new Date(messages[messages.length - 1].date);
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    if (lastDate > twoDaysAgo) return 'medium';
  }

  // Awaiting reply is at least medium
  if (threadState === 'awaiting_reply') return 'medium';

  return 'low';
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function analyzeThread(params: AnalyzeThreadParams): ThreadAnalysis {
  const acc = findAccount(params.account);
  const myEmails = ACCOUNTS.map((a) => a.email);

  const threadData = withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) => {
    const targetMail = db
      .prepare(`SELECT conversationId, subject FROM MailItems WHERE id = ?`)
      .get(params.mail_id) as { conversationId: string | null; subject: string } | undefined;

    if (!targetMail || !targetMail.conversationId) {
      throw new Error(`Mail not found or has no conversation: id=${params.mail_id}`);
    }

    const convId = targetMail.conversationId;
    const normalizedSubj = normalizeSubject(targetMail.subject ?? '');

    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, importance, flags, folder
         FROM MailItems
         WHERE conversationId = ?
         ORDER BY date ASC`,
      )
      .all(convId) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      importance: number;
      flags: number;
      folder: number;
    }>;

    const folderMap = getFolderMap(acc.accountUid, acc.mailSubdir);
    const sentFolderIds = getSentFolderIds(acc.accountUid, acc.mailSubdir);

    const addrStmt = db.prepare(
      `SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?`,
    );

    const participantSet = new Set<string>();

    const messages: ThreadMessage[] = rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number; displayName: string; address: string;
      }>;

      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs.filter((a) => a.type === 3);
      const ccAddrs = addrs.filter((a) => a.type === 4);

      if (fromAddr?.address) participantSet.add(fromAddr.address);
      for (const a of [...toAddrs, ...ccAddrs]) {
        if (a.address) participantSet.add(a.address);
      }

      const isSentByMe = sentFolderIds.has(row.folder);

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToISO(row.date) ?? new Date(0).toISOString(),
        preview: (row.preview ?? '').slice(0, 500),
        from: fromAddr ? formatAddress(fromAddr.displayName, fromAddr.address) : '',
        to: toAddrs.map((a) => formatAddress(a.displayName, a.address)),
        cc: ccAddrs.map((a) => formatAddress(a.displayName, a.address)),
        folderName: folderMap.get(row.folder) ?? '',
        isRead: (row.flags & 2) !== 0,
        isSentByMe,
        importance: row.importance ?? 0,
      };
    });

    return { convId, normalizedSubj, messages, participants: [...participantSet] };
  });

  const myRole = determineMyRole(threadData.messages, myEmails);
  const threadState = determineThreadState(threadData.messages, myRole);
  const { personalTasks, actionItems } = extractActionItems(threadData.messages, myEmails);
  const urgencyLevel = determineUrgencyLevel(threadData.messages, threadState);

  return {
    conversationId: threadData.convId,
    normalizedSubject: threadData.normalizedSubj,
    messageCount: threadData.messages.length,
    myRole,
    threadState,
    personalTasks,
    actionItems,
    participants: threadData.participants,
    urgencyLevel,
  };
}
