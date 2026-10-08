// === 相棒 v3: IPC・スケジューラ・送信キュー・通知 ===
//
// main.ts から切り出した「相棒」の実行部。パイプライン(services/pipeline.ts)に
// 片付け・送信予定・返事待ちの手足を渡し、UI(「今日」画面)との窓口になる。
//
// 安全ライン:
//   - 送信は必ず outbox(遅延 + 取消)を通る。sendAt を過ぎたものだけ 20 秒ごとの tick が送る
//   - 片付けは 既読 + アーカイブ のみ(削除しない)。「戻す」で元に戻る
//   - すべての操作を日誌に残す

import { ipcMain, Notification, powerMonitor, app, dialog, shell, clipboard } from 'electron';
import type { FSWatcher } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { spawn, execFileSync } from 'child_process';
import type {
  AppSettings, MailNote, NightlyDigest, ButlerCase, ButlerRules, SenderStats, PartnerState, OutboxItem, FollowUp,
  AccountEndpoints, ImapCredentials, SmtpCredentials, JournalEntry, AccountSmtpConfig, CaseHandoff, HandoffTarget,
} from '../src/types/index';
import type { ClaudeRunner } from './services/claude-runner';
import type { JudgmentContext } from './services/butler-brain';
import { draftReply, draftNudge, judgeFollowUps, prepareHandoff, resolveReferencesDir, DEFAULT_PROFILE } from './services/butler-brain';
import type { PipelineDeps } from './services/pipeline';
import { getThreadContext, getSentExemplars, getReplyHeaders, getWaitingThreads, guessSignature, getMyDisplayName } from './services/mail-intel';
import { discoverAccountEndpoints } from './services/account-discovery';
import { tidyToArchive, restoreToInbox, markAnswered, appendToSent, appendToDrafts, testImap, isGmailHost } from './services/mailbox-actions';
import { sendMail, verifySmtp, composeBody, replySubject, friendlySmtpError, buildRawMessage } from './services/mail-sender';
import { buildIcs, googleCalendarTemplateUrl } from './services/calendar-ics';
import { createGoogleCalendar } from './services/google-calendar';
import { loadIndex, saveIndex, upsertTask, markTask, ensureTaskCli, indexPath } from './services/task-cli';
import type { QuotedOriginal } from './services/mail-sender';
import { normalizeOutbox, enqueue, cancel, expedite, update as updateOutbox, dueItems, prune, visibleItems } from './services/outbox';
import type { OutboxStore } from './services/outbox';
import { appendJournal, readRecentJournal } from './services/journal';
import { loadRules } from './services/butler-rules';

export interface PartnerHost {
  userDataDir: string;
  loadSettings: () => AppSettings;
  saveSettings: (s: AppSettings) => void;
  readJson: <T>(p: string) => T | null;
  writeJson: (p: string, data: unknown) => void;
  readNote: (id: string) => MailNote | null;
  writeNote: (n: MailNote) => void;
  getRunner: () => ClaudeRunner;
  buildContext: (rules: ButlerRules) => JudgmentContext;
  rulesPath: string;
  digestPath: string;
  getSenderStats: (accountEmail: string) => Map<string, SenderStats>;
  openCompose: (p: { to: string; subject: string; body: string; cc?: string }) => Promise<void>;
  send: (channel: string, payload: unknown) => void;
  showWindow: () => void;
  getWindow: () => Electron.BrowserWindow | null;
  defaultCalendarAccount: () => string;   // 予定が実際に入っている Google アカウント(自動選択)
  encrypt: (s: string) => string;         // safeStorage
  decrypt: (s: string) => string;
  log: (m: string) => void;
}

export interface Partner {
  pipelineDeps: () => Pick<PipelineDeps, 'canTidy' | 'tidy' | 'canSend' | 'enqueueSend' | 'getWaitingThreads' | 'judgeFollowUps' | 'followUpsPath' | 'journal' | 'autoAddEvent'>;
  attach: (run: (opts?: { force?: boolean }) => Promise<NightlyDigest>) => void;
  setRunning: (running: boolean) => void;
  setProgress: (p: PartnerState['progress']) => void;
  afterRun: (digest: NightlyDigest, prev: NightlyDigest | null) => void;
  startScheduler: () => void;
  reschedule: () => void;
  getState: () => PartnerState;
  stop: () => void;
}

const OUTBOX_TICK_MS = 20_000;

function fmtAddr(a: { displayName?: string; address: string }): string {
  return a.displayName ? `"${a.displayName.replace(/"/g, '')}" <${a.address}>` : a.address;
}

/** "Name" <addr> → addr(mailto: 用) */
function plainAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

