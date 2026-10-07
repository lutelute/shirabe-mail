// === Night Butler pipeline v2 (案件ベースの秘書モデル) ===
//
// v1 は「1通ずつ reply/todo に分けてタグを付ける」だけで、APIキーが無いと全通 info になり、
// スパムは1通ずつ承認を求めた(実績: 9,672通→全部 info / 承認待ち 1,101件)。
//
// v2 は秘書の仕事の流れをそのまま実装する:
//   1. 集める   … 受信箱の新着(未読)を、前回実行以降(初回は N 日)だけ取る
//   2. ふるう   … サーバーの [SPAM] マーク・典型パターンで迷惑メール/一斉配信を AI 前に除外
//   3. 束ねる   … スレッド(会話)単位の「案件」にし、本文全文・経緯・相手との付き合いを添える
//   4. 判断する … Claude(CLI経由・APIキー不要)に「先生は何をすべきか/期限/優先度」を判定させる
//   5. 用意する … 返信が要る案件は先生の文体で下書きを作る(送信はしない)
//   6. 報告する … 朝の申し送り + 案件カード + 一括承認グループ(削除は必ず承認制)
//
// 安全ライン(v1 から不変): 可逆な処理(タグ・隔離・下書き)は自動、不可逆(削除・送信)は承認制。

import type {
  AppSettings,
  MailNote,
  NightlyDigest,
  ButlerEntry,
  ButlerCase,
  ButlerGroup,
  ButlerGroupItem,
  ButlerStats,
  ButlerRules,
  SenderStats,
  ButlerPriority,
  ButlerCaseCategory,
  FollowUp,
  JournalEntry,
  PartnerMode,
  CaseEvent,
  CalendarEvent,
} from '../../src/types/index';
import type { CandidateMail, ThreadContext, WaitingThread } from './mail-intel';
import type { JudgmentContext, CaseInput, CaseJudgment, DraftParams, BriefInput, FollowUpInput, FollowUpJudgment, EventOnlyInput } from './butler-brain';
import { tierFor, looksLikeBulk, looksLikeSpam, greetingFor } from './butler-brain';
import { domainOf, normalizeAddress } from './butler-rules';

// ---------- 依存(main.ts が実装を注入。テストでは差し替え) ----------

export interface ButlerProgress {
  stage: 'collect' | 'classify' | 'draft' | 'brief' | 'done' | 'error';
  message: string;
  done?: number;
  total?: number;
}

export interface PipelineDeps {
  loadSettings: () => AppSettings;
  loadRules: () => ButlerRules;
  buildContext: (rules: ButlerRules) => JudgmentContext;
  getCandidates: (accountEmail: string, q: { since: Date; limit: number; excludeIds: Set<number>; unreadOnly?: boolean }) => CandidateMail[];
  getSenderStats: (accountEmail: string) => Map<string, SenderStats>;
  getThread: (accountEmail: string, conversationId: string) => ThreadContext;
  getBodies: (accountEmail: string, ids: number[]) => Map<number, string>;
  getExemplars: (accountEmail: string) => string[];
  classify: (
    ctx: JudgmentContext,
    inputs: CaseInput[],
    model: string,
    onProgress?: (done: number, total: number) => void,
  ) => Promise<{ judgments: Map<string, CaseJudgment>; aiCalls: number; costUsd: number; errors: string[] }>;
  draft: (ctx: JudgmentContext, params: DraftParams, model: string) => Promise<{ ok: boolean; draft: string; error?: string; costUsd: number }>;
  brief: (input: BriefInput, model: string) => Promise<{ text: string; costUsd: number; ai: boolean }>;
  moveToQuarantine: (mailId: number, accountEmail: string, folderName: string) => Promise<{ success: boolean; error?: string }>;
  hasImapCredentials: (accountEmail: string) => boolean;
  getNote: (noteId: string) => MailNote | null;
  saveNote: (note: MailNote) => void;
  butlerStatePath: string;
  digestPath: string;
  readJson: <T>(filePath: string) => T | null;
  writeJson: (filePath: string, data: unknown) => void;
  onProgress?: (p: ButlerProgress) => void;
  log?: (msg: string) => void;
  dryRun?: boolean;      // true: ノート/隔離/状態/ダイジェストを書かない(検証用)
  now?: () => Date;
  // --- v3 相棒(省略可。無ければその段階を飛ばす) ---
  canTidy?: (accountEmail: string) => boolean;
  tidy?: (accountEmail: string, mailIds: number[]) => Promise<{ done: number[]; archiveFolder: string | null; error?: string }>;
  canSend?: (accountEmail: string) => boolean;
  enqueueSend?: (c: ButlerCase, body: string) => Promise<string | null>;   // 送信予定に載せて outbox id を返す
  getWaitingThreads?: (accountEmail: string, opts: { minDays: number; maxDays: number; limit: number }) => WaitingThread[];
  judgeFollowUps?: (ctx: JudgmentContext, inputs: FollowUpInput[], model: string) => Promise<{ judgments: Map<string, FollowUpJudgment>; aiCalls: number; costUsd: number; errors: string[] }>;
  followUpsPath?: string;
  journal?: (entry: Omit<JournalEntry, 'at'>) => void;
  getCalendarEvents?: (accountEmail: string, daysForward: number) => CalendarEvent[];
  extractEvents?: (ctx: JudgmentContext, inputs: EventOnlyInput[], model: string) => Promise<{ events: Map<string, CaseEvent | null>; aiCalls: number; costUsd: number; errors: string[] }>;
}

// ---------- カレンダー照合(純関数) ----------

