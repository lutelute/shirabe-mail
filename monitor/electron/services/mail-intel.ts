// === Mail intelligence (DB only, no AI) ===
//
// eM Client の DB から「秘書が判断に使う材料」を決定論的に取り出す層。
//  - 受信箱の候補メール(To/Cc を正しく区別、送信/ゴミ箱/迷惑/下書きは除外)
//  - 送信者ごとの付き合いの深さ(受信数・先生の返信数・先生からの送信数)
//  - 本文全文(mail_fti.dat の全文検索インデックスから、引用・署名を剥がして)
//  - スレッド文脈(誰が最後に発言したか、先生の返信回数)
//  - 先生の文体見本(最近の送信メール)
//
// AI を呼ぶ前にこれらを揃えることで、プレビュー256文字だけで判定していた v1 の弱さを解消する。

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openDb, getAccounts } from './db-reader';
import { ticksToDate, dateToTicks } from './tick-converter';
import { AddressType } from '../../src/types/index';
import type { MailItem, MailAddress, SenderStats, AccountConfig } from '../../src/types/index';

const DB_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'eM Client');

// --- フォルダ分類 ---
const SENT_NAMES = ['sent', 'sent items', 'sent mail', 'sent messages', '送信済み', '送信済みアイテム', '送信済みメール', '送信箱'];
const JUNK_NAMES = ['junk', 'junk e-mail', 'junk email', 'junkmail', 'spam', '迷惑メール', 'スパム', 'bulk', 'bulk mail'];
const TRASH_NAMES = ['trash', 'deleted items', 'deleted messages', 'deleted', 'ゴミ箱', '削除済みアイテム'];
const DRAFT_NAMES = ['drafts', 'draft', '下書き', 'outbox', '送信トレイ'];
const SKIP_NAMES = ['notes', 'apple mail to do', 'root', '[gmail]', '[imap]'];

export type FolderKind = 'inbox' | 'sent' | 'junk' | 'trash' | 'draft' | 'skip';

export interface FolderInfo {
  names: Map<number, string>;
  kinds: Map<number, FolderKind>;
  sentIds: Set<number>;
  junkIds: Set<number>;
}

function classifyFolderName(name: string): FolderKind {
  const n = name.trim().toLowerCase();
  if (SENT_NAMES.includes(n)) return 'sent';
  if (JUNK_NAMES.includes(n)) return 'junk';
  if (TRASH_NAMES.includes(n)) return 'trash';
  if (DRAFT_NAMES.includes(n)) return 'draft';
  if (SKIP_NAMES.includes(n)) return 'skip';
  return 'inbox';
}

function findAccount(email: string): AccountConfig {
  const acc = getAccounts().find((a) => a.email === email);
  if (!acc) throw new Error(`Unknown account: ${email}`);
  return acc;
}

