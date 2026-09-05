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
} from '../../src/types/index';
import type { CandidateMail, ThreadContext } from './mail-intel';
import type { JudgmentContext, CaseInput, CaseJudgment, DraftParams, BriefInput } from './butler-brain';
import { tierFor, looksLikeBulk, looksLikeSpam } from './butler-brain';
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
  getCandidates: (accountEmail: string, q: { since: Date; limit: number; excludeIds: Set<number> }) => CandidateMail[];
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
    if (c.status !== 'open' && c.status !== 'later') continue;
    const t = new Date(c.runAt || c.createdAt).getTime();
    if (isNaN(t) || t < cutoff) continue;
    byId.set(c.id, c);
  }
  for (const c of fresh) {
    const old = byId.get(c.id);
    // 「後で」にしていた案件に新着があれば再度 open にする(相手が動いた)
    byId.set(c.id, old ? { ...c, status: 'open', createdAt: old.createdAt } : c);
  }
  return [...byId.values()];
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

  // 取得ウィンドウ: 初回は butlerInitialDays、2回目以降は前回実行の2日前から(取りこぼし防止)
  const since = new Date(now);
  if (state.lastRunAt) {
    const last = new Date(state.lastRunAt);
    since.setTime((isNaN(last.getTime()) ? now.getTime() : last.getTime()) - 2 * 86_400_000);
  } else {
    since.setDate(since.getDate() - Math.max(1, settings.butlerInitialDays ?? 14));
  }

  const stats: ButlerStats = { candidates: 0, cases: 0, p1: 0, p2: 0, p3: 0, noise: 0, spam: 0, drafts: 0, aiCalls: 0, durationMs: 0 };
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
      groups.push({
        id: `${accountEmail}::noise::${now.getTime()}`,
        kind: 'noise_list',
        label: '一斉配信・勧誘として除外',
        reason: '返信履歴のない送信元からの宣伝・CFP・自動通知',
        accountEmail,
        items: noiseItems,
        status: 'pending',
        createdAt: now.toISOString(),
      });
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
  const draftTargets = sortCases(freshCases).filter((c) => c.status === 'open' && c.needsDraft && c.category === 'reply').slice(0, maxDrafts);
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

  // 6. 報告する
  const merged = sortCases(mergeCarryOver(prevDigest?.cases, freshCases, now));
  const open = merged.filter((c) => c.status === 'open');
  stats.cases = merged.filter((c) => c.status !== 'dismissed').length;
  stats.p1 = open.filter((c) => c.priority === 'P1').length;
  stats.p2 = open.filter((c) => c.priority === 'P2').length;
  stats.p3 = open.filter((c) => c.priority === 'P3').length;

  const briefInput: BriefInput = {
    today: ctx.today,
    p1: open.filter((c) => c.priority === 'P1').slice(0, 6).map((c) => ({ subject: c.subject, from: c.fromName || c.fromAddress, ask: c.ask, deadline: c.deadline })),
    p2: open.filter((c) => c.priority === 'P2').slice(0, 6).map((c) => ({ subject: c.subject, from: c.fromName || c.fromAddress, ask: c.ask, deadline: c.deadline })),
    counts: {
      cases: stats.cases,
      noise: stats.noise,
      spam: stats.spam,
      drafts: stats.drafts,
      fyi: open.filter((c) => c.category === 'fyi').length,
    },
  };
  if (stats.candidates > 0 || open.length > 0) {
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
    digest.brief = 'おはようございます。新しいメールはありませんでした。';
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