function fmtJa(d: Date): string {
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function createPartner(host: PartnerHost): Partner {
  const OUTBOX_PATH = path.join(host.userDataDir, 'outbox.json');
  const FOLLOWUPS_PATH = path.join(host.userDataDir, 'followups.json');
  const JOURNAL_DIR = path.join(host.userDataDir, 'journal');
  const PROFILE_PATH = path.join(host.userDataDir, 'butler-profile.md');
  const STATE_PATH = path.join(host.userDataDir, 'butler-state.json');

  let runPipeline: ((opts?: { force?: boolean }) => Promise<NightlyDigest>) | null = null;
  let running = false;
  let progress: PartnerState['progress'] = null;
  let nextRunAt: Date | null = null;
  let scheduleTimer: ReturnType<typeof setInterval> | null = null;
  let outboxTimer: ReturnType<typeof setInterval> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let outboxBusy = false;
  let watcher: FSWatcher | null = null;
  let handoffWatcher: FSWatcher | null = null;
  let watchDebounce: ReturnType<typeof setTimeout> | null = null;
  const RUN_REQUEST_PATH = path.join(host.userDataDir, 'run-request.json');

  // ---------- Google カレンダー(OAuth) ----------
  const google = createGoogleCalendar({
    storePath: path.join(host.userDataDir, 'google-auth.json'),
    encrypt: host.encrypt,
    decrypt: host.decrypt,
    openExternal: (url) => shell.openExternal(url),
    log: host.log,
  });

  /** 案件の予定を Google カレンダーに直接入れ、案件に記録する */
  async function insertCaseEvent(c: ButlerCase, auto: boolean): Promise<{ id: string; htmlLink: string; calendarId: string }> {
    const ev = c.event!;
    const r = await google.insertEvent({ ...ev, description: `${c.summary}\n\n差出人: ${c.from}\n件名: ${c.subject}\n(調が登録)` });
    withCase(c.id, (cc) => {
      cc.calendarStatus = 'registered';
      cc.calendarMatch = ev.title;
      cc.calendarEventId = r.id;
      cc.calendarEventCalendarId = r.calendarId;
      cc.calendarEventLink = r.htmlLink;
    });
    journal({ kind: 'decided', text: `Google カレンダーに登録${auto ? '(自動)' : ''}: ${ev.title}(${ev.start})`, caseId: c.id, accountEmail: c.accountEmail });
    return r;
  }

  // ---------- 小道具 ----------
  const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const journal = (entry: Omit<JournalEntry, 'at'>): void => { appendJournal(JOURNAL_DIR, entry); };
  const loadOutbox = (): OutboxStore => normalizeOutbox(host.readJson<OutboxStore>(OUTBOX_PATH));
  const saveOutbox = (s: OutboxStore): void => host.writeJson(OUTBOX_PATH, s);
  const loadFollowUps = (): FollowUp[] => host.readJson<FollowUp[]>(FOLLOWUPS_PATH) ?? [];
  const saveFollowUps = (l: FollowUp[]): void => host.writeJson(FOLLOWUPS_PATH, l);
  const loadDigest = (): NightlyDigest | null => host.readJson<NightlyDigest>(host.digestPath);
  const saveDigest = (d: NightlyDigest): void => host.writeJson(host.digestPath, d);

  const imapFor = (accountEmail: string): ImapCredentials | null =>
    host.loadSettings().imapConfigs.find((c) => c.accountEmail === accountEmail)?.credentials ?? null;
  const smtpFor = (accountEmail: string): AccountSmtpConfig | null => {
    const c = (host.loadSettings().smtpConfigs ?? []).find((x) => x.accountEmail === accountEmail);
    return c?.credentials?.host && c.credentials.password ? c : null;
  };
  const myAddresses = (): Set<string> => new Set(host.loadSettings().selectedAccounts.map((a) => a.toLowerCase()));

  /** Dock バッジ = 決めてほしいこと + 今日動く案件(開いているもの) */
  function updateBadge(state: PartnerState): void {
    try {
      if (process.platform !== 'darwin' || !app.dock) return;
      const open = (state.digest?.cases ?? []).filter((c) => c.status === 'open');
      const n = open.filter((c) => c.priority === 'P1' || (c.decision && !c.decision.answer)).length;
      app.dock.setBadge(n > 0 ? String(n) : '');
    } catch { /* dock unavailable */ }
  }

  const pushState = (): void => {
    try {
      const s = getState();
      updateBadge(s);
      host.send('partner:state', s);
    } catch { /* window gone */ }
  };

  /** MCP サーバー(Claude Code 側)が同じ JSON を書いたら画面に反映する。run-request.json が置かれたら確認を走らせる */
  function startWatcher(): void {
    if (watcher) return;
    try {
      watcher = fs.watch(host.userDataDir, { persistent: false }, (_ev, filename) => {
        const f = String(filename ?? '');
        if (!/^(outbox|followups|nightly-digest|run-request)\.json$/.test(f)) return;
        if (watchDebounce) clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          if (f === 'run-request.json' && fs.existsSync(RUN_REQUEST_PATH)) {
            try { fs.unlinkSync(RUN_REQUEST_PATH); } catch { /* ignore */ }
            triggerRun('mcp-request');
            return;
          }
          pushState();
          void processOutbox();
        }, 400);
      });
    } catch (err) {
      host.log(`[partner] watcher unavailable: ${(err as Error).message}`);
    }
    // 作業の共有キュー(CLI / MCP が受け取りを記録したら、案件に写して画面へ)
    try {
      const dir = path.dirname(indexPath(host.userDataDir));
      fs.mkdirSync(dir, { recursive: true });
      handoffWatcher = fs.watch(dir, { persistent: false }, (_ev, filename) => {
        if (String(filename ?? '') !== 'index.json') return;
        setTimeout(() => { if (syncHandoffIndex()) pushState(); }, 300);
      });
    } catch (err) {
      host.log(`[partner] handoff watcher unavailable: ${(err as Error).message}`);
    }
  }

  /** index.json の受け取り状態を案件へ写す。変化があれば true */
  function syncHandoffIndex(): boolean {
    const digest = loadDigest();
    if (!digest?.cases) return false;
    const idx = loadIndex(host.userDataDir);
    let changed = false;
    for (const task of idx.tasks) {
      const c = digest.cases.find((x) => x.id === task.caseId);
      if (!c?.handoff) continue;
      if (c.handoff.status !== task.status || c.handoff.takenAt !== task.takenAt || c.handoff.takenBy !== task.takenBy) {
        c.handoff.status = task.status;
        c.handoff.takenAt = task.takenAt;
        c.handoff.takenBy = task.takenBy;
        if (task.status === 'taken' && task.takenBy?.startsWith('cli:')) {
          journal({ kind: 'decided', text: `作業を受け取り: ${task.title}(${task.takenBy.slice(4)})`, caseId: c.id, accountEmail: c.accountEmail });
        }
        changed = true;
      }
    }
    if (changed) saveDigest(digest);
    return changed;
  }

  function putTaskInQueue(c: ButlerCase, h: CaseHandoff, status?: 'pending' | 'taken' | 'done', by?: string): void {
    let idx = upsertTask(loadIndex(host.userDataDir), { id: safeName(c.id), caseId: c.id, title: h.title, docPath: h.docPath, folder: h.folder, deliverable: h.deliverable });
    if (status === 'taken' || status === 'done') idx = markTask(idx, safeName(c.id), status, by);
    saveIndex(host.userDataDir, idx);
    const task = idx.tasks.find((x) => x.id === safeName(c.id));
    if (task) { h.status = task.status; h.takenAt = task.takenAt; h.takenBy = task.takenBy; }
  }

  function getState(): PartnerState {
    const settings = host.loadSettings();
    const digest = loadDigest();
    const outbox = visibleItems(loadOutbox());
    const followUps = loadFollowUps().filter((f) => f.status !== 'closed');
    const canSend: Record<string, boolean> = {};
    const canTidy: Record<string, boolean> = {};
    for (const a of settings.selectedAccounts) {
      canSend[a] = !!smtpFor(a);
      canTidy[a] = !!imapFor(a);
    }
    let sources: string[] = digest?.sources ?? [];
    if (sources.length === 0) { try { sources = host.buildContext(loadRules(host.rulesPath)).sources; } catch { /* ignore */ } }
    return {
      digest,
      outbox,
      followUps,
      journal: readRecentJournal(JOURNAL_DIR, 80),
      running,
      progress,
      lastRunAt: digest?.runAt ?? null,
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      canSend,
      canTidy,
      mode: settings.partnerMode ?? 'assist',
      sources,
    };
  }

  // ---------- 案件の更新 ----------
  function withCase<T>(caseId: string, fn: (c: ButlerCase, digest: NightlyDigest) => T): { ok: true; value: T } | { ok: false; error: string } {
    const digest = loadDigest();
    const c = digest?.cases?.find((x) => x.id === caseId);
    if (!digest || !c) return { ok: false, error: '案件が見つかりません' };
    const value = fn(c, digest);
    saveDigest(digest);
    return { ok: true, value };
  }

  function markCaseSent(caseId: string, at: string): void {
    withCase(caseId, (c) => {
      c.status = 'sent';
      c.sentAt = at;
      c.statusChangedAt = at;
      if (c.noteId) {
        const note = host.readNote(c.noteId);
        if (note) {
          note.tags = [...(note.tags ?? []).filter((t) => !['reply', 'action', 'urgent'].includes(t)), 'done'];
          note.history = [...(note.history ?? []), { timestamp: at, type: 'updated', content: '相棒が返信を送信しました' }];
          note.updatedAt = at;
          host.writeNote(note);
        }
      }
    });
  }

  // ---------- 送信予定(outbox) ----------
  function buildReplyRecipients(c: ButlerCase): { to: string[]; cc: string[] } {
    const mine = myAddresses();
    let headers = null as ReturnType<typeof getReplyHeaders>;
    try { headers = getReplyHeaders(c.accountEmail, c.mailId); } catch { /* db */ }
    const primary = headers?.replyTo ?? headers?.from ?? null;
    const to = primary ? [fmtAddr(primary)] : [c.fromAddress];
    const toSet = new Set([(primary?.address ?? c.fromAddress).toLowerCase()]);
    const cc: string[] = [];
    if (c.replyScope === 'all' && headers) {
      for (const a of [...headers.to, ...headers.cc]) {
        const addr = (a.address ?? '').toLowerCase();
        if (!addr || mine.has(addr) || toSet.has(addr)) continue;
        toSet.add(addr);
        cc.push(fmtAddr(a));
      }
    }
    return { to, cc };
  }

  async function enqueueReply(c: ButlerCase, body: string, delayMinutes: number, auto: boolean): Promise<OutboxItem> {
    const { to, cc } = buildReplyRecipients(c);
    const r = enqueue(loadOutbox(), {
      kind: 'reply',
      caseId: c.id,
      accountEmail: c.accountEmail,
      to, cc,
      subject: replySubject(c.subject),
      body,
      inReplyToMailId: c.mailId,
      label: `${c.fromName || c.fromAddress} へ「${c.subject.slice(0, 40)}」`,
      auto,
      delayMinutes,
    });
    saveOutbox(prune(r.store));
    return r.item;
  }

  async function processOutbox(): Promise<void> {
    if (outboxBusy) return;
    outboxBusy = true;
    try {
      let store = loadOutbox();
      const due = dueItems(store);
      if (due.length === 0) return;
      for (const item of due) {
        store = updateOutbox(store, item.id, { status: 'sending' });
        saveOutbox(store);
        pushState();
        const result = await sendOne(item);
        store = loadOutbox();
        if (result.ok) {
          const at = new Date().toISOString();
          store = updateOutbox(store, item.id, { status: 'sent', sentAt: at, messageId: result.messageId ?? '', error: undefined });
          saveOutbox(store);
          if (item.caseId) markCaseSent(item.caseId, at);
          if (item.followUpId) {
            const list = loadFollowUps();
            const f = list.find((x) => x.id === item.followUpId);
            if (f) { f.status = 'nudged'; f.updatedAt = at; saveFollowUps(list); }
          }
          journal({ kind: 'sent', text: `送信: ${item.label}${item.auto ? '(自動)' : ''}`, caseId: item.caseId, mailId: item.inReplyToMailId, accountEmail: item.accountEmail });
        } else {
          const error = result.error ?? '送信に失敗しました';
          store = updateOutbox(store, item.id, { status: 'failed', error });
          saveOutbox(store);
          if (item.caseId) withCase(item.caseId, (c) => { if (c.status === 'scheduled') c.status = 'open'; });
          journal({ kind: 'error', text: `送信に失敗: ${item.label} — ${error}`, caseId: item.caseId, accountEmail: item.accountEmail });
        }
        pushState();
      }
    } catch (err) {
      host.log(`[partner] outbox tick failed: ${(err as Error).message}`);
    } finally {
      outboxBusy = false;
    }
  }

  interface SendResult { ok: boolean; messageId?: string; error?: string }

  async function sendOne(item: OutboxItem): Promise<SendResult> {
    const smtp = smtpFor(item.accountEmail);
    if (!smtp?.credentials) return { ok: false, error: 'SMTP が未設定です(設定 → 相棒 → アカウントの接続)' };
    let original: QuotedOriginal | null = null;
    let inReplyTo = '';
    let references = '';
    if (item.inReplyToMailId) {
      try {
        const h = getReplyHeaders(item.accountEmail, item.inReplyToMailId);
        if (h) {
          inReplyTo = h.inReplyTo;
          references = h.references;
          original = {
            fromText: h.from ? fmtAddr(h.from) : '',
            dateText: fmtJa(h.date),
            toText: h.to.map(fmtAddr).join(', '),
            subject: h.subject,
            body: h.body,
          };
        }
      } catch (err) {
        host.log(`[partner] reply headers unavailable for ${item.inReplyToMailId}: ${(err as Error).message}`);
      }
    }
    const text = composeBody(item.body, smtp.signature ?? '', original);
    try {
      const out = await sendMail({
        smtp: smtp.credentials,
        from: { name: smtp.displayName || '', address: item.accountEmail },
        to: item.to,
        cc: item.cc,
        subject: item.subject,
        text,
        inReplyTo,
        references,
      });
      // 送信済みへ保存(Gmail は SMTP が自動保存するので不要)、元メールに返信済みの印
      const imap = imapFor(item.accountEmail);
      if (imap) {
        if (!isGmailHost(smtp.credentials.host)) {
          const ap = await appendToSent(imap, out.raw);
          if (!ap.success) host.log(`[partner] append to Sent failed: ${ap.error}`);
        }
        if (item.inReplyToMailId) {
          try { await markAnswered(imap, item.accountEmail, item.inReplyToMailId); } catch { /* best effort */ }
        }
      }
      return { ok: true, messageId: out.messageId };
    } catch (err) {
      return { ok: false, error: friendlySmtpError((err as Error).message) };
    }
  }

  // ---------- 通知 ----------
  function notifyNew(digest: NightlyDigest, prev: NightlyDigest | null): void {
    const settings = host.loadSettings();
    if (!settings.partnerNotify || !Notification.isSupported()) return;
    const prevIds = new Set((prev?.cases ?? []).map((c) => c.id));
    const fresh = (digest.cases ?? []).filter((c) => c.status === 'open' && c.runAt === digest.runAt && !prevIds.has(c.id));
    const p1 = fresh.filter((c) => c.priority === 'P1');
    const decisions = fresh.filter((c) => c.decision && !c.decision.answer);
    if (p1.length === 0 && decisions.length === 0) return;
    const lines: string[] = [];
    for (const c of p1.slice(0, 3)) lines.push(`${c.fromName || c.fromAddress}: ${c.ask || c.subject}`.slice(0, 80));
    if (decisions.length > 0) lines.push(`決めてほしいこと ${decisions.length}件`);
    try {
      const n = new Notification({
        title: p1.length > 0 ? `調: 今日動く案件が${p1.length}件` : '調: 決めてほしいことがあります',
        body: lines.join('\n'),
        silent: true,
      });
      n.on('click', () => host.showWindow());
      n.show();
    } catch (err) {
      host.log(`[partner] notification failed: ${(err as Error).message}`);
    }
  }

  // ---------- スケジューラ ----------
  function clearSchedule(): void {
    if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
    nextRunAt = null;
  }

  function triggerRun(reason: string): void {
    if (!runPipeline || running) return;
    host.log(`[partner] run (${reason})`);
    void runPipeline().catch((err) => host.log(`[partner] run failed: ${(err as Error).message}`));
  }

  function startScheduler(): void {
    clearSchedule();
    const s = host.loadSettings();
    if (!s.butlerEnabled) { pushState(); return; }
    const minutes = Math.max(0, Number(s.partnerIntervalMinutes ?? 30));
    if (minutes > 0) {
      const ms = minutes * 60_000;
      nextRunAt = new Date(Date.now() + ms);
      scheduleTimer = setInterval(() => {
        nextRunAt = new Date(Date.now() + ms);
        triggerRun('interval');
      }, ms);
    }
    // 変わるときだけ触る(未署名アプリでは OS が拒むことがあり、毎回呼ぶとログが汚れる)
    try {
      const want = !!s.partnerLaunchAtLogin;
      if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want, openAsHidden: true });
    } catch (err) {
      host.log(`[partner] login item: ${(err as Error).message}`);
    }
    pushState();
  }

  function attach(run: (opts?: { force?: boolean }) => Promise<NightlyDigest>): void {
    runPipeline = run;
    registerIpc();
    startWatcher();
    ensureTaskCli(host.userDataDir, host.log);
    syncHandoffIndex();
    if (!outboxTimer) outboxTimer = setInterval(() => { void processOutbox(); }, OUTBOX_TICK_MS);
    void processOutbox();
    try {
      powerMonitor.on('resume', () => {
        if (resumeTimer) clearTimeout(resumeTimer);
        resumeTimer = setTimeout(() => triggerRun('resume'), 60_000);
      });
    } catch { /* not available in tests */ }
    // 起動直後に一度(ウィンドウと IPC が落ち着いてから)
    setTimeout(() => { if (host.loadSettings().butlerEnabled) triggerRun('startup'); }, 15_000);
  }

  // ---------- IPC ----------
  function registerIpc(): void {
    ipcMain.handle('partner:getState', () => getState());

    ipcMain.handle('partner:runNow', async () => {
      if (runPipeline && !running) {
        try { await runPipeline({ force: true }); } catch (err) { host.log(`[partner] runNow failed: ${(err as Error).message}`); }
      }
      return getState();
    });

    ipcMain.handle('partner:send', async (_e, params: { caseId: string; body?: string; delayMinutes?: number }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const body = (params.body ?? c.draft ?? '').trim();
      if (!body) return { status: 'error', error: '本文が空です' };
      if (params.body && params.body !== c.draft) { c.draft = params.body; c.draftEdited = true; }
      const settings = host.loadSettings();
      if (!smtpFor(c.accountEmail)) {
        // SMTP 未設定: eM Client の作成画面へ(本文はクリップボード経由ではなく mailto)
        const { to, cc } = buildReplyRecipients(c);
        await host.openCompose({ to: to.map(plainAddress).join(','), cc: cc.map(plainAddress).join(',') || undefined, subject: replySubject(c.subject), body });
        c.status = 'done';
        c.statusChangedAt = new Date().toISOString();
        saveDigest(digest);
        journal({ kind: 'sent', text: `eM Client の作成画面で送信: ${c.fromName || c.fromAddress}「${c.subject.slice(0, 40)}」`, caseId: c.id, accountEmail: c.accountEmail });
        pushState();
        return { status: 'done', fallback: 'compose' };
      }
      const delay = params.delayMinutes ?? settings.partnerSendDelayMinutes ?? 5;
      const item = await enqueueReply(c, body, delay, false);
      c.status = 'scheduled';
      c.outboxId = item.id;
      c.statusChangedAt = new Date().toISOString();
      saveDigest(digest);
      journal({ kind: 'scheduled', text: `送信予定(${delay}分後): ${item.label}`, caseId: c.id, accountEmail: c.accountEmail });
      pushState();
      if (delay <= 0) void processOutbox();
      return { status: 'done', outboxId: item.id };
    });

    ipcMain.handle('partner:cancelSend', (_e, params: { outboxId: string }) => {
      const r = cancel(loadOutbox(), params?.outboxId);
      if (r.error || !r.item) return { status: 'error', error: r.error ?? '取り消せません' };
      saveOutbox(r.store);
      if (r.item.caseId) withCase(r.item.caseId, (c) => { if (c.status === 'scheduled') { c.status = 'open'; c.outboxId = undefined; } });
      if (r.item.followUpId) {
        const list = loadFollowUps();
        const f = list.find((x) => x.id === r.item?.followUpId);
        if (f && f.status === 'nudged') { f.status = 'open'; f.outboxId = undefined; saveFollowUps(list); }
      }
      journal({ kind: 'cancelled', text: `送信を取り消し: ${r.item.label}`, caseId: r.item.caseId, accountEmail: r.item.accountEmail });
      pushState();
      return { status: 'done' };
    });

    ipcMain.handle('partner:sendNow', async (_e, params: { outboxId: string }) => {
      const r = expedite(loadOutbox(), params?.outboxId);
      if (r.error || !r.item) return { status: 'error', error: r.error ?? '送信できません' };
      saveOutbox(r.store);
      pushState();
      await processOutbox();
      const after = loadOutbox().items.find((i) => i.id === params.outboxId);
      if (after?.status === 'failed') return { status: 'error', error: after.error ?? '送信に失敗しました' };
      return { status: 'done' };
    });

    ipcMain.handle('partner:answerDecision', async (_e, params: { caseId: string; answer: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const answer = String(params.answer ?? '').trim();
      if (!answer) return { status: 'error', error: '答えが空です' };
      const now = new Date().toISOString();
      c.decision = { ...(c.decision ?? { question: '', options: [] }), answer, answeredAt: now };
      saveDigest(digest);
      journal({ kind: 'decided', text: `決定: 「${c.subject.slice(0, 30)}」→ ${answer}`, caseId: c.id, accountEmail: c.accountEmail });
      pushState();
      try {
        const settings = host.loadSettings();
        const ctx = host.buildContext(loadRules(host.rulesPath));
        const thread = c.conversationId ? getThreadContext(c.accountEmail, c.conversationId, { maxMessages: 8, maxCharsPerMessage: 1200 }) : null;
        let exemplars: string[] = [];
        try { exemplars = getSentExemplars(c.accountEmail, 3); } catch { /* optional */ }
        const res = await draftReply(host.getRunner(), ctx, {
          subject: c.subject,
          fromName: c.fromName,
          fromAddress: c.fromAddress,
          thread: thread?.messages ?? [],
          exemplars,
          ask: c.ask,
          draftHint: c.draftHint,
          decisionQuestion: c.decision?.question,
          decisionAnswer: answer,
        }, settings.butlerDraftModel || settings.butlerModel || 'sonnet');
        if (!res.ok) return { status: 'error', error: res.error ?? '下書きの生成に失敗しました' };
        withCase(c.id, (cc) => { cc.draft = res.draft; cc.draftStatus = 'prepared'; cc.draftEdited = false; cc.needsDraft = true; });
        pushState();
        return { status: 'done', draft: res.draft };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    ipcMain.handle('partner:saveDraft', (_e, params: { caseId: string; body: string }) => {
      const r = withCase(params?.caseId, (c) => { c.draft = String(params.body ?? ''); c.draftEdited = true; c.draftStatus = 'prepared'; });
      if (r.ok === false) return { status: 'error', error: r.error };
      pushState();
      return { status: 'done' };
    });

    ipcMain.handle('partner:followUpAction', async (_e, params: { id: string; action: 'nudge' | 'snooze' | 'close' | 'draft'; body?: string; days?: number }) => {
      const list = loadFollowUps();
      const f = list.find((x) => x.id === params?.id);
      if (!f) return { status: 'error', error: '返事待ちが見つかりません' };
      const now = new Date();
      if (params.action === 'close') {
        f.status = 'closed'; f.updatedAt = now.toISOString(); saveFollowUps(list);
        journal({ kind: 'closed', text: `返事待ちを閉じました: 「${f.subject.slice(0, 40)}」`, accountEmail: f.accountEmail });
        pushState();
        return { status: 'done' };
      }
      if (params.action === 'snooze') {
        const days = Math.max(1, Number(params.days ?? 3));
        f.status = 'snoozed'; f.snoozeUntil = new Date(now.getTime() + days * 86_400_000).toISOString(); f.updatedAt = now.toISOString(); saveFollowUps(list);
        pushState();
        return { status: 'done' };
      }
      if (params.action === 'draft') {
        try {
          const settings = host.loadSettings();
          const ctx = host.buildContext(loadRules(host.rulesPath));
          let exemplars: string[] = [];
          try { exemplars = getSentExemplars(f.accountEmail, 2); } catch { /* optional */ }
          let myBody = '';
          try { myBody = getReplyHeaders(f.accountEmail, f.mailId)?.body ?? ''; } catch { /* optional */ }
          const res = await draftNudge(host.getRunner(), ctx, {
            subject: f.subject, toName: f.to.split('<')[0].replace(/"/g, '').trim(), toAddress: f.toAddress,
            sentAt: fmtJa(new Date(f.sentAt)), daysWaiting: f.daysWaiting, ask: f.ask, myBody, exemplars, instruction: params.body,
          }, settings.butlerDraftModel || settings.butlerModel || 'sonnet');
          if (!res.ok) return { status: 'error', error: res.error ?? '催促文の生成に失敗しました' };
          f.nudgeDraft = res.draft; f.updatedAt = now.toISOString(); saveFollowUps(list);
          pushState();
          return { status: 'done', draft: res.draft };
        } catch (err) {
          return { status: 'error', error: (err as Error).message };
        }
      }
      // nudge: 送信予定へ
      const body = (params.body ?? f.nudgeDraft ?? '').trim();
      if (!body) return { status: 'error', error: '催促文がありません(先に「催促文を作る」)' };
      const settings = host.loadSettings();
      if (!smtpFor(f.accountEmail)) {
        await host.openCompose({ to: plainAddress(f.toAddress || f.to), subject: replySubject(f.subject), body });
        f.status = 'nudged'; f.updatedAt = now.toISOString(); saveFollowUps(list);
        journal({ kind: 'nudged', text: `eM Client で催促: ${f.to}「${f.subject.slice(0, 40)}」`, accountEmail: f.accountEmail });
        pushState();
        return { status: 'done', fallback: 'compose' };
      }
      const delay = settings.partnerSendDelayMinutes ?? 5;
      const r = enqueue(loadOutbox(), {
        kind: 'nudge', followUpId: f.id, accountEmail: f.accountEmail, to: [f.to || f.toAddress], cc: [],
        subject: replySubject(f.subject), body, inReplyToMailId: f.mailId,
        label: `${f.to.split('<')[0].trim() || f.toAddress} へ催促「${f.subject.slice(0, 40)}」`, auto: false, delayMinutes: delay,
      });
      saveOutbox(prune(r.store));
      f.status = 'nudged'; f.outboxId = r.item.id; f.updatedAt = now.toISOString(); saveFollowUps(list);
      journal({ kind: 'nudged', text: `催促を送信予定(${delay}分後): ${r.item.label}`, accountEmail: f.accountEmail });
      pushState();
      if (delay <= 0) void processOutbox();
      return { status: 'done', outboxId: r.item.id };
    });

    ipcMain.handle('partner:undoTidy', async (_e, params: { groupId: string }) => {
      const digest = loadDigest();
      const g = digest?.groups?.find((x) => x.id === params?.groupId);
      if (!digest || !g) return { status: 'error', error: 'グループが見つかりません' };
      if (g.kind !== 'tidied' || !g.archiveFolder) return { status: 'error', error: '戻せるグループではありません' };
      const imap = imapFor(g.accountEmail);
      if (!imap) return { status: 'error', error: 'IMAP が未設定です' };
      try {
        const results = await restoreToInbox(imap, g.accountEmail, g.items.map((i) => i.mailId), g.archiveFolder);
        const restored = results.filter((r) => r.success).length;
        g.undone = restored > 0;
        if (restored < g.items.length) g.error = `${g.items.length - restored}通は戻せませんでした`;
        saveDigest(digest);
        // 処理済みから外す(次回また案件候補になる。⭐で重要にすれば案件として扱われる)
        const state = host.readJson<{ processed?: Record<string, number[]> }>(STATE_PATH);
        if (state?.processed?.[g.accountEmail]) {
          const ids = new Set(g.items.map((i) => i.mailId));
          state.processed[g.accountEmail] = state.processed[g.accountEmail].filter((id) => !ids.has(id));
          host.writeJson(STATE_PATH, state);
        }
        journal({ kind: 'tidy_undone', text: `片付けを戻しました(${restored}/${g.items.length}通)`, accountEmail: g.accountEmail });
        pushState();
        return restored > 0 ? { status: 'done', restored, error: g.error } : { status: 'error', error: results[0]?.error ?? '戻せませんでした' };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    // ---------- 作業への受け渡し / eM Client の下書き / カレンダー ----------

    ipcMain.handle('partner:draftToEmClient', async (_e, params: { caseId: string; body?: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const body = (params.body ?? c.draft ?? '').trim();
      if (!body) return { status: 'error', error: '本文が空です' };
      if (params.body && params.body !== c.draft) { c.draft = params.body; c.draftEdited = true; saveDigest(digest); }
      const { to, cc } = buildReplyRecipients(c);
      const imap = imapFor(c.accountEmail);
      if (!imap) {
        await host.openCompose({ to: to.map(plainAddress).join(','), cc: cc.map(plainAddress).join(',') || undefined, subject: replySubject(c.subject), body });
        journal({ kind: 'decided', text: `eM Client の作成画面へ: 「${c.subject.slice(0, 40)}」`, caseId: c.id, accountEmail: c.accountEmail });
        return { status: 'done', fallback: 'compose' };
      }
      try {
        let inReplyTo = '';
        let references = '';
        let original: QuotedOriginal | null = null;
        try {
          const h = getReplyHeaders(c.accountEmail, c.mailId);
          if (h) {
            inReplyTo = h.inReplyTo; references = h.references;
            original = { fromText: h.from ? fmtAddr(h.from) : '', dateText: fmtJa(h.date), toText: h.to.map(fmtAddr).join(', '), subject: h.subject, body: h.body };
          }
        } catch { /* optional */ }
        const smtp = (host.loadSettings().smtpConfigs ?? []).find((x) => x.accountEmail === c.accountEmail);
        const { raw } = await buildRawMessage({
          from: { name: smtp?.displayName || '', address: c.accountEmail },
          to, cc, subject: replySubject(c.subject),
          text: composeBody(body, smtp?.signature ?? '', original),
          inReplyTo, references,
        });
        const r = await appendToDrafts(imap, raw);
        if (!r.success) return { status: 'error', error: r.error ?? '下書きに入れられませんでした' };
        try { execFileSync('open', ['-a', 'eM Client'], { timeout: 5000 }); } catch { /* best effort */ }
        journal({ kind: 'decided', text: `eM Client の下書きへ: ${c.fromName || c.fromAddress}「${c.subject.slice(0, 40)}」`, caseId: c.id, accountEmail: c.accountEmail });
        pushState();
        return { status: 'done', folder: r.folder };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    const HANDOFF_DIR = path.join(host.userDataDir, 'handoff');

    function writeHandoffDoc(c: ButlerCase, h: Omit<CaseHandoff, 'docPath' | 'preparedAt' | 'folderExists'>): string {
      fs.mkdirSync(HANDOFF_DIR, { recursive: true });
      const p = path.join(HANDOFF_DIR, `${safeName(c.id)}.md`);
      const lines = [
        `# ${h.title}`,
        '',
        `- 案件: ${c.subject}`,
        `- 相手: ${c.from}`,
        `- 受信: ${c.receivedAt.slice(0, 16).replace('T', ' ')} / 期限: ${c.deadline ?? 'なし'} / 優先度: ${c.priority}`,
        `- 作業フォルダ: ${h.folder ?? '(未定)'}`,
        `- 成果物: ${h.deliverable}`,
        '',
        h.instructions,
        '',
        '---',
        `調(しらべ)が ${new Date().toLocaleString('ja-JP')} に用意。案件 id: ${c.id}`,
      ];
      fs.writeFileSync(p, lines.join('\n'), 'utf-8');
      return p;
    }

    ipcMain.handle('partner:handoffPrepare', async (_e, params: { caseId: string; instruction?: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      try {
        const settings = host.loadSettings();
        const ctx = host.buildContext(loadRules(host.rulesPath));
        const refDir = resolveReferencesDir({ homeDir: os.homedir(), userDataDir: host.userDataDir, referencesDir: settings.partnerReferencesDir || undefined });
        let folderMap = '';
        try { if (refDir) folderMap = fs.readFileSync(path.join(refDir, 'folder-map.md'), 'utf-8').slice(0, 7000); } catch { /* optional */ }
        const recent = (digest.cases ?? []).map((x) => x.handoff?.folder).filter((f): f is string => !!f);
        const thread = c.conversationId ? getThreadContext(c.accountEmail, c.conversationId, { maxMessages: 8, maxCharsPerMessage: 1500 }) : null;
        const res = await prepareHandoff(host.getRunner(), ctx, {
          subject: c.subject, fromName: c.fromName, fromAddress: c.fromAddress, ask: c.ask, summary: c.summary, deadline: c.deadline, category: c.category,
          thread: thread?.messages ?? [], folderMap: params.instruction ? `${folderMap}\n\n## 先生からの追加指示\n${params.instruction}` : folderMap,
          recentFolders: Array.from(new Set(recent)).slice(-8),
        }, settings.butlerModel || 'sonnet');
        if (!res.ok || !res.data) return { status: 'error', error: res.error ?? '作業指示書の生成に失敗しました' };
        const prev = c.handoff;
        const folder = prev?.folder && !params.instruction ? prev.folder : res.data.folder;   // 先生が選んだフォルダは AI で上書きしない
        const handoff: CaseHandoff = {
          folder,
          folderExists: !!folder && fs.existsSync(folder),
          folderReason: res.data.folderReason,
          title: res.data.title,
          instructions: res.data.instructions,
          deliverable: res.data.deliverable,
          docPath: '',
          preparedAt: new Date().toISOString(),
        };
        handoff.docPath = writeHandoffDoc(c, handoff);
        putTaskInQueue(c, handoff);
        withCase(c.id, (cc) => { cc.handoff = handoff; });
        journal({ kind: 'decided', text: `作業指示書を用意: ${handoff.title}${folder ? ` → ${folder}` : ''}`, caseId: c.id, accountEmail: c.accountEmail });
        pushState();
        return { status: 'done', handoff };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    ipcMain.handle('partner:pickFolder', async (_e, params: { caseId: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const win = host.getWindow();
      const opts: Electron.OpenDialogOptions = { title: '作業フォルダを選ぶ', properties: ['openDirectory', 'createDirectory'], defaultPath: c.handoff?.folder && fs.existsSync(c.handoff.folder) ? c.handoff.folder : undefined };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || r.filePaths.length === 0) return { status: 'cancelled' };
      const folder = r.filePaths[0];
      withCase(c.id, (cc) => {
        const base: CaseHandoff = cc.handoff ?? { folder: null, folderExists: false, folderReason: '', title: cc.subject.slice(0, 20), instructions: '', deliverable: '', docPath: '', preparedAt: new Date().toISOString() };
        cc.handoff = { ...base, folder, folderExists: true, folderReason: '先生が選択' };
        if (!cc.handoff.docPath) cc.handoff.docPath = writeHandoffDoc(cc, cc.handoff);
        putTaskInQueue(cc, cc.handoff, cc.handoff.status === 'taken' ? 'taken' : undefined, cc.handoff.takenBy);
      });
      pushState();
      return { status: 'done', folder };
    });

    /** FinderAI と同じ規則で tmux セッション名を作る(finderai-claude-<sha256 先頭6バイト>) */
    function finderAiSessionName(folder: string): string {
      let key = folder;
      try { key = fs.realpathSync(path.resolve(folder)); } catch { /* keep */ }
      key = key.replace(/\/+$/, '') || '/';
      const hex = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
      return `finderai-claude-${hex}`;
    }
    const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => fs.existsSync(p)) ?? null;
    const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    ipcMain.handle('partner:handoffOpen', async (_e, params: { caseId: string; target: HandoffTarget }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const h = c.handoff;
      if (!h) return { status: 'error', error: '先に作業指示書を作ってください' };
      const folder = h.folder && fs.existsSync(h.folder) ? h.folder : null;
      const prompt = `作業指示書 ${h.docPath} を読んで、このフォルダで作業を進めてください。終わったら成果物の場所と、相手への返信文案を短く報告してください。`;
      let detail = '';
      let extra: { cwd?: string; prompt?: string; title?: string } = {};
      try {
        if (params.target === 'app') {
          // アプリ内ターミナル: renderer が pty を作るので、場所と指示だけ返す
          extra = { cwd: folder ?? os.homedir(), prompt, title: h.title || c.subject.slice(0, 20) };
          detail = 'アプリ内ターミナルで Claude Code';
        } else         if (params.target === 'folder') {
          if (!folder) return { status: 'error', error: 'フォルダがありません' };
          shell.showItemInFolder(folder);
          detail = 'Finder で表示';
        } else if (params.target === 'terminal') {
          if (!folder) return { status: 'error', error: 'フォルダを選んでください' };
          const script = `cd ${shq(folder)} && unset CLAUDECODE CLAUDE_CODE && claude ${shq(prompt)}`;
          spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
          detail = 'Terminal で Claude Code を起動';
        } else if (params.target === 'finderai') {
          if (!folder) return { status: 'error', error: 'フォルダを選んでください' };
          if (!fs.existsSync('/Applications/FinderAI.app')) return { status: 'error', error: 'FinderAI がインストールされていません' };
          execFileSync('open', ['-a', 'FinderAI', folder], { timeout: 8000 });
          if (TMUX) {
            const name = finderAiSessionName(folder);
            let exists = false;
            try { execFileSync(TMUX, ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); exists = true; } catch { exists = false; }
            if (exists) {
              // 走っている Claude セッションへ指示を打ち込む
              execFileSync(TMUX, ['send-keys', '-t', `=${name}`, '-l', prompt]);
              execFileSync(TMUX, ['send-keys', '-t', `=${name}`, 'Enter']);
              detail = 'FinderAI の Claude セッションへ指示を送信';
            } else {
              // FinderAI が `new-session -A` で同名に繋ぐので、先に作っておく(Claude タブを開くと続きが出る)
              const cmd = `cd ${shq(folder)}; unset CLAUDECODE CLAUDE_CODE; exec claude ${shq(prompt)}`;
              execFileSync(TMUX, ['new-session', '-d', '-s', name, '-c', folder, '/bin/zsh', '-lc', cmd, ';', 'set-option', 'status', 'off']);
              detail = 'FinderAI で開き、Claude セッションを用意(ドロワーの Claude タブで続きが出ます)';
            }
          } else {
            detail = 'FinderAI で開きました(tmux が無いので指示は手で貼ってください)';
          }
        } else {
          return { status: 'error', error: '不明な出口です' };
        }
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
      withCase(c.id, (cc) => {
        if (cc.handoff) {
          cc.handoff.lastOpenedAt = new Date().toISOString();
          cc.handoff.lastTarget = params.target;
          if (params.target !== 'folder') putTaskInQueue(cc, cc.handoff, 'taken', params.target);
        }
      });
      journal({ kind: 'decided', text: `作業へ: ${detail} — 「${c.subject.slice(0, 40)}」`, caseId: c.id, accountEmail: c.accountEmail });
      pushState();
      return { status: 'done', detail, ...extra };
    });

    ipcMain.handle('partner:handoffCopy', (_e, params: { caseId: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const h = c.handoff;
      if (!h) return { status: 'error', error: '先に作業指示書を作ってください' };
      const text = [
        `調からの作業指示: ${h.title}`,
        `作業フォルダ: ${h.folder ?? '(未定。今いる場所で)'}`,
        `指示書ファイル: ${h.docPath}`,
        `成果物: ${h.deliverable}`,
        '',
        'まず下の指示書を読み、作業を進めてください。終わったら成果物の場所と、相手への返信文案を短く報告してください。',
        '',
        '---',
        h.instructions,
      ].join('\n');
      clipboard.writeText(text);
      withCase(c.id, (cc) => { if (cc.handoff) putTaskInQueue(cc, cc.handoff, 'taken', 'clipboard'); });
      journal({ kind: 'decided', text: `作業指示をコピー: ${h.title}`, caseId: c.id, accountEmail: c.accountEmail });
      pushState();
      return { status: 'done', text };
    });

    ipcMain.handle('partner:calendarCopy', async (_e, params: { caseId: string; target: 'chatgpt' | 'clipboard' }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      const ev = c.event;
      if (!ev) return { status: 'error', error: 'この案件には予定が見つかっていません' };
      const when = ev.allDay
        ? `${ev.start}${ev.end && ev.end !== ev.start ? `〜${ev.end}` : ''}(終日)`
        : `${ev.start.replace('T', ' ')}${ev.end ? `〜${ev.end.includes('T') && ev.end.slice(0, 10) === ev.start.slice(0, 10) ? ev.end.slice(11) : ev.end.replace('T', ' ')}` : ''}`;
      const text = [
        '次の予定をカレンダーに登録してください。',
        `件名: ${ev.title}`,
        `日時: ${when}`,
        ev.location ? `場所: ${ev.location}` : null,
        `メモ: ${c.summary}`,
        `出典: ${c.fromName || c.fromAddress} からのメール「${c.subject}」`,
      ].filter(Boolean).join('\n');
      clipboard.writeText(text);
      let opened = false;
      if (params.target === 'chatgpt') {
        try {
          if (fs.existsSync('/Applications/ChatGPT.app')) { execFileSync('open', ['-a', 'ChatGPT'], { timeout: 8000 }); opened = true; }
          else { await shell.openExternal('https://chatgpt.com/'); opened = true; }
        } catch (err) {
          host.log(`[partner] open ChatGPT failed: ${(err as Error).message}`);
        }
      }
      journal({ kind: 'decided', text: `予定の文面をコピー${opened ? '(ChatGPT を開いた)' : ''}: ${ev.title}`, caseId: c.id, accountEmail: c.accountEmail });
      return { status: 'done', text, opened };
    });

    ipcMain.handle('partner:addToCalendar', async (_e, params: { caseId: string; target?: 'google' | 'emclient' | 'chatgpt' }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      if (!c.event) return { status: 'error', error: 'この案件には予定が見つかっていません' };
      const settings = host.loadSettings();
      const target = params.target ?? settings.calendarTarget ?? 'google';
      const description = `${c.summary}\n\n差出人: ${c.from}\n件名: ${c.subject}`;
      try {
        if (target === 'google' && google.status().connected) {
          const r = await insertCaseEvent(c, false);
          pushState();
          return { status: 'done', target, inserted: true, link: r.htmlLink, account: google.status().email };
        }
        if (target === 'google') {
          const account = settings.calendarGoogleAccount || host.defaultCalendarAccount();
          const url = googleCalendarTemplateUrl({ ...c.event, description }, account || undefined);
          await shell.openExternal(url);
          journal({ kind: 'decided', text: `Google カレンダーの登録画面を開いた: ${c.event.title}(${c.event.start})${account ? ` → ${account}` : ''}`, caseId: c.id, accountEmail: c.accountEmail });
          return { status: 'done', target, url, account };
        }
        if (target === 'chatgpt') {
          return { status: 'error', error: 'ChatGPT への登録は「ChatGPT で登録」ボタンから' };
        }
        const dir = path.join(host.userDataDir, 'calendar');
        fs.mkdirSync(dir, { recursive: true });
        const p = path.join(dir, `${safeName(c.id)}.ics`);
        fs.writeFileSync(p, buildIcs({ ...c.event, description }), 'utf-8');
        try { execFileSync('open', ['-a', 'eM Client', p], { timeout: 8000 }); } catch { await shell.openPath(p); }
        journal({ kind: 'decided', text: `eM Client で予定登録を開始: ${c.event.title}(${c.event.start})`, caseId: c.id, accountEmail: c.accountEmail });
        return { status: 'done', target: 'emclient', path: p };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    ipcMain.handle('partner:removeFromCalendar', async (_e, params: { caseId: string }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === params?.caseId);
      if (!digest || !c) return { status: 'error', error: '案件が見つかりません' };
      if (!c.calendarEventId || !c.calendarEventCalendarId) return { status: 'error', error: '相棒が登録した予定ではありません' };
      try {
        await google.deleteEvent(c.calendarEventCalendarId, c.calendarEventId);
        withCase(c.id, (cc) => { cc.calendarStatus = 'missing'; cc.calendarMatch = undefined; cc.calendarEventId = undefined; cc.calendarEventCalendarId = undefined; cc.calendarEventLink = undefined; });
        journal({ kind: 'cancelled', text: `Google カレンダーから取り消し: ${c.event?.title ?? c.subject}`, caseId: c.id, accountEmail: c.accountEmail });
        pushState();
        return { status: 'done' };
      } catch (err) {
        return { status: 'error', error: (err as Error).message };
      }
    });

    ipcMain.handle('google:status', () => google.status());
    ipcMain.handle('google:connect', async (_e, params: { clientId: string; clientSecret: string; loginHint?: string }) => {
      try {
        const st = await google.connect(params?.clientId ?? '', params?.clientSecret ?? '', params?.loginHint);
        journal({ kind: 'decided', text: `Google カレンダーとつないだ: ${st.email}` });
        host.showWindow();
        return { status: 'done', google: st };
      } catch (err) {
        host.showWindow();
        return { status: 'error', error: (err as Error).message };
      }
    });
    ipcMain.handle('google:disconnect', () => { google.disconnect(); journal({ kind: 'decided', text: 'Google カレンダーとの接続を解除' }); return google.status(); });
    ipcMain.handle('google:calendars', async () => {
      try { return { status: 'done', calendars: await google.listCalendars() }; } catch (err) { return { status: 'error', error: (err as Error).message }; }
    });
    ipcMain.handle('google:setCalendar', (_e, calendarId: string) => { google.setCalendar(String(calendarId ?? '')); return google.status(); });

    ipcMain.handle('partner:discoverAccounts', (): AccountEndpoints[] => {
      const settings = host.loadSettings();
      const found = discoverAccountEndpoints(settings.selectedAccounts.length ? settings.selectedAccounts : undefined);
      for (const e of found) {
        try { if (!e.displayName) e.displayName = getMyDisplayName(e.accountEmail); } catch { /* optional */ }
        try { e.signature = guessSignature(e.accountEmail); } catch { /* optional */ }
      }
      return found;
    });

    ipcMain.handle('partner:testConnection', async (_e, params: { kind: 'imap' | 'smtp'; credentials: ImapCredentials | SmtpCredentials }) => {
      if (!params?.credentials?.host) return { success: false, error: 'ホストが空です' };
      if (params.kind === 'smtp') return verifySmtp(params.credentials as SmtpCredentials);
      const r = await testImap(params.credentials as ImapCredentials);
      return { success: r.success, error: r.error };
    });

    ipcMain.handle('partner:getProfile', () => {
      let content = '';
      try { if (fs.existsSync(PROFILE_PATH)) content = fs.readFileSync(PROFILE_PATH, 'utf-8'); } catch { /* ignore */ }
      if (!content.trim()) content = DEFAULT_PROFILE;
      let sources: string[] = [];
      try { sources = host.buildContext(loadRules(host.rulesPath)).sources; } catch { /* ignore */ }
      return { content, path: PROFILE_PATH, sources };
    });

    ipcMain.handle('partner:saveProfile', (_e, content: string) => {
      fs.writeFileSync(PROFILE_PATH, String(content ?? ''), 'utf-8');
      journal({ kind: 'decided', text: '相棒への申し送り(人物像・ルール)を更新' });
      pushState();
    });
  }

  // ---------- パイプラインへ渡す手足 ----------
  function pipelineDeps(): ReturnType<Partner['pipelineDeps']> {
    return {
      canTidy: (accountEmail) => !!imapFor(accountEmail),
      tidy: async (accountEmail, mailIds) => {
        const imap = imapFor(accountEmail);
        if (!imap) return { done: [], archiveFolder: null, error: 'IMAP 未設定' };
        const r = await tidyToArchive(imap, accountEmail, mailIds);
        const done = r.results.filter((x) => x.success).map((x) => x.mailId);
        const firstErr = r.results.find((x) => !x.success)?.error;
        return { done, archiveFolder: r.archiveFolder, error: done.length === 0 ? firstErr : undefined };
      },
      canSend: (accountEmail) => !!smtpFor(accountEmail),
      enqueueSend: async (c, body) => {
        const settings = host.loadSettings();
        const item = await enqueueReply(c, body, Math.max(2, settings.partnerSendDelayMinutes ?? 5), true);
        return item.id;
      },
      getWaitingThreads: (accountEmail, opts) => getWaitingThreads(accountEmail, opts),
      judgeFollowUps: (ctx, inputs, model) => judgeFollowUps(host.getRunner(), ctx, inputs, model),
      followUpsPath: FOLLOWUPS_PATH,
      journal,
      autoAddEvent: async (c) => {
        if (!host.loadSettings().calendarAutoAdd || !google.status().connected || !c.event) return false;
        try { await insertCaseEvent(c, true); return true; } catch (err) { host.log(`[google] auto add failed: ${(err as Error).message}`); return false; }
      },
    };
  }

  return {
    pipelineDeps,
    attach,
    setRunning: (r) => { running = r; if (!r) progress = null; pushState(); },
    setProgress: (p) => { progress = p; pushState(); },
    afterRun: (digest, prev) => { notifyNew(digest, prev); pushState(); },
    startScheduler,
    reschedule: startScheduler,
    getState,
    stop: () => {
      clearSchedule();
      if (outboxTimer) { clearInterval(outboxTimer); outboxTimer = null; }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      if (watcher) { watcher.close(); watcher = null; }
      if (handoffWatcher) { handoffWatcher.close(); handoffWatcher = null; }
    },
  };
}