/** 巨大DB(fti等)は VACUUM/コピーせず readonly でのみ開く。失敗したら null */
function openReadonlyOrNull(accountUid: string, subdir: string, dbName: string): Database.Database | null {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) return null;
  try {
    return new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

export function getFolderInfo(accountEmail: string): FolderInfo {
  const acc = findAccount(accountEmail);
  const info: FolderInfo = { names: new Map(), kinds: new Map(), sentIds: new Set(), junkIds: new Set() };
  let db: Database.Database | null = null;
  try {
    db = openDb(acc.accountUid, acc.mailSubdir, 'folders.dat');
    const rows = db.prepare('SELECT id, name, path FROM Folders').all() as Array<{ id: number; name: string; path: string }>;
    for (const r of rows) {
      const name = r.name ?? '';
      info.names.set(r.id, name);
      const kind = classifyFolderName(name);
      info.kinds.set(r.id, kind);
      if (kind === 'sent') info.sentIds.add(r.id);
      if (kind === 'junk') info.junkIds.add(r.id);
    }
  } catch {
    /* folders.dat may be missing */
  } finally {
    db?.close();
  }
  return info;
}

// --- 受信箱候補 ---

export interface CandidateMail extends MailItem {
  cc: MailAddress[];
  folderKind: FolderKind;
  isSpamFlagged: boolean;      // 件名に [SPAM] 等のサーバー側マーク
  replyDate: Date | null;      // 先生が返信した日時(eM Client)
}

export interface CandidateQuery {
  since: Date;
  unreadOnly?: boolean;        // 既定 true
  limit?: number;              // 新しい順に上限
  excludeIds?: Set<number>;    // 処理済み
}

function myAddresses(): Set<string> {
  return new Set(getAccounts().map((a) => a.email.toLowerCase()));
}

const SPAM_SUBJECT_RE = /^\s*(\[spam\]|\*\*\*spam\*\*\*|\[迷惑メール\]|\[junk\])/i;

/**
 * 受信箱(相当)にある候補メールを新しい順で返す。
 * Gmail 型アカウントは「すべてのメール」に受信が入るため、フォルダ名で除外する方式にしている。
 */
export function getCandidateMails(accountEmail: string, q: CandidateQuery): CandidateMail[] {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  const mine = myAddresses();
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const unreadClause = q.unreadOnly === false ? '' : 'AND (flags & 2) = 0';
    const rows = db
      .prepare(
        `SELECT id, subject, date, receivedDate, preview, importance, flags, folder, conversationId, replyDate
         FROM MailItems
         WHERE date >= ? AND (flags & 65536) = 0 ${unreadClause}
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(dateToTicks(q.since), Math.max((q.limit ?? 300) * 3, 300)) as Array<{
      id: number; subject: string; date: number; receivedDate: number; preview: string;
      importance: number; flags: number; folder: number; conversationId: string | null; replyDate: number | null;
    }>;

    const addrStmt = db.prepare('SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?');
    const out: CandidateMail[] = [];
    for (const row of rows) {
      if (q.excludeIds?.has(row.id)) continue;
      const kind = folders.kinds.get(row.folder) ?? 'inbox';
      if (kind !== 'inbox' && kind !== 'junk') continue;
      const addrs = addrStmt.all(row.id) as Array<{ type: number; displayName: string; address: string }>;
      const fromAddr = addrs.find((a) => a.type === AddressType.From);
      // 自分が送ったメール(Gmailの「すべてのメール」に混ざる)は除外
      if (fromAddr && mine.has((fromAddr.address ?? '').toLowerCase())) continue;
      const toAddrs = addrs.filter((a) => a.type === AddressType.To).map((a): MailAddress => ({ displayName: a.displayName, address: a.address, type: AddressType.To }));
      const ccAddrs = addrs.filter((a) => a.type === AddressType.Cc).map((a): MailAddress => ({ displayName: a.displayName, address: a.address, type: AddressType.Cc }));
      out.push({
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToDate(row.date) ?? new Date(0),
        receivedDate: ticksToDate(row.receivedDate),
        preview: row.preview ?? '',
        importance: row.importance,
        flags: row.flags,
        folder: row.folder,
        folderName: folders.names.get(row.folder),
        from: fromAddr ? { displayName: fromAddr.displayName, address: fromAddr.address, type: AddressType.From } : null,
        to: toAddrs,
        cc: ccAddrs,
        isRead: (row.flags & 2) !== 0,
        isFlagged: (row.flags & 4) !== 0,
        accountEmail,
        conversationId: row.conversationId ?? undefined,
        folderKind: kind,
        isSpamFlagged: kind === 'junk' || SPAM_SUBJECT_RE.test(row.subject ?? ''),
        replyDate: row.replyDate ? ticksToDate(row.replyDate) : null,
      });
      if (q.limit && out.length >= q.limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

// --- 送信者統計 ---

/**
 * 送信者アドレス → 付き合いの深さ。
 *  received: 受信数 / replied: 先生が返信した数(replyDate) / sentTo: 先生から送った数(送信済みのTo/Cc)
 */
export function getSenderStats(accountEmail: string, daysBack = 400): Map<string, SenderStats> {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffTicks = dateToTicks(cutoff);
  const stats = new Map<string, SenderStats>();
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    // 受信側: From ごとの受信数と返信数
    const skipFolders = [...folders.kinds.entries()].filter(([, k]) => k !== 'inbox').map(([id]) => id);
    const skipClause = skipFolders.length > 0 ? `AND m.folder NOT IN (${skipFolders.join(',')})` : '';
    const recv = db
      .prepare(
        `SELECT lower(a.address) AS address,
                COUNT(*) AS received,
                SUM(CASE WHEN m.replyDate IS NOT NULL AND m.replyDate > 0 THEN 1 ELSE 0 END) AS replied,
                MAX(CASE WHEN m.replyDate IS NOT NULL AND m.replyDate > 0 THEN m.replyDate ELSE 0 END) AS lastReply
         FROM MailItems m
         JOIN MailAddresses a ON a.parentId = m.id AND a.type = ${AddressType.From}
         WHERE m.date >= ? AND (m.flags & 65536) = 0 ${skipClause}
         GROUP BY lower(a.address)`,
      )
      .all(cutoffTicks) as Array<{ address: string; received: number; replied: number; lastReply: number }>;
    for (const r of recv) {
      if (!r.address) continue;
      stats.set(r.address, {
        received: r.received,
        replied: r.replied,
        sentTo: 0,
        lastReplyAt: r.lastReply ? ticksToDate(r.lastReply)?.toISOString() : undefined,
      });
    }
    // 送信側: 送信済みフォルダの To/Cc
    if (folders.sentIds.size > 0) {
      const sent = db
        .prepare(
          `SELECT lower(a.address) AS address, COUNT(*) AS n
           FROM MailItems m
           JOIN MailAddresses a ON a.parentId = m.id AND a.type IN (${AddressType.To}, ${AddressType.Cc})
           WHERE m.date >= ? AND (m.flags & 65536) = 0 AND m.folder IN (${[...folders.sentIds].join(',')})
           GROUP BY lower(a.address)`,
        )
        .all(cutoffTicks) as Array<{ address: string; n: number }>;
      for (const s of sent) {
        if (!s.address) continue;
        const cur = stats.get(s.address) ?? { received: 0, replied: 0, sentTo: 0 };
        cur.sentTo = s.n;
        stats.set(s.address, cur);
      }
    }
  } finally {
    db.close();
  }
  return stats;
}

// --- 本文(全文) ---

const QUOTE_START_RES: RegExp[] = [
  /^On .{6,120} wrote:\s*$/i,
  /^\d{4}[/年]\d{1,2}[/月]\d{1,2}.{0,40}(wrote|書きました)[:：]?\s*$/,
  /^-{2,}\s*(元のメッセージ|Original Message|Forwarded message|転送されたメッセージ|転送メッセージ).*$/i,
  /^_{5,}\s*$/,
  /^(From|差出人|送信者)[:：]\s.+$/,
  /^-----\s*Original.*$/i,
  /^>.*$/,
];
const SIGNATURE_RES: RegExp[] = [
  /^-- ?$/,
  /^={8,}\s*$/,
  /^[-－ー=＝_＿*＊]{8,}\s*$/,
  /^[ー─━]{6,}\s*$/,
];

/** 引用・署名・空白を剥がし、maxChars で切る */
export function cleanBody(raw: string, maxChars = 1500): string {
  if (!raw) return '';
  const lines = raw.replace(/\r/g, '').split('\n');
  const kept: string[] = [];
  let contentLines = 0;
  for (const line of lines) {
    const t = line.trim();
    if (QUOTE_START_RES.some((re) => re.test(t))) {
      // From: の行は次行が Sent:/Date: のときだけ引用ヘッダ扱い
      if (/^(From|差出人|送信者)[:：]/.test(t)) {
        // 続く行の確認は簡略化: それ以降を切る
        break;
      }
      if (t.startsWith('>')) continue;
      break;
    }
    if (contentLines >= 2 && SIGNATURE_RES.some((re) => re.test(t))) break;
    kept.push(line.replace(/\s+$/g, ''));
    if (t) contentLines += 1;
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

const PART_PRIORITY = ['TEXT', '1', '1.1', '1.1.1', '2', '1.2', '1.1.2', '1.2.1'];

/** mail_fti.dat から本文テキストを取る(無ければ空)。引用/署名は除去済み */
export function getMailBodies(accountEmail: string, mailIds: number[], maxChars = 1500): Map<number, string> {
  const out = new Map<number, string>();
  if (mailIds.length === 0) return out;
  const acc = findAccount(accountEmail);
  const db = openReadonlyOrNull(acc.accountUid, acc.mailSubdir, 'mail_fti.dat');
  if (!db) return out;
  try {
    const stmt = db.prepare('SELECT c1partName AS partName, c2content AS content FROM LocalMailsIndex3_content WHERE c0id = ?');
    for (const id of mailIds) {
      let rows: Array<{ partName: string; content: string }>;
      try {
        rows = stmt.all(id) as Array<{ partName: string; content: string }>;
      } catch {
        continue;
      }
      if (rows.length === 0) continue;
      rows.sort((a, b) => {
        const ia = PART_PRIORITY.indexOf(a.partName);
        const ib = PART_PRIORITY.indexOf(b.partName);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
      // テキストとして意味のある最初のパート(短すぎる/HTML断片は飛ばす)
      const pick = rows.find((r) => (r.content ?? '').trim().length >= 20) ?? rows[0];
      out.set(id, cleanBody(pick.content ?? '', maxChars));
    }
  } finally {
    db.close();
  }
  return out;
}

// --- スレッド文脈 ---

export interface ThreadContextMessage {
  id: number;
  date: Date;
  from: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  isSentByMe: boolean;
  body: string;        // cleaned(全文が無ければ preview)
  subject: string;
}

export interface ThreadContext {
  conversationId: string;
  count: number;
  myReplies: number;
  lastFromMe: boolean;
  lastAt: Date | null;
  messages: ThreadContextMessage[];   // 古い順、直近 maxMessages 件
}

export function getThreadContext(
  accountEmail: string,
  conversationId: string,
  opts?: { maxMessages?: number; maxCharsPerMessage?: number },
): ThreadContext {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  const mine = myAddresses();
  const maxMessages = opts?.maxMessages ?? 8;
  const maxChars = opts?.maxCharsPerMessage ?? 1200;
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, folder FROM MailItems
         WHERE conversationId = ? AND (flags & 65536) = 0
         ORDER BY date ASC`,
      )
      .all(conversationId) as Array<{ id: number; subject: string; date: number; preview: string; folder: number }>;
    const addrStmt = db.prepare('SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?');
    const all: ThreadContextMessage[] = rows.map((r) => {
      const addrs = addrStmt.all(r.id) as Array<{ type: number; displayName: string; address: string }>;
      const from = addrs.find((a) => a.type === AddressType.From);
      const fromAddress = (from?.address ?? '').toLowerCase();
      const isSentByMe = folders.sentIds.has(r.folder) || mine.has(fromAddress);
      return {
        id: r.id,
        date: ticksToDate(r.date) ?? new Date(0),
        from: from ? (from.displayName ? `${from.displayName} <${from.address}>` : from.address) : '',
        fromAddress,
        to: addrs.filter((a) => a.type === AddressType.To).map((a) => a.address),
        cc: addrs.filter((a) => a.type === AddressType.Cc).map((a) => a.address),
        isSentByMe,
        body: r.preview ?? '',
        subject: r.subject ?? '',
      };
    });
    // 重複(同じメールが複数フォルダに)を id で潰す
    const seen = new Set<number>();
    const uniq = all.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    const recent = uniq.slice(-maxMessages);
    const bodies = getMailBodies(accountEmail, recent.map((m) => m.id), maxChars);
    for (const m of recent) {
      const b = bodies.get(m.id);
      if (b && b.length > 0) m.body = b;
      else m.body = cleanBody(m.body, maxChars);
    }
    const last = uniq[uniq.length - 1];
    return {
      conversationId,
      count: uniq.length,
      myReplies: uniq.filter((m) => m.isSentByMe).length,
      lastFromMe: last ? last.isSentByMe : false,
      lastAt: last ? last.date : null,
      messages: recent,
    };
  } finally {
    db.close();
  }
}