function normTitle(s: string): string {
  return (s || '').toLowerCase().replace(/[\s　【】\[\]()（）:：・,，.。「」『』-]/g, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function titleSimilar(a: string, b: string): boolean {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const bx = bigrams(x);
  const by = bigrams(y);
  let inter = 0;
  for (const g of bx) if (by.has(g)) inter += 1;
  const union = bx.size + by.size - inter;
  return union > 0 && inter / union >= 0.3;
}

function eventStartMs(ev: CaseEvent): number {
  const t = new Date(ev.allDay ? `${ev.start}T00:00:00` : `${ev.start}:00`).getTime();
  return isNaN(t) ? NaN : t;
}

function sharesAnyBigram(a: string, b: string): boolean {
  const x = bigrams(normTitle(a));
  const y = bigrams(normTitle(b));
  for (const g of x) if (y.has(g)) return true;
  return false;
}

/**
 * メールの予定がカレンダーにあるか。
 *  - 開始時刻が 15 分以内で一致し、件名に共通する語が少しでもあれば登録済み(言い方が違う同じ予定)
 *  - ±90 分(終日は同日)で件名が似ていれば登録済み
 */
export function matchCalendar(ev: CaseEvent, events: CalendarEvent[]): { status: 'registered' | 'missing'; match?: string } {
  const t = eventStartMs(ev);
  if (isNaN(t)) return { status: 'missing' };
  const day = ev.start.slice(0, 10);
  let weak: string | undefined;
  for (const e of events) {
    const s = e.start instanceof Date ? e.start : new Date(e.start);
    if (isNaN(s.getTime())) continue;
    const sameDay = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}` === day;
    const diff = Math.abs(s.getTime() - t);
    if (!ev.allDay && !e.isAllDay && diff <= 15 * 60_000 && sharesAnyBigram(ev.title, e.summary)) return { status: 'registered', match: e.summary };
    const close = ev.allDay ? sameDay : diff <= 90 * 60_000 || (sameDay && e.isAllDay);
    if (!close) continue;
    if (titleSimilar(ev.title, e.summary)) return { status: 'registered', match: e.summary };
    if (!ev.allDay && !e.isAllDay && diff <= 15 * 60_000 && !weak) weak = e.summary;
  }
  // 時刻だけ一致して件名が全く違う予定は「未登録」のまま(別件の可能性)
  void weak;
  return { status: 'missing' };
}

// ---------- 状態 ----------

interface ButlerState {
  version?: number;
  processed: Record<string, number[]>;   // accountEmail → 処理済み mail id
  lastRunAt?: string;
}

const MAX_PROCESSED_PER_ACCOUNT = 5000;
const CARRY_OVER_DAYS = 14;
const MAX_AUTO_QUARANTINE_PER_RUN = 30;
const MAX_NOISE_ITEMS = 200;

function loadState(deps: PipelineDeps): ButlerState {
  const raw = deps.readJson<ButlerState>(deps.butlerStatePath);
  if (raw && typeof raw === 'object' && raw.processed) return raw;
  return { version: 2, processed: {} };
}

function saveState(deps: PipelineDeps, state: ButlerState): void {
  for (const k of Object.keys(state.processed)) {
    const arr = state.processed[k];
    if (arr.length > MAX_PROCESSED_PER_ACCOUNT) {
      // id は単調増加なので大きい方(新しい方)を残す
      arr.sort((a, b) => a - b);
      state.processed[k] = arr.slice(arr.length - MAX_PROCESSED_PER_ACCOUNT);
    }
  }
  state.version = 2;
  deps.writeJson(deps.butlerStatePath, state);
}

// ---------- 小道具 ----------

export function noteIdFor(mail: { id: number; conversationId?: string }): string {
  return mail.conversationId ? `conv-${mail.conversationId}` : `mail-${mail.id}`;
}

export function caseIdFor(accountEmail: string, mail: { id: number; conversationId?: string }): string {
  return `${accountEmail}::${noteIdFor(mail)}`;
}

function fromText(m: CandidateMail): string {
  const a = m.from;
  if (!a) return '不明';
  return a.displayName ? `${a.displayName} <${a.address}>` : a.address;
}

function isoDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString();
}

function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export function addressedToMe(m: CandidateMail, myAddresses: string[]): ButlerCase['addressedToMe'] {
  const mine = new Set(myAddresses.map((a) => a.toLowerCase()));
  if (m.to.some((a) => mine.has((a.address ?? '').toLowerCase()))) return 'to';
  if ((m.cc ?? []).some((a) => mine.has((a.address ?? '').toLowerCase()))) return 'cc';
  const all = [...m.to, ...(m.cc ?? [])].map((a) => (a.address ?? '').toLowerCase());
  if (all.length === 0) return 'unknown';
  if (all.some((a) => a.includes('@ml.') || a.startsWith('ml-') || a.includes('-ml@') || a.includes('list')) || /^\s*\[[^\]]+\]/.test(m.subject)) return 'list';
  return 'unknown';
}

const PRIORITY_RANK: Record<ButlerPriority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

function daysUntil(deadline: string | null, today: string): number | null {
  if (!deadline) return null;
  const a = new Date(`${deadline}T00:00:00`);
  const b = new Date(`${today}T00:00:00`);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/** 期限が近ければ優先度を引き上げる(reply/action のみ) */
export function bumpPriorityByDeadline(j: { category: ButlerCaseCategory; priority: ButlerPriority; deadline: string | null }, today: string): ButlerPriority {
  if (j.category !== 'reply' && j.category !== 'action') return j.priority;
  const d = daysUntil(j.deadline, today);
  if (d === null) return j.priority;
  if (d <= 2) return 'P1';
  if (d <= 7 && PRIORITY_RANK[j.priority] > PRIORITY_RANK.P2) return 'P2';
  return j.priority;
}

export function tagsFor(category: ButlerCaseCategory, priority: ButlerPriority): string[] {
  const tags: string[] = [];
  if (category === 'reply') tags.push('reply');
  else if (category === 'action') tags.push('action');
  else if (category === 'fyi') tags.push('info');
  else if (category === 'noise' || category === 'spam') tags.push('unnecessary');
  if (priority === 'P1' && (category === 'reply' || category === 'action')) tags.push('urgent');
  return tags;
}

export function sortCases(cases: ButlerCase[]): ButlerCase[] {
  return [...cases].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a.deadline && b.deadline && a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    if (a.deadline && !b.deadline) return -1;
    if (!a.deadline && b.deadline) return 1;
    return (b.receivedAt || '').localeCompare(a.receivedAt || '');
  });
}

/** 前回の未完了案件を引き継ぐ(新しい案件が同 id なら新しい方が勝つ) */
export function mergeCarryOver(prev: ButlerCase[] | undefined, fresh: ButlerCase[], now: Date): ButlerCase[] {
  const byId = new Map<string, ButlerCase>();
  const cutoff = now.getTime() - CARRY_OVER_DAYS * 86_400_000;
  for (const c of prev ?? []) {
    if (c.status !== 'open' && c.status !== 'later' && c.status !== 'scheduled') continue;
    const t = new Date(c.runAt || c.createdAt).getTime();
    if (isNaN(t) || t < cutoff) continue;
    byId.set(c.id, c);
  }
  for (const c of fresh) {
    const old = byId.get(c.id);
    // 「後で」にしていた案件に新着があれば再度 open にする(相手が動いた)。送信予定中なら予定を保つ
    if (old && old.status === 'scheduled' && c.status === 'open') {
      byId.set(c.id, { ...c, status: 'scheduled', outboxId: old.outboxId, createdAt: old.createdAt });
    } else {
      byId.set(c.id, old ? { ...c, status: c.status === 'open' ? 'open' : c.status, createdAt: old.createdAt } : c);
    }
  }
  return [...byId.values()];
}

/** 返事待ち(FollowUp)の更新: 新しい判定を取り込み、返事が来たものを閉じる(純関数) */
export function reconcileFollowUps(
  prev: FollowUp[],
  waiting: Array<WaitingThread & { accountEmail: string }>,
  judgments: Map<string, FollowUpJudgment>,
  accounts: string[],
  now: Date,
): { list: FollowUp[]; opened: FollowUp[]; closed: FollowUp[] } {
  const nowIso = now.toISOString();
  const byId = new Map(prev.map((f) => [f.id, f] as const));
  const waitingIds = new Set<string>();
  const opened: FollowUp[] = [];
  const closed: FollowUp[] = [];
  for (const w of waiting) {
    const id = `${w.accountEmail}::conv-${w.conversationId}`;
    waitingIds.add(id);
    const existing = byId.get(id);
    if (existing) {
      // まだ返事が無い: 日数を更新。snooze が明けていれば open に戻す
      const next: FollowUp = { ...existing, daysWaiting: w.daysWaiting, updatedAt: nowIso };
      if (next.status === 'snoozed' && next.snoozeUntil && next.snoozeUntil <= nowIso) next.status = 'open';
      byId.set(id, next);
      continue;
    }
    const j = judgments.get(id);
    if (!j) continue;   // まだ判定していない(次回)
    const to = w.to[0];
    const f: FollowUp = {
      id,
      accountEmail: w.accountEmail,
      conversationId: w.conversationId,
      mailId: w.mailId,
      subject: w.subject,
      to: to ? (to.displayName ? `${to.displayName} <${to.address}>` : to.address) : '',
      toAddress: (to?.address ?? '').toLowerCase(),
      sentAt: w.sentAt.toISOString(),
      daysWaiting: w.daysWaiting,
      ask: j.ask,
      summary: j.summary,
      status: j.needsReply ? 'open' : 'closed',
      aiSource: 'ai',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    byId.set(id, f);
    if (j.needsReply) opened.push(f);
  }
  // 返事が来た(= もう「最後が先生」ではない)ものを閉じる
  for (const f of byId.values()) {
    if (!accounts.includes(f.accountEmail)) continue;
    if ((f.status === 'open' || f.status === 'nudged' || f.status === 'snoozed') && !waitingIds.has(f.id)) {
      byId.set(f.id, { ...f, status: 'closed', updatedAt: nowIso });
      closed.push(f);
    }
  }
  // 閉じたものは 30 日で消す
  const cutoff = now.getTime() - 30 * 86_400_000;
  const list = [...byId.values()].filter((f) => f.status !== 'closed' || new Date(f.updatedAt).getTime() >= cutoff);
  return { list, opened, closed };
}

const TRUSTED_TIERS = new Set(['vip', 'internal', 'known']);

/** 相棒が自分で送ってよい案件か(delegate 時) */
export function canAutoSend(c: ButlerCase, mode: PartnerMode): boolean {
  if (mode !== 'delegate') return false;
  if (c.status !== 'open' || c.category !== 'reply') return false;
  if (!c.autoSendSafe || !c.draft || c.draftStatus !== 'prepared') return false;
  if (c.decision && !c.decision.answer) return false;
  if (!TRUSTED_TIERS.has(c.senderTier)) return false;
  if (c.replyKind !== 'ack' && c.replyKind !== 'thanks' && c.replyKind !== 'schedule') return false;
  return true;
}

// ---------- ノート(タグ)書き込み ----------

function upsertNote(deps: PipelineDeps, c: ButlerCase, runStamp: string): void {
  const id = c.noteId ?? noteIdFor({ id: c.mailId, conversationId: c.conversationId });
  const now = new Date().toISOString();
  const existing = deps.getNote(id);
  const marker = `<!-- butler:${c.mailId} -->`;
  const memo = [
    marker,
    `## 🕯 秘書メモ (${runStamp})`,
    `- 要件: ${c.ask || '(なし)'}`,
    `- 優先度: ${c.priority}${c.deadline ? ` / 期限: ${c.deadline}` : ''}`,
    `- 要約: ${c.summary}`,
    `- 根拠: ${c.reason}`,
  ].join('\n');
  const draftBlock = c.draft ? `\n\n## ✍️ 返信下書き (${runStamp}・未送信)\n\n${c.draft}` : '';

  const mergedTags = Array.from(new Set([...(existing?.tags ?? []).filter((t) => !['reply', 'action', 'info', 'urgent', 'unnecessary'].includes(t)), ...c.tags]));
  const alreadyNoted = !!existing?.content?.includes(marker);
  const content = existing?.content
    ? alreadyNoted ? existing.content : `${existing.content}\n\n${memo}${draftBlock}`
    : `${memo}${draftBlock}`;

  const note: MailNote = existing
    ? {
        ...existing,
        tags: mergedTags,
        content,
        history: [...(existing.history ?? []), { timestamp: now, type: 'updated', content: `夜間執事: ${c.category}/${c.priority} — ${c.reason}` }],
        updatedAt: now,
      }
    : {
        id,
        mailId: c.mailId,
        accountEmail: c.accountEmail,
        subject: c.subject,
        content,
        todos: [],
        tags: c.tags,
        history: [{ timestamp: now, type: 'created', content: `夜間執事: ${c.category}/${c.priority} — ${c.reason}` }],
        createdAt: now,
        updatedAt: now,
      };
  deps.saveNote(note);
}

// ---------- メイン ----------

function emptyDigest(now: Date): NightlyDigest {
  return {
    version: 2,
    runAt: now.toISOString(),
    processedCount: 0,
    autoDone: [],
    awaitingApproval: [],
    errors: [],
    costUsd: 0,
    cases: [],
    groups: [],
    brief: '',
  };
}

interface RawCase {
  key: string;             // case id
  accountEmail: string;
  mails: CandidateMail[];  // 新着(新しい順)
  latest: CandidateMail;
}

export async function runButlerPipeline(deps: PipelineDeps, opts?: { force?: boolean }): Promise<NightlyDigest> {
  const now = deps.now ? deps.now() : new Date();
  const log = deps.log ?? (() => undefined);
  const progress = (p: ButlerProgress) => deps.onProgress?.(p);
  const settings = deps.loadSettings();
  const startedAt = Date.now();

  if (!settings.butlerEnabled && !opts?.force) return emptyDigest(now);

  const digest = emptyDigest(now);
  const prevDigest = deps.readJson<NightlyDigest>(deps.digestPath);
  const rules = deps.loadRules();
  const ctx = deps.buildContext(rules);
  const state = loadState(deps);
  const runStamp = `${now.getMonth() + 1}/${now.getDate()}`;

  const classifyModel = settings.butlerModel || 'sonnet';
  const draftModel = settings.butlerDraftModel || classifyModel;
  const mode: PartnerMode = settings.partnerMode ?? 'assist';
  const autoTidy = mode !== 'observe' && settings.partnerAutoTidy !== false;
  const journal = (entry: Omit<JournalEntry, 'at'>) => { if (!deps.dryRun) deps.journal?.(entry); };
  const maxCases = Math.max(1, settings.butlerMaxCasesPerRun ?? 40);
  const maxDrafts = Math.max(0, settings.butlerMaxDraftsPerRun ?? 5);
  const maxPerAccount = Math.max(1, settings.butlerMaxPerAccount ?? 100);
  const quarantineFolder = settings.butlerQuarantineFolder || '隔離';

  // 対象アカウント
  const baseAccounts = settings.selectedAccounts?.length ? settings.selectedAccounts : [];
  const accounts = settings.butlerAccounts?.length ? baseAccounts.filter((a) => settings.butlerAccounts.includes(a)) : baseAccounts;
  if (accounts.length === 0) {
    digest.errors.push('対象アカウントが選択されていません(設定 → アカウント)。');
    return digest;
  }

  // 取得ウィンドウ: 初回は butlerInitialDays、2回目以降は前回実行の2日前から(取りこぼし防止)。
  // 前回が 7 日以上前(長く止めていた / v1 の状態) なら初回扱い(未読だけ・遡り日数で区切る)にして、
  // 既読の古いメールを何百通も掘り返さない。
  const since = new Date(now);
  const lastRun = state.lastRunAt ? new Date(state.lastRunAt) : null;
  const stale = !lastRun || isNaN(lastRun.getTime()) || state.version !== 2 || now.getTime() - lastRun.getTime() > 7 * 86_400_000;
  if (!stale && lastRun) {
    since.setTime(lastRun.getTime() - 2 * 86_400_000);
  } else {
    since.setDate(since.getDate() - Math.max(1, settings.butlerInitialDays ?? 14));
  }

  const stats: ButlerStats = { candidates: 0, cases: 0, p1: 0, p2: 0, p3: 0, noise: 0, spam: 0, drafts: 0, aiCalls: 0, durationMs: 0, tidied: 0, scheduled: 0, followUps: 0, decisions: 0 };
  const freshCases: ButlerCase[] = [];
  const groups: ButlerGroup[] = [];
  const processedThisRun: Record<string, number[]> = {};
  const deferredIds: Record<string, number[]> = {};   // AI上限超過で次回に回す
  const aiInputs: CaseInput[] = [];
  const rawByKey = new Map<string, RawCase>();
  const threadCache = new Map<string, ThreadContext>();

  progress({ stage: 'collect', message: '新着メールを集めています…' });

  for (const accountEmail of accounts) {
    let candidates: CandidateMail[] = [];
    try {
      candidates = deps.getCandidates(accountEmail, {
        since,
        limit: maxPerAccount,
        excludeIds: new Set(state.processed[accountEmail] ?? []),
        // 初回(と長い停止明け)だけ未読に絞る。2回目以降は先生が eM Client で開いた新着も案件にする
        unreadOnly: stale,
      });
    } catch (err) {
      digest.errors.push(`${accountEmail}: 新着取得に失敗 — ${(err as Error).message}`);
      continue;
    }
    if (candidates.length === 0) continue;
    stats.candidates += candidates.length;
    processedThisRun[accountEmail] = [];

    let senderStats = new Map<string, SenderStats>();
    try {
      senderStats = deps.getSenderStats(accountEmail);
    } catch (err) {
      digest.errors.push(`${accountEmail}: 送信者統計の取得に失敗 — ${(err as Error).message}`);
    }

    // 2. ふるう: spam / noise を AI の前に
    const spamGroups = new Map<string, ButlerGroup>();
    const noiseItems: ButlerGroupItem[] = [];
    let quarantined = 0;
    const survivors: CandidateMail[] = [];
    const bodiesForBulk = deps.getBodies(accountEmail, candidates.map((m) => m.id));

    for (const m of candidates) {
      const fromAddress = normalizeAddress(m.from?.address ?? '');
      const fromName = m.from?.displayName ?? '';
      const tier = tierFor(fromAddress, senderStats.get(fromAddress), rules, ctx);
      const spam = looksLikeSpam({ isSpamFlagged: m.isSpamFlagged, fromAddress, fromName, subject: m.subject, tier });
      if (spam.spam) {
        stats.spam += 1;
        processedThisRun[accountEmail].push(m.id);
        // 可逆な隔離ができるなら自動、できなければ承認グループへ
        if (!deps.dryRun && deps.hasImapCredentials(accountEmail) && quarantined < MAX_AUTO_QUARANTINE_PER_RUN) {
          const mv = await deps.moveToQuarantine(m.id, accountEmail, quarantineFolder);
          if (mv.success) {
            quarantined += 1;
            digest.autoDone.push({
              mailId: m.id, accountEmail, subject: m.subject, from: fromText(m), kind: 'quarantined', reversible: true,
              detail: `${spam.reason} → 「${quarantineFolder}」へ移動`, createdAt: now.toISOString(),
            });
            journal({ kind: 'quarantined', text: `迷惑メールを「${quarantineFolder}」へ: ${m.subject.slice(0, 40)}`, mailId: m.id, accountEmail });
            continue;
          }
        }
        const gkey = (fromName ? fromName.replace(/\s+/g, '').toLowerCase().slice(0, 24) : '') || domainOf(fromAddress) || 'unknown';
        const g = spamGroups.get(gkey) ?? {
          id: `${accountEmail}::spam::${gkey}::${now.getTime()}`,
          kind: 'spam_delete' as const,
          label: fromName ? `「${fromName.replace(/\s+/g, '')}」を名乗る送信元` : `@${domainOf(fromAddress) || '不明'}`,
          reason: spam.reason,
          accountEmail,
          items: [],
          status: 'pending' as const,
          createdAt: now.toISOString(),
        };
        g.items.push({ mailId: m.id, accountEmail, subject: m.subject, from: fromText(m) });
        spamGroups.set(gkey, g);
        continue;
      }
      if (tier === 'noise' || looksLikeBulk({ fromAddress, subject: m.subject, text: bodiesForBulk.get(m.id) || m.preview, tier })) {
        stats.noise += 1;
        processedThisRun[accountEmail].push(m.id);
        if (noiseItems.length < MAX_NOISE_ITEMS) noiseItems.push({ mailId: m.id, accountEmail, subject: m.subject, from: fromText(m) });
        continue;
      }
      survivors.push(m);
    }
    for (const g of spamGroups.values()) groups.push(g);
    if (noiseItems.length > 0) {
      // 片付ける: 権限があり IMAP が使えるなら 既読+アーカイブ(可逆)。できなければ従来の一覧
      let tidiedItems: ButlerGroupItem[] = [];
      let archiveFolder: string | null = null;
      let leftover: ButlerGroupItem[] = noiseItems;
      if (autoTidy && !deps.dryRun && deps.tidy && deps.canTidy?.(accountEmail)) {
        progress({ stage: 'collect', message: `${noiseItems.length}通の一斉配信を片付けています…` });
        try {
          const r = await deps.tidy(accountEmail, noiseItems.map((i) => i.mailId));
          const doneSet = new Set(r.done);
          tidiedItems = noiseItems.filter((i) => doneSet.has(i.mailId));
          leftover = noiseItems.filter((i) => !doneSet.has(i.mailId));
          archiveFolder = r.archiveFolder;
          if (r.error && tidiedItems.length === 0) digest.errors.push(`${accountEmail}: 片付けに失敗 — ${r.error}`);
        } catch (err) {
          digest.errors.push(`${accountEmail}: 片付けに失敗 — ${(err as Error).message}`);
        }
      }
      if (tidiedItems.length > 0) {
        stats.tidied = (stats.tidied ?? 0) + tidiedItems.length;
        groups.push({
          id: `${accountEmail}::tidied::${now.getTime()}`,
          kind: 'tidied',
          label: `一斉配信${tidiedItems.length}通を既読にしてアーカイブ`,
          reason: '返信履歴のない送信元からの宣伝・CFP・自動通知',
          accountEmail,
          items: tidiedItems,
          status: 'approved',
          createdAt: now.toISOString(),
          archiveFolder: archiveFolder ?? undefined,
        });
        journal({ kind: 'archived', text: `一斉配信${tidiedItems.length}通を既読にしてアーカイブ(${accountEmail})`, accountEmail });
      }
      if (leftover.length > 0) {
        groups.push({
          id: `${accountEmail}::noise::${now.getTime()}`,
          kind: 'noise_list',
          label: '一斉配信・勧誘として除外',
          reason: '返信履歴のない送信元からの宣伝・CFP・自動通知',
          accountEmail,
          items: leftover,
          status: 'pending',
          createdAt: now.toISOString(),
        });
      }
    }

    // 3. 束ねる: スレッド単位の案件
    for (const m of survivors) {
      const key = caseIdFor(accountEmail, m);
      const rc = rawByKey.get(key);
      if (rc) {
        rc.mails.push(m);
        if (m.date > rc.latest.date) rc.latest = m;
      } else {
        rawByKey.set(key, { key, accountEmail, mails: [m], latest: m });
      }
    }
  }

  // AI に渡す順番: 付き合いの深さ・宛先位置・新しさ
  const tierWeight: Record<string, number> = { vip: 4, internal: 3, known: 3, unknown: 2, auto: 1, noise: 0 };
  const rawCases = [...rawByKey.values()];
  const scored = rawCases.map((rc) => {
    const fromAddress = normalizeAddress(rc.latest.from?.address ?? '');
    const s = deps.getSenderStats(rc.accountEmail).get(fromAddress);
    const tier = tierFor(fromAddress, s, rules, ctx);
    const to = addressedToMe(rc.latest, ctx.myAddresses);
    const score = (tierWeight[tier] ?? 1) * 10 + (to === 'to' ? 5 : to === 'cc' ? 2 : 0);
    return { rc, tier, stats: s, to, score };
  });
  scored.sort((a, b) => b.score - a.score || (b.rc.latest.date.getTime() - a.rc.latest.date.getTime()));

  const selected = scored.slice(0, maxCases);
  const deferred = scored.slice(maxCases);
  for (const d of deferred) {
    (deferredIds[d.rc.accountEmail] ??= []).push(...d.rc.mails.map((m) => m.id));
  }
  if (deferred.length > 0) {
    digest.errors.push(`AI判定の上限(${maxCases}案件)に達したため、${deferred.length}案件を次回に回しました。`);
  }

  // 材料を揃える(本文・経緯)
  for (const s of selected) {
    const rc = s.rc;
    const m = rc.latest;
    let thread: ThreadContext | null = null;
    if (m.conversationId) {
      try {
        thread = deps.getThread(rc.accountEmail, m.conversationId);
        threadCache.set(rc.key, thread);
      } catch (err) {
        log(`[butler] thread fetch failed for ${rc.key}: ${(err as Error).message}`);
      }
    }
    let body = thread?.messages.find((x) => x.id === m.id)?.body ?? '';
    if (!body) {
      const b = deps.getBodies(rc.accountEmail, [m.id]);
      body = b.get(m.id) || m.preview || '';
    }
    const history = (thread?.messages ?? [])
      .filter((x) => x.id !== m.id)
      .slice(-4)
      .map((x) => ({
        date: fmtDateTime(x.date).slice(5),
        who: x.isSentByMe ? '先生' : (x.from.split('<')[0].trim() || x.fromAddress),
        excerpt: (x.body || '').replace(/\s+/g, ' ').slice(0, 200),
      }));
    aiInputs.push({
      id: rc.key,
      accountEmail: rc.accountEmail,
      subject: m.subject,
      fromName: m.from?.displayName ?? '',
      fromAddress: m.from?.address ?? '',
      tier: s.tier,
      stats: s.stats,
      addressedToMe: s.to,
      receivedAt: fmtDateTime(m.date),
      threadCount: thread?.count ?? rc.mails.length,
      myReplies: thread?.myReplies ?? 0,
      lastFromMe: thread?.lastFromMe ?? false,
      body,
      history,
    });
  }

  // 4. 判断する
  let judgments = new Map<string, CaseJudgment>();
  if (aiInputs.length > 0) {
    progress({ stage: 'classify', message: `${aiInputs.length}案件を判定しています…`, done: 0, total: aiInputs.length });
    try {
      const res = await deps.classify(ctx, aiInputs, classifyModel, (done, total) =>
        progress({ stage: 'classify', message: `判定中 ${done}/${total} バッチ`, done, total }),
      );
      judgments = res.judgments;
      stats.aiCalls += res.aiCalls;
      digest.costUsd += res.costUsd;
      for (const e of res.errors) digest.errors.push(`判定: ${e}`);
    } catch (err) {
      digest.errors.push(`判定に失敗しました — ${(err as Error).message}`);
    }
  }

  for (const s of selected) {
    const rc = s.rc;
    const m = rc.latest;
    const j = judgments.get(rc.key);
    const thread = threadCache.get(rc.key);
    // AI が答えなかったときの暫定: 付き合いのある相手だけ「確認」に載せ、初見・自動送信は参考扱い
    const trusted = s.tier === 'vip' || s.tier === 'internal' || s.tier === 'known';
    const fallback: CaseJudgment = {
      id: rc.key,
      category: trusted ? 'action' : 'fyi',
      priority: s.tier === 'vip' ? 'P2' : trusted ? 'P3' : 'P4',
      ask: '内容を確認する',
      summary: (m.preview || '').replace(/\s+/g, ' ').slice(0, 120),
      deadline: null,
      suggestedAction: '内容を確認',
      reason: 'AI判定が得られなかったため暫定',
      needsDraft: false,
      replyKind: 'other',
      autoSendSafe: false,
      replyScope: 'sender',
      decision: null,
      event: null,
    };
    const jj = j ?? fallback;
    const priority = bumpPriorityByDeadline(jj, ctx.today);
    const c: ButlerCase = {
      id: rc.key,
      accountEmail: rc.accountEmail,
      conversationId: m.conversationId,
      mailId: m.id,
      mailIds: rc.mails.map((x) => x.id),
      subject: m.subject,
      from: fromText(m),
      fromAddress: normalizeAddress(m.from?.address ?? ''),
      fromName: m.from?.displayName ?? '',
      receivedAt: isoDate(m.date),
      addressedToMe: s.to,
      senderTier: s.tier,
      senderStats: s.stats,
      threadCount: thread?.count ?? rc.mails.length,
      myRepliesInThread: thread?.myReplies ?? 0,
      lastFromMe: thread?.lastFromMe ?? false,
      category: jj.category,
      priority,
      ask: jj.ask,
      summary: jj.summary,
      deadline: jj.deadline,
      suggestedAction: jj.suggestedAction,
      reason: jj.reason,
      needsDraft: jj.needsDraft,
      draftHint: jj.draftHint,
      replyKind: jj.replyKind,
      autoSendSafe: jj.autoSendSafe,
      replyScope: jj.replyScope,
      decision: jj.decision,
      event: jj.event,
      isRead: m.isRead,
      tags: tagsFor(jj.category, priority),
      noteId: noteIdFor(m),
      status: jj.category === 'noise' || jj.category === 'spam' ? 'dismissed' : 'open',
      aiSource: j ? 'ai' : 'fallback',
      createdAt: now.toISOString(),
      runAt: now.toISOString(),
    };
    freshCases.push(c);
    (processedThisRun[rc.accountEmail] ??= []).push(...rc.mails.map((x) => x.id));
    if (c.category === 'noise') stats.noise += 1;
    if (c.category === 'spam') stats.spam += 1;
  }

  // 5. 用意する: 返信下書き(優先度順・上限あり)
  const draftTargets = sortCases(freshCases).filter((c) => c.status === 'open' && c.needsDraft && c.category === 'reply' && !(c.decision && !c.decision.answer)).slice(0, maxDrafts);
  if (draftTargets.length > 0) {
    progress({ stage: 'draft', message: `返信下書きを${draftTargets.length}通用意しています…`, done: 0, total: draftTargets.length });
    const exemplarCache = new Map<string, string[]>();
    let done = 0;
    await Promise.all(
      draftTargets.map(async (c) => {
        try {
          let exemplars = exemplarCache.get(c.accountEmail);
          if (!exemplars) {
            try { exemplars = deps.getExemplars(c.accountEmail); } catch { exemplars = []; }
            exemplarCache.set(c.accountEmail, exemplars);
          }
          const thread = threadCache.get(c.id);
          const res = await deps.draft(ctx, {
            subject: c.subject,
            fromName: c.fromName,
            fromAddress: c.fromAddress,
            thread: thread?.messages ?? [],
            exemplars,
            ask: c.ask,
            draftHint: c.draftHint,
          }, draftModel);
          stats.aiCalls += 1;
          digest.costUsd += res.costUsd;
          if (res.ok) {
            c.draft = res.draft;
            c.draftStatus = 'prepared';
            stats.drafts += 1;
          } else {
            c.draftStatus = 'failed';
            digest.errors.push(`下書き(${c.subject.slice(0, 30)}): ${res.error ?? '失敗'}`);
          }
        } catch (err) {
          c.draftStatus = 'failed';
          digest.errors.push(`下書き(${c.subject.slice(0, 30)}): ${(err as Error).message}`);
        } finally {
          done += 1;
          progress({ stage: 'draft', message: `下書き ${done}/${draftTargets.length}`, done, total: draftTargets.length });
        }
      }),
    );
  }

  // 任せる: 定型返信を送信予定へ(遅延+取消可)。delegate のときだけ
  if (mode === 'delegate' && !deps.dryRun && deps.enqueueSend) {
    for (const c of freshCases) {
      if (!canAutoSend(c, mode) || !deps.canSend?.(c.accountEmail) || !c.draft) continue;
      try {
        const id = await deps.enqueueSend(c, c.draft);
        if (id) {
          c.status = 'scheduled';
          c.outboxId = id;
          c.statusChangedAt = now.toISOString();
          stats.scheduled = (stats.scheduled ?? 0) + 1;
          journal({ kind: 'scheduled', text: `定型返信を送信予定に: ${c.fromName || c.fromAddress}「${c.subject.slice(0, 40)}」`, caseId: c.id, mailId: c.mailId, accountEmail: c.accountEmail });
        }
      } catch (err) {
        digest.errors.push(`送信予定(${c.subject.slice(0, 30)}): ${(err as Error).message}`);
      }
    }
  }

  // ノート(タグ)へ反映 — reply/action のみ(fyi/noise で 8,000 件のノートを作らない)
  if (!deps.dryRun) {
    for (const c of freshCases) {
      if (c.category !== 'reply' && c.category !== 'action') continue;
      if (c.priority === 'P4') continue;
      try {
        upsertNote(deps, c, runStamp);
        digest.autoDone.push({
          mailId: c.mailId, accountEmail: c.accountEmail, subject: c.subject, from: c.from, kind: c.draft ? 'draft_prepared' : 'tagged',
          reversible: true, detail: `${c.priority} ${c.suggestedAction} — ${c.reason}`, tags: c.tags, draft: c.draft, createdAt: now.toISOString(),
        });
      } catch (err) {
        digest.errors.push(`ノート更新(${c.subject.slice(0, 30)}): ${(err as Error).message}`);
      }
    }
  }

  // 見張る: 先生が送って返事が無いスレッド
  let followUpsOpen = 0;
  if (deps.getWaitingThreads && deps.judgeFollowUps && deps.followUpsPath) {
    progress({ stage: 'brief', message: '返事待ちを確認しています…' });
    try {
      const prevFollowUps = deps.readJson<FollowUp[]>(deps.followUpsPath) ?? [];
      const known = new Set(prevFollowUps.map((f) => f.id));
      const waiting: Array<WaitingThread & { accountEmail: string }> = [];
      const inputs: FollowUpInput[] = [];
      for (const accountEmail of accounts) {
        let ws: WaitingThread[] = [];
        try {
          ws = deps.getWaitingThreads(accountEmail, { minDays: Math.max(1, settings.partnerFollowUpDays ?? 4), maxDays: 45, limit: 30 });
        } catch (err) {
          digest.errors.push(`${accountEmail}: 返事待ちの取得に失敗 — ${(err as Error).message}`);
          continue;
        }
        const senderStats = (() => { try { return deps.getSenderStats(accountEmail); } catch { return new Map<string, SenderStats>(); } })();
        for (const w of ws) {
          waiting.push({ ...w, accountEmail });
          const id = `${accountEmail}::conv-${w.conversationId}`;
          if (known.has(id)) continue;
          const toAddr = normalizeAddress(w.to[0]?.address ?? '');
          inputs.push({
            id,
            subject: w.subject,
            toText: w.to.map((a) => (a.displayName ? `${a.displayName} <${a.address}>` : a.address)).join(', ') + (w.cc.length ? ` (Cc ${w.cc.length})` : ''),
            tier: tierFor(toAddr, senderStats.get(toAddr), rules, ctx),
            sentAt: fmtDateTime(w.sentAt),
            daysWaiting: w.daysWaiting,
            threadCount: w.threadCount,
            body: w.body,
          });
        }
      }
      let judgments = new Map<string, FollowUpJudgment>();
      if (inputs.length > 0) {
        const r = await deps.judgeFollowUps(ctx, inputs.slice(0, 24), classifyModel);
        judgments = r.judgments;
        stats.aiCalls += r.aiCalls;
        digest.costUsd += r.costUsd;
        for (const e of r.errors) digest.errors.push(`返事待ち: ${e}`);
      }
      const rec = reconcileFollowUps(prevFollowUps, waiting, judgments, accounts, now);
      followUpsOpen = rec.list.filter((f) => f.status === 'open' || f.status === 'nudged').length;
      for (const f of rec.opened) journal({ kind: 'run', text: `返事待ちに追加: ${f.to}「${f.subject.slice(0, 40)}」(${f.daysWaiting}日)`, accountEmail: f.accountEmail });
      for (const f of rec.closed) journal({ kind: 'closed', text: `返事が来たので返事待ちを閉じました: 「${f.subject.slice(0, 40)}」`, accountEmail: f.accountEmail });
      if (!deps.dryRun) deps.writeJson(deps.followUpsPath, rec.list);
    } catch (err) {
      digest.errors.push(`返事待ちの確認に失敗 — ${(err as Error).message}`);
    }
  }
  stats.followUps = followUpsOpen;

  // 6. 報告する
  const merged = sortCases(mergeCarryOver(prevDigest?.cases, freshCases, now));
  const open = merged.filter((c) => c.status === 'open');
  const decisionsOpen = open.filter((c) => c.decision && !c.decision.answer);
  stats.decisions = decisionsOpen.length;

  // 旧版(event 欄が無い)で判定した引き継ぎ案件は、予定だけ後から抜く(1回きり)
  if (deps.extractEvents) {
    const legacy = merged.filter((c) => c.status === 'open' && c.event === undefined && c.category !== 'noise' && c.category !== 'spam').slice(0, 60);
    if (legacy.length > 0) {
      progress({ stage: 'brief', message: `${legacy.length}件の予定を確認しています…` });
      try {
        const inputs: EventOnlyInput[] = [];
        const byAccount = new Map<string, ButlerCase[]>();
        for (const c of legacy) (byAccount.get(c.accountEmail) ?? byAccount.set(c.accountEmail, []).get(c.accountEmail)!).push(c);
        for (const [acct, cs] of byAccount) {
          let bodies = new Map<number, string>();
          try { bodies = deps.getBodies(acct, cs.map((c) => c.mailId)); } catch { /* preview で代用 */ }
          for (const c of cs) inputs.push({ id: c.id, subject: c.subject, receivedAt: fmtDateTime(c.receivedAt), body: bodies.get(c.mailId) || c.summary });
        }
        const r = await deps.extractEvents(ctx, inputs, classifyModel);
        stats.aiCalls += r.aiCalls;
        digest.costUsd += r.costUsd;
        for (const c of legacy) c.event = r.events.has(c.id) ? r.events.get(c.id) ?? null : c.event;
        for (const e of r.errors) digest.errors.push(`予定: ${e}`);
      } catch (err) {
        digest.errors.push(`予定の抽出に失敗 — ${(err as Error).message}`);
      }
    }
  }

  // カレンダー照合: 予定が書かれた案件(今回分と引き継ぎ分)を、全アカウントのカレンダーと突き合わせる
  if (deps.getCalendarEvents) {
    const withEvent = merged.filter((c) => c.event && (c.status === 'open' || c.status === 'later' || c.status === 'scheduled'));
    if (withEvent.length > 0) {
      let events: CalendarEvent[] = [];
      let ok = false;
      for (const accountEmail of settings.selectedAccounts ?? accounts) {
        try { events = events.concat(deps.getCalendarEvents(accountEmail, 120)); ok = true; } catch { /* カレンダーの無いアカウント */ }
      }
      for (const c of withEvent) {
        if (!ok) { c.calendarStatus = 'unknown'; continue; }
        const r = matchCalendar(c.event!, events);
        c.calendarStatus = r.status;
        c.calendarMatch = r.match;
      }
    }
  }
  stats.calendarMissing = merged.filter((c) => c.status === 'open' && c.calendarStatus === 'missing').length;
  stats.cases = merged.filter((c) => c.status !== 'dismissed').length;
  stats.p1 = open.filter((c) => c.priority === 'P1').length;
  stats.p2 = open.filter((c) => c.priority === 'P2').length;
  stats.p3 = open.filter((c) => c.priority === 'P3').length;

  const briefInput: BriefInput = {
    today: ctx.today,
    hour: now.getHours(),
    p1: open.filter((c) => c.priority === 'P1').slice(0, 6).map((c) => ({ subject: c.subject, from: c.fromName || c.fromAddress, ask: c.ask, deadline: c.deadline })),
    p2: open.filter((c) => c.priority === 'P2').slice(0, 6).map((c) => ({ subject: c.subject, from: c.fromName || c.fromAddress, ask: c.ask, deadline: c.deadline })),
    decisions: decisionsOpen.slice(0, 4).map((c) => ({ subject: c.subject, from: c.fromName || c.fromAddress, question: c.decision?.question ?? '' })),
    counts: {
      cases: stats.cases,
      noise: stats.noise,
      spam: stats.spam,
      drafts: stats.drafts,
      fyi: open.filter((c) => c.category === 'fyi').length,
      tidied: stats.tidied,
      scheduled: stats.scheduled,
      followUps: stats.followUps,
      decisions: stats.decisions,
      calendarMissing: stats.calendarMissing,
    },
  };
  if (stats.candidates > 0 || open.length > 0 || followUpsOpen > 0) {
    progress({ stage: 'brief', message: '申し送りを書いています…' });
    try {
      const b = await deps.brief(briefInput, classifyModel);
      digest.brief = b.text;
      digest.costUsd += b.costUsd;
      if (b.ai) stats.aiCalls += 1;
    } catch (err) {
      digest.errors.push(`申し送りの生成に失敗 — ${(err as Error).message}`);
    }
  } else {
    digest.brief = `${greetingFor(now.getHours())}新しいメールはありませんでした。`;
  }

  // 前回の未処理グループ(承認待ちの削除候補)も引き継ぐ
  const prevGroups = (prevDigest?.groups ?? []).filter((g) => g.status === 'pending' && g.kind === 'spam_delete');
  const cutoff = now.getTime() - CARRY_OVER_DAYS * 86_400_000;
  for (const g of prevGroups) {
    const t = new Date(g.createdAt).getTime();
    if (!isNaN(t) && t >= cutoff) groups.push(g);
  }

  digest.cases = merged;
  digest.groups = groups;
  digest.processedCount = Object.values(processedThisRun).reduce((n, arr) => n + arr.length, 0);
  stats.durationMs = Date.now() - startedAt;
  digest.stats = stats;
  digest.mode = mode;
  digest.sources = ctx.sources;
  journal({ kind: 'run', text: `確認: 新着${stats.candidates}通 → 案件${freshCases.filter((c) => c.status !== 'dismissed').length}件、下書き${stats.drafts}通、片付け${stats.tidied ?? 0}通、送信予定${stats.scheduled ?? 0}通(${Math.round(stats.durationMs / 1000)}秒)` });

  // 状態の永続化(次回に回した分は処理済みにしない)
  if (!deps.dryRun) {
    for (const [acct, ids] of Object.entries(processedThisRun)) {
      const deferSet = new Set(deferredIds[acct] ?? []);
      const arr = state.processed[acct] ?? [];
      for (const id of ids) if (!deferSet.has(id) && !arr.includes(id)) arr.push(id);
      state.processed[acct] = arr;
    }
    state.lastRunAt = now.toISOString();
    saveState(deps, state);
    deps.writeJson(deps.digestPath, digest);
  }

  progress({ stage: 'done', message: `完了: 案件${stats.cases}件 / 下書き${stats.drafts}通` });
  return digest;
}
