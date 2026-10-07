// === 相棒の状態(アプリと共有する JSON)を MCP 側から読み書きする ===
//
// アプリ(調)が ~/Library/Application Support/shirabe/ に置く nightly-digest.json / outbox.json /
// followups.json / journal/ / butler-rules.json / butler-profile.md を、Claude Code からも扱えるようにする。
// アプリ側は fs.watch でこれらの変更を拾って画面を更新し、outbox に載ったものを送る。
// ここで AI は呼ばない(呼び出し元の Claude が頭脳)。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const USER_DATA = process.env.SHIRABE_USER_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'shirabe');
export const PATHS = {
  digest: path.join(USER_DATA, 'nightly-digest.json'),
  outbox: path.join(USER_DATA, 'outbox.json'),
  followUps: path.join(USER_DATA, 'followups.json'),
  journalDir: path.join(USER_DATA, 'journal'),
  rules: path.join(USER_DATA, 'butler-rules.json'),
  profile: path.join(USER_DATA, 'butler-profile.md'),
  settings: path.join(USER_DATA, 'settings.json'),
  runRequest: path.join(USER_DATA, 'run-request.json'),
};

// ---- 型(アプリ側 monitor/src/types/index.ts と同じ形。使う分だけ) ----
export type ButlerPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type ButlerCaseStatus = 'open' | 'done' | 'later' | 'dismissed' | 'scheduled' | 'sent';
export interface CaseDecision { question: string; options: string[]; answer?: string; answeredAt?: string }
export interface ButlerCase {
  id: string;
  accountEmail: string;
  conversationId?: string;
  mailId: number;
  subject: string;
  from: string;
  fromAddress: string;
  fromName: string;
  receivedAt: string;
  senderTier: string;
  category: 'reply' | 'action' | 'fyi' | 'noise' | 'spam' | 'unknown';
  priority: ButlerPriority;
  ask: string;
  summary: string;
  deadline: string | null;
  suggestedAction: string;
  reason: string;
  needsDraft: boolean;
  draftHint?: string;
  draft?: string;
  draftStatus?: 'prepared' | 'skipped' | 'failed';
  draftEdited?: boolean;
  status: ButlerCaseStatus;
  statusChangedAt?: string;
  decision?: CaseDecision | null;
  replyKind?: string;
  autoSendSafe?: boolean;
  replyScope?: 'sender' | 'all';
  outboxId?: string;
  sentAt?: string;
  runAt: string;
}
export interface ButlerGroup { id: string; kind: string; label: string; items: Array<{ mailId: number; subject: string; from: string }>; status: string; accountEmail: string }
export interface NightlyDigest {
  runAt: string;
  brief?: string;
  cases?: ButlerCase[];
  groups?: ButlerGroup[];
  errors: string[];
  stats?: Record<string, number>;
  mode?: string;
  sources?: string[];
}
export type OutboxStatus = 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'failed';
export interface OutboxItem {
  id: string;
  kind: 'reply' | 'nudge' | 'new';
  caseId?: string;
  followUpId?: string;
  accountEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  inReplyToMailId?: number;
  label: string;
  sendAt: string;
  status: OutboxStatus;
  error?: string;
  createdAt: string;
  sentAt?: string;
  auto?: boolean;
  via?: 'mcp' | 'app';
}
export interface OutboxStore { version: 1; items: OutboxItem[] }
export interface FollowUp {
  id: string;
  accountEmail: string;
  conversationId: string;
  mailId: number;
  subject: string;
  to: string;
  toAddress: string;
  sentAt: string;
  daysWaiting: number;
  ask: string;
  summary: string;
  nudgeDraft?: string;
  status: 'open' | 'nudged' | 'snoozed' | 'closed';
  snoozeUntil?: string;
  outboxId?: string;
  updatedAt: string;
}
export interface JournalEntry { at: string; kind: string; text: string; caseId?: string; mailId?: number; accountEmail?: string }

// ---- JSON I/O(アトミック書き込み) ----
export function readJson<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