// --- 文体見本(最近の送信メール) ---

export function getSentExemplars(accountEmail: string, n = 3): string[] {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  if (folders.sentIds.size === 0) return [];
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const rows = db
      .prepare(
        `SELECT id, subject FROM MailItems
         WHERE folder IN (${[...folders.sentIds].join(',')}) AND (flags & 65536) = 0
           AND subject NOT LIKE 'Fw%' AND subject NOT LIKE 'FW%' AND subject NOT LIKE '転送%'
         ORDER BY date DESC LIMIT 40`,
      )
      .all() as Array<{ id: number; subject: string }>;
    const bodies = getMailBodies(accountEmail, rows.map((r) => r.id), 900);
    const picked: string[] = [];
    for (const r of rows) {
      const b = bodies.get(r.id) ?? '';
      // 短すぎる(URLだけ等)/長すぎるものは見本にしない
      if (b.length < 60 || b.length > 900) continue;
      if (/https?:\/\/\S+$/.test(b.trim()) && b.length < 120) continue;
      picked.push(`件名: ${r.subject}\n${b}`);
      if (picked.length >= n) break;
    }
    return picked;
  } finally {
    db.close();
  }
}

// =====================================================================
// v3 相棒: 返信に必要なヘッダ / 返事待ちスレッド / 署名と表示名の推定
// =====================================================================

export interface ReplyHeaders {
  mailId: number;
  messageId: string;
  inReplyTo: string;
  references: string;
  subject: string;
  date: Date;
  from: MailAddress | null;
  replyTo: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  body: string;           // 引用用(クリーン済み)
}

/** 返信ヘッダと引用本文。SMTP 送信時にスレッドを壊さないために使う */
export function getReplyHeaders(accountEmail: string, mailId: number): ReplyHeaders | null {
  const acc = findAccount(accountEmail);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const row = db
      .prepare('SELECT id, subject, date, messageId, inReplyTo, "references" AS refs FROM MailItems WHERE id = ?')
      .get(mailId) as { id: number; subject: string; date: number; messageId: string | null; inReplyTo: string | null; refs: string | null } | undefined;
    if (!row) return null;
    const addrs = db.prepare('SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?').all(mailId) as Array<{ type: number; displayName: string; address: string }>;
    const pick = (t: number): MailAddress[] => addrs.filter((a) => a.type === t && a.address).map((a) => ({ displayName: a.displayName ?? '', address: a.address, type: t as AddressType }));
    const from = pick(AddressType.From)[0] ?? null;
    const replyTo = pick(AddressType.ReplyTo)[0] ?? null;
    const messageId = row.messageId ?? '';
    // References = 元の References + 元の Message-ID
    const prevRefs = (row.refs ?? '').trim();
    const references = [prevRefs, messageId].filter(Boolean).join(' ').trim();
    const bodies = getMailBodies(accountEmail, [mailId], 4000);
    return {
      mailId,
      messageId,
      inReplyTo: messageId,
      references,
      subject: row.subject ?? '',
      date: ticksToDate(row.date) ?? new Date(0),
      from,
      replyTo,
      to: pick(AddressType.To),
      cc: pick(AddressType.Cc),
      body: bodies.get(mailId) ?? '',
    };
  } finally {
    db.close();
  }
}