export const loadDigest = (): NightlyDigest | null => readJson<NightlyDigest>(PATHS.digest);
export const saveDigest = (d: NightlyDigest): void => writeJson(PATHS.digest, d);
export const loadOutbox = (): OutboxStore => {
  const r = readJson<OutboxStore>(PATHS.outbox);
  return r && Array.isArray(r.items) ? { version: 1, items: r.items } : { version: 1, items: [] };
};
export const saveOutbox = (s: OutboxStore): void => writeJson(PATHS.outbox, s);
export const loadFollowUps = (): FollowUp[] => readJson<FollowUp[]>(PATHS.followUps) ?? [];
export const saveFollowUps = (l: FollowUp[]): void => writeJson(PATHS.followUps, l);

export function appendJournal(entry: Omit<JournalEntry, 'at'>): JournalEntry {
  const full: JournalEntry = { at: new Date().toISOString(), ...entry };
  try {
    fs.mkdirSync(PATHS.journalDir, { recursive: true });
    const d = new Date(full.at);
    const f = path.join(PATHS.journalDir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    fs.appendFileSync(f, `${JSON.stringify(full)}\n`, 'utf-8');
  } catch { /* 日誌で止めない */ }
  return full;
}

export function readJournal(limit = 50, days = 3): JournalEntry[] {
  const out: JournalEntry[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now - i * 86_400_000);
    const f = path.join(PATHS.journalDir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as JournalEntry); } catch { /* skip */ }
    }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}

/** アプリに「今すぐ確認」を頼む(アプリが run-request.json を監視している) */
export function requestRun(reason: string): void {
  writeJson(PATHS.runRequest, { at: new Date().toISOString(), reason });
}

/** 設定から「送れるアカウント」を見る(パスワードは暗号化されていて読まないが、設定済みかは分かる) */
export function canSend(accountEmail: string): boolean {
  const s = readJson<{ smtpConfigs?: Array<{ accountEmail: string; credentials?: { host?: string; password?: string } | null }> }>(PATHS.settings);
  const c = (s?.smtpConfigs ?? []).find((x) => x.accountEmail === accountEmail);
  return !!(c?.credentials?.host && c.credentials.password);
}

export function sendDelayMinutes(): number {
  const s = readJson<{ partnerSendDelayMinutes?: number }>(PATHS.settings);
  const v = Number(s?.partnerSendDelayMinutes);
  return Number.isFinite(v) && v >= 0 ? v : 5;
}

export function signatureFor(accountEmail: string): string {
  const s = readJson<{ smtpConfigs?: Array<{ accountEmail: string; signature?: string }> }>(PATHS.settings);
  return (s?.smtpConfigs ?? []).find((x) => x.accountEmail === accountEmail)?.signature ?? '';
}

// ---- 純関数 ----
export function replySubject(subject: string): string {
  const s = (subject || '').trim();
  if (/^(re|回答)(\[\d+\])?\s*[:：]/i.test(s)) return s;
  return `Re: ${s}`;
}

export function enqueueOutbox(store: OutboxStore, input: Omit<OutboxItem, 'id' | 'status' | 'createdAt' | 'sendAt'>, delayMinutes: number, now = new Date()): { store: OutboxStore; item: OutboxItem } {
  const item: OutboxItem = {
    ...input,
    id: `ob-${randomUUID()}`,
    status: 'scheduled',
    createdAt: now.toISOString(),
    sendAt: new Date(now.getTime() + Math.max(0, delayMinutes) * 60_000).toISOString(),
  };
  return { store: { version: 1, items: [...store.items, item] }, item };
}

export function cancelOutbox(store: OutboxStore, id: string): { store: OutboxStore; item: OutboxItem | null; error?: string } {
  const item = store.items.find((i) => i.id === id);
  if (!item) return { store, item: null, error: '送信予定が見つかりません' };
  if (item.status !== 'scheduled' && item.status !== 'failed') return { store, item, error: item.status === 'sent' ? '既に送信済みです' : '送信中のため取り消せません' };
  const next: OutboxItem = { ...item, status: 'cancelled' };
  return { store: { version: 1, items: store.items.map((i) => (i.id === id ? next : i)) }, item: next };
}