export interface WaitingThread {
  conversationId: string;
  mailId: number;        // 先生の最後の送信
  subject: string;
  sentAt: Date;
  to: MailAddress[];
  cc: MailAddress[];
  body: string;          // 先生が書いた本文(クリーン済み)
  daysWaiting: number;
  threadCount: number;
}

/**
 * 「先生が最後に送って、それきり返事が無い」スレッド。
 * 送信済みフォルダにある最新メッセージが minDays 以上前のもの。
 */
export function getWaitingThreads(accountEmail: string, opts: { minDays: number; maxDays?: number; limit?: number }): WaitingThread[] {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  if (folders.sentIds.size === 0) return [];
  const mine = myAddresses();
  const now = new Date();
  const maxDays = opts.maxDays ?? 45;
  const limit = opts.limit ?? 40;
  const since = new Date(now.getTime() - maxDays * 86_400_000);
  const until = new Date(now.getTime() - Math.max(1, opts.minDays) * 86_400_000);
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const sentList = [...folders.sentIds].join(',');
    const rows = db
      .prepare(
        `WITH conv AS (
           SELECT conversationId, MAX(date) AS lastDate, COUNT(*) AS n
           FROM MailItems
           WHERE (flags & 65536) = 0 AND conversationId IS NOT NULL AND conversationId != '' AND date >= ?
           GROUP BY conversationId
         )
         SELECT m.id, m.conversationId, m.subject, m.date, c.n
         FROM MailItems m JOIN conv c ON c.conversationId = m.conversationId AND c.lastDate = m.date
         WHERE m.folder IN (${sentList}) AND m.date <= ? AND (m.flags & 65536) = 0
         ORDER BY m.date DESC
         LIMIT ?`,
      )
      .all(dateToTicks(since), dateToTicks(until), limit * 2) as Array<{ id: number; conversationId: string; subject: string; date: number; n: number }>;
    const addrStmt = db.prepare('SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?');
    const out: WaitingThread[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.conversationId)) continue;
      seen.add(r.conversationId);
      const addrs = addrStmt.all(r.id) as Array<{ type: number; displayName: string; address: string }>;
      const to = addrs.filter((a) => a.type === AddressType.To && a.address && !mine.has(a.address.toLowerCase())).map((a): MailAddress => ({ displayName: a.displayName ?? '', address: a.address, type: AddressType.To }));
      const cc = addrs.filter((a) => a.type === AddressType.Cc && a.address && !mine.has(a.address.toLowerCase())).map((a): MailAddress => ({ displayName: a.displayName ?? '', address: a.address, type: AddressType.Cc }));
      if (to.length === 0) continue;                                  // 自分宛・宛先なしは除外
      if (to.length + cc.length > 12) continue;                       // 一斉送信は返事待ちにしない
      if (/^\s*(fw|fwd|転送)[:：]/i.test(r.subject ?? '') && to.length > 3) continue;
      const sentAt = ticksToDate(r.date) ?? new Date(0);
      out.push({
        conversationId: r.conversationId,
        mailId: r.id,
        subject: r.subject ?? '',
        sentAt,
        to,
        cc,
        body: '',
        daysWaiting: Math.floor((now.getTime() - sentAt.getTime()) / 86_400_000),
        threadCount: r.n,
      });
      if (out.length >= limit) break;
    }
    const bodies = getMailBodies(accountEmail, out.map((w) => w.mailId), 1200);
    for (const w of out) w.body = bodies.get(w.mailId) ?? '';
    return out;
  } finally {
    db.close();
  }
}

const SIG_BOUNDARY_RE = /^([=＝]{8,}|[-－]{8,}|[_＿]{8,}|[*＊]{8,}|-- ?)\s*$/;

/** 本文(生)から署名ブロックを切り出す(無ければ '') */
export function extractSignature(raw: string): string {
  if (!raw) return '';
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/g, ''));
  // 引用より前だけ見る
  const cut = lines.findIndex((l) => /^>/.test(l.trim()) || /^-{2,}\s*(元のメッセージ|Original Message)/i.test(l.trim()) || /^On .{6,120} wrote:\s*$/i.test(l.trim()));
  const own = cut >= 0 ? lines.slice(0, cut) : lines;
  // 末尾側から境界線を探す
  for (let i = own.length - 1; i >= 0; i -= 1) {
    if (!SIG_BOUNDARY_RE.test(own[i].trim())) continue;
    // 同じ境界線で挟まれた塊(==== ... ====)か、境界線以降の塊
    const after = own.slice(i).join('\n').trim();
    if (after.length >= 30 && after.length <= 700) {
      // 上側にも同じ境界線があればそこから
      for (let j = i - 1; j >= Math.max(0, i - 12); j -= 1) {
        if (own[j].trim() === own[i].trim()) return own.slice(j).join('\n').trim();
      }
      return after;
    }
  }
  return '';
}