export interface TodaySummary {
  runAt: string | null;
  mode: string;
  brief: string;
  counts: { decisions: number; sendable: number; actions: number; fyi: number; outbox: number; followUps: number; later: number };
  decisions: Array<Pick<ButlerCase, 'id' | 'fromName' | 'subject' | 'ask' | 'priority' | 'deadline'> & { question: string; options: string[] }>;
  sendable: Array<Pick<ButlerCase, 'id' | 'fromName' | 'subject' | 'ask' | 'priority' | 'deadline' | 'replyKind'> & { hasDraft: boolean }>;
  actions: Array<Pick<ButlerCase, 'id' | 'fromName' | 'subject' | 'ask' | 'priority' | 'deadline' | 'suggestedAction'>>;
  fyi: Array<Pick<ButlerCase, 'id' | 'fromName' | 'subject' | 'summary'>>;
  outbox: Array<Pick<OutboxItem, 'id' | 'label' | 'sendAt' | 'status' | 'error'>>;
  followUps: Array<Pick<FollowUp, 'id' | 'to' | 'subject' | 'daysWaiting' | 'ask' | 'status'> & { hasNudgeDraft: boolean }>;
  errors: string[];
}

const PRIO: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };
const byPriority = (a: ButlerCase, b: ButlerCase) => (PRIO[a.priority] ?? 9) - (PRIO[b.priority] ?? 9) || (a.deadline ?? '9').localeCompare(b.deadline ?? '9');

export function summarizeToday(digest: NightlyDigest | null, outbox: OutboxStore, followUps: FollowUp[], now = new Date()): TodaySummary {
  const cases = (digest?.cases ?? []).slice().sort(byPriority);
  const open = cases.filter((c) => c.status === 'open');
  const decisions = open.filter((c) => c.decision && !c.decision.answer);
  const decided = new Set(decisions.map((c) => c.id));
  const sendable = open.filter((c) => !decided.has(c.id) && c.category === 'reply');
  const actions = open.filter((c) => !decided.has(c.id) && c.category === 'action');
  const fyi = open.filter((c) => c.category === 'fyi');
  const later = cases.filter((c) => c.status === 'later');
  const ob = outbox.items.filter((i) => i.status === 'scheduled' || i.status === 'sending' || i.status === 'failed');
  const fu = followUps.filter((f) => f.status === 'open' || f.status === 'nudged' || (f.status === 'snoozed' && (!f.snoozeUntil || f.snoozeUntil <= now.toISOString())));
  return {
    runAt: digest?.runAt ?? null,
    mode: digest?.mode ?? 'assist',
    brief: digest?.brief ?? '',
    counts: { decisions: decisions.length, sendable: sendable.length, actions: actions.length, fyi: fyi.length, outbox: ob.length, followUps: fu.length, later: later.length },
    decisions: decisions.map((c) => ({ id: c.id, fromName: c.fromName, subject: c.subject, ask: c.ask, priority: c.priority, deadline: c.deadline, question: c.decision?.question ?? '', options: c.decision?.options ?? [] })),
    sendable: sendable.map((c) => ({ id: c.id, fromName: c.fromName, subject: c.subject, ask: c.ask, priority: c.priority, deadline: c.deadline, replyKind: c.replyKind, hasDraft: !!c.draft })),
    actions: actions.map((c) => ({ id: c.id, fromName: c.fromName, subject: c.subject, ask: c.ask, priority: c.priority, deadline: c.deadline, suggestedAction: c.suggestedAction })),
    fyi: fyi.map((c) => ({ id: c.id, fromName: c.fromName, subject: c.subject, summary: c.summary })),
    outbox: ob.map((i) => ({ id: i.id, label: i.label, sendAt: i.sendAt, status: i.status, error: i.error })),
    followUps: fu.map((f) => ({ id: f.id, to: f.to, subject: f.subject, daysWaiting: f.daysWaiting, ask: f.ask, status: f.status, hasNudgeDraft: !!f.nudgeDraft })),
    errors: digest?.errors ?? [],
  };
}