/** 最近の送信メールから署名を推定(最頻出) */
export function guessSignature(accountEmail: string): string {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  if (folders.sentIds.size === 0) return '';
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  let ids: number[] = [];
  try {
    ids = (db.prepare(`SELECT id FROM MailItems WHERE folder IN (${[...folders.sentIds].join(',')}) AND (flags & 65536) = 0 ORDER BY date DESC LIMIT 40`).all() as Array<{ id: number }>).map((r) => r.id);
  } finally {
    db.close();
  }
  if (ids.length === 0) return '';
  const fti = openReadonlyOrNull(acc.accountUid, acc.mailSubdir, 'mail_fti.dat');
  if (!fti) return '';
  const counts = new Map<string, { n: number; text: string }>();
  try {
    const stmt = fti.prepare('SELECT c1partName AS partName, c2content AS content FROM LocalMailsIndex3_content WHERE c0id = ?');
    for (const id of ids) {
      let rows: Array<{ partName: string; content: string }> = [];
      try { rows = stmt.all(id) as Array<{ partName: string; content: string }>; } catch { continue; }
      const pick = rows.find((r) => ['TEXT', '1', '1.1'].includes(r.partName)) ?? rows[0];
      const sig = extractSignature(pick?.content ?? '');
      if (!sig) continue;
      const key = sig.replace(/\s+/g, ' ');
      const cur = counts.get(key) ?? { n: 0, text: sig };
      cur.n += 1;
      counts.set(key, cur);
    }
  } finally {
    fti.close();
  }
  let best: { n: number; text: string } | null = null;
  for (const v of counts.values()) if (!best || v.n > best.n) best = v;
  return best && best.n >= 2 ? best.text : '';
}

/** 先生が送信時に使っている表示名(最頻出) */
export function getMyDisplayName(accountEmail: string): string {
  const acc = findAccount(accountEmail);
  const folders = getFolderInfo(accountEmail);
  if (folders.sentIds.size === 0) return '';
  const db = openDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');
  try {
    const row = db
      .prepare(
        `SELECT a.displayName AS name, COUNT(*) AS n FROM MailItems m
         JOIN MailAddresses a ON a.parentId = m.id AND a.type = ${AddressType.From}
         WHERE m.folder IN (${[...folders.sentIds].join(',')}) AND a.displayName IS NOT NULL AND a.displayName != ''
         GROUP BY a.displayName ORDER BY n DESC LIMIT 1`,
      )
      .get() as { name: string } | undefined;
    return (row?.name ?? '').replace(/^"|"$/g, '');
  } finally {
    db.close();
  }
}
