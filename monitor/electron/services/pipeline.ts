// === Night Butler pipeline ===
//
// Runs the "夜間執事" automatic pipeline: for each newly-arrived unread mail it
// performs only *reversible* actions automatically (tagging, quarantining spam
// into a folder, preparing reply drafts) and queues *irreversible* actions
// (delete / send) for the user's approval. It NEVER deletes or sends on its own.
//
// To avoid circular imports with main.ts (where the Claude CLI spawn, settings
// loader and note storage live as closures) this module takes its collaborators
// via a dependency object. main.ts wires the existing functions in.

import type {
  AppSettings,
  MailItem,
  MailNote,
  NightlyDigest,
  ButlerEntry,
  TriageResult,
  ThreadMessage,
  JunkClassification,
} from '../../src/types/index';

// --- Injected collaborators (all reuse existing main.ts / service code) ---
export interface PipelineDeps {
  loadSettings: () => AppSettings;
  // db-reader.getMails
  getMails: (accountEmail: string, daysBack: number) => MailItem[];
  // junk-detector.detectJunkWithAI / detectJunkByKeywords
  detectJunk: (mails: MailItem[], apiKey: string) => Promise<JunkClassification[]>;
  // claude-agent.triageEmails — returns results + accumulated cost
  triage: (
    mails: MailItem[],
    apiKey: string,
  ) => Promise<{ results: TriageResult[]; costUsd: number; error: string | null }>;
  // main.getThreadMessagesFromDb
  getThreadMessages: (mailId: number, accountEmail: string) => ThreadMessage[];
  // main.generateReplyDraft (Claude CLI based)
  generateReplyDraft: (params: {
    threadMessages: ThreadMessage[];
    mail: MailItem;
  }) => Promise<{ status: string; draft: string; error?: string }>;
  // Move a mail into the quarantine folder over IMAP (reversible).
  // Returns true on success. Implemented in main via imap-operations.moveToFolder.
  moveToQuarantine: (
    mailId: number,
    accountEmail: string,
    folderName: string,
  ) => Promise<{ success: boolean; error?: string }>;
  // Note persistence — reuse main's notes dir helpers.
  getNote: (noteId: string) => MailNote | null;
  saveNote: (note: MailNote) => void;
  // Persistence paths for butler state / digest.
  butlerStatePath: string;
  digestPath: string;
  // fs primitives (passed so this module stays free of direct fs imports in tests).
  readJson: <T>(filePath: string) => T | null;
  writeJson: (filePath: string, data: unknown) => void;
}

// --- Helpers ---

function noteIdForMail(mailId: number): string {
  return `mail-${mailId}`;
}

function fromText(mail: MailItem): string {
  const a = mail.from;
  if (!a) return '不明';
  return a.displayName ? `${a.displayName} <${a.address}>` : a.address;
}

// Map a triage classification to a butler tag id (reuses the BUILTIN_TAGS ids).
function tagsForTriage(t: TriageResult): string[] {
  const tags: string[] = [];
  if (t.classification === 'reply') tags.push('reply');
  else tags.push('action');
  // High relevance → also flag as urgent so it surfaces in the UI.
  if (t.relevanceScore >= 0.8) tags.push('urgent');
  return tags;
}

// Persist tags onto the mail's note (create note if missing). Mirrors the
// note-writing behaviour of main.autoTagMails so the UI shows the same data.
function recordTags(
  deps: PipelineDeps,
  mail: MailItem,
  tags: string[],
  reason: string,
): void {
  const id = noteIdForMail(mail.id);
  const now = new Date().toISOString();
  const existing = deps.getNote(id);
  const note: MailNote = existing
    ? {
        ...existing,
        tags,
        history: [
          ...(existing.history ?? []),
          { timestamp: now, type: 'updated', content: `夜間執事: ${reason}` },
        ],
        updatedAt: now,
      }
    : {
        id,
        mailId: mail.id,
        accountEmail: mail.accountEmail,
        subject: mail.subject,
        content: '',
        todos: [],
        tags,
        history: [{ timestamp: now, type: 'created', content: `夜間執事: ${reason}` }],
        createdAt: now,
        updatedAt: now,
      };
  deps.saveNote(note);
}

// Persist a prepared reply draft into the mail's note body.
function recordDraft(deps: PipelineDeps, mail: MailItem, draft: string): void {
  const id = noteIdForMail(mail.id);
  const now = new Date().toISOString();
  const existing = deps.getNote(id);
  const draftBlock = `## 夜間執事の返信下書き (${now})\n\n${draft}`;
  const note: MailNote = existing
    ? {
        ...existing,
        content: existing.content
          ? `${existing.content}\n\n${draftBlock}`
          : draftBlock,
        history: [
          ...(existing.history ?? []),
          { timestamp: now, type: 'ai_proposal', content: '返信下書きを用意しました' },
        ],
        updatedAt: now,
      }
    : {
        id,
        mailId: mail.id,
        accountEmail: mail.accountEmail,
        subject: mail.subject,
        content: draftBlock,
        todos: [],
        tags: ['reply'],
        history: [{ timestamp: now, type: 'ai_proposal', content: '返信下書きを用意しました' }],
        createdAt: now,
        updatedAt: now,
      };
  deps.saveNote(note);
}

// --- Butler state (processed mail ids per account) ---
interface ButlerState {
  // accountEmail -> processed mail ids
  processed: Record<string, number[]>;
}

function loadState(deps: PipelineDeps): ButlerState {
  const raw = deps.readJson<ButlerState>(deps.butlerStatePath);
  if (raw && typeof raw === 'object' && raw.processed) return raw;
  return { processed: {} };
}

function saveState(deps: PipelineDeps, state: ButlerState): void {
  deps.writeJson(deps.butlerStatePath, state);
}

const EMPTY_DIGEST = (): NightlyDigest => ({
  runAt: new Date().toISOString(),
  processedCount: 0,
  autoDone: [],
  awaitingApproval: [],
  errors: [],
  costUsd: 0,
});

// --- Main entry ---
export async function runButlerPipeline(
  deps: PipelineDeps,
  opts?: { force?: boolean },
): Promise<NightlyDigest> {
  const settings = deps.loadSettings();

  // Disabled and not forced → no-op empty digest (do not persist).
  if (!settings.butlerEnabled && !opts?.force) {
    return EMPTY_DIGEST();
  }

  const digest: NightlyDigest = EMPTY_DIGEST();
  const apiKey = settings.apiKey ?? '';
  const budget = settings.butlerMaxBudgetUsdPerRun ?? 0.5;
  const quarantineFolder = settings.butlerQuarantineFolder || '隔離';
  const autoThreshold = settings.butlerAutoQuarantineThreshold ?? 0.95;
  // Mid-confidence spam band: between this and the auto threshold → ask before deleting.
  const SUSPECT_THRESHOLD = 0.6;

  const baseAccounts =
    settings.selectedAccounts && settings.selectedAccounts.length > 0
      ? settings.selectedAccounts
      : [];
  // 夜間執事の対象アカウント: butlerAccounts が指定されていればそれで絞る(空=全選択アカウント)。
  // 「仕事用アカウントだけ任せ、プライベートは手動」を実現するための絞り込み。
  const accounts =
    settings.butlerAccounts && settings.butlerAccounts.length > 0
      ? baseAccounts.filter((a) => settings.butlerAccounts.includes(a))
      : baseAccounts;

  const state = loadState(deps);
  let budgetExhausted = false;

  for (const accountEmail of accounts) {
    if (budgetExhausted) break;

    // New unread mail for this account (mailDaysBack window).
    let mails: MailItem[] = [];
    try {
      const all = deps.getMails(accountEmail, settings.mailDaysBack ?? 7);
      const seen = new Set(state.processed[accountEmail] ?? []);
      const fresh = all.filter((m) => !m.isRead && !seen.has(m.id));
      // 1アカウント・1回あたりの上限（IMAP負荷対策）。超過分は次回の実行で処理する。
      const maxPerAccount = settings.butlerMaxPerAccount ?? 100;
      mails = fresh.slice(0, maxPerAccount);
    } catch (err) {
      digest.errors.push(
        `${accountEmail}: 新着取得に失敗 — ${(err as Error).message}`,
      );
      continue;
    }

    if (mails.length === 0) continue;

    // Junk pass for the whole account batch (one AI call covers all).
    let junkMap = new Map<number, JunkClassification>();
    try {
      const junk = await deps.detectJunk(mails, apiKey);
      junkMap = new Map(junk.map((j) => [j.mailId, j]));
    } catch (err) {
      digest.errors.push(
        `${accountEmail}: ジャンク判定に失敗 — ${(err as Error).message}`,
      );
    }

    // Triage non-spam mails in one batch (cost-controlled, haiku-class agent).
    const nonSpam = mails.filter((m) => {
      const j = junkMap.get(m.id);
      return !(j && j.isJunk && j.confidence >= SUSPECT_THRESHOLD);
    });

    let triageMap = new Map<number, TriageResult>();
    if (nonSpam.length > 0 && apiKey) {
      if (digest.costUsd >= budget) {
        budgetExhausted = true;
      } else {
        try {
          const { results, costUsd, error } = await deps.triage(nonSpam, apiKey);
          digest.costUsd += costUsd;
          triageMap = new Map(results.map((r) => [r.mailId, r]));
          if (error) digest.errors.push(`${accountEmail}: トリアージ — ${error}`);
          if (digest.costUsd >= budget) budgetExhausted = true;
        } catch (err) {
          digest.errors.push(
            `${accountEmail}: トリアージに失敗 — ${(err as Error).message}`,
          );
        }
      }
    }

    // Process each mail sequentially.
    for (const mail of mails) {
      // Stop accepting *new* paid work once the budget is spent, but still mark
      // the mail processed below so we don't reprocess endlessly.
      const junk = junkMap.get(mail.id);

      let entry: ButlerEntry | null = null;

      if (junk && junk.isJunk && junk.confidence >= autoThreshold) {
        // (a) High-confidence spam → quarantine (reversible move).
        const mv = await deps.moveToQuarantine(mail.id, accountEmail, quarantineFolder);
        if (mv.success) {
          entry = {
            mailId: mail.id,
            accountEmail,
            subject: mail.subject,
            from: fromText(mail),
            kind: 'quarantined',
            reversible: true,
            detail: `スパムと判定(確度${Math.round(junk.confidence * 100)}%) → 「${quarantineFolder}」へ移動。${junk.reasoning}`,
            confidence: junk.confidence,
            createdAt: new Date().toISOString(),
          };
          digest.autoDone.push(entry);
        } else {
          // Move failed → fall back to an approval-gated delete suggestion.
          entry = {
            mailId: mail.id,
            accountEmail,
            subject: mail.subject,
            from: fromText(mail),
            kind: 'await_delete',
            reversible: false,
            detail: `スパム疑い(確度${Math.round(junk.confidence * 100)}%)だが隔離移動に失敗(${mv.error ?? '不明'})。削除を承認しますか？`,
            confidence: junk.confidence,
            createdAt: new Date().toISOString(),
          };
          digest.awaitingApproval.push(entry);
        }
      } else if (junk && junk.isJunk && junk.confidence >= SUSPECT_THRESHOLD) {
        // (a) Mid-confidence spam → propose deletion, await approval (no action).
        entry = {
          mailId: mail.id,
          accountEmail,
          subject: mail.subject,
          from: fromText(mail),
          kind: 'await_delete',
          reversible: false,
          detail: `スパムの疑い(確度${Math.round(junk.confidence * 100)}%)。${junk.reasoning} 削除を承認しますか？`,
          confidence: junk.confidence,
          createdAt: new Date().toISOString(),
        };
        digest.awaitingApproval.push(entry);
      } else {
        // Non-spam → triage-driven tag + optional reply draft.
        const tri = triageMap.get(mail.id);
        const tags = tri ? tagsForTriage(tri) : ['info'];
        recordTags(
          deps,
          mail,
          tags,
          tri
            ? `${tri.classification} (関連度${Math.round(tri.relevanceScore * 100)}%)`
            : 'タグ付け',
        );
        entry = {
          mailId: mail.id,
          accountEmail,
          subject: mail.subject,
          from: fromText(mail),
          kind: 'tagged',
          reversible: true,
          detail: tri
            ? `${tri.classification === 'reply' ? '要返信' : '要対応'}に分類。${tri.reasoning}`
            : 'タグを付与しました。',
          tags,
          confidence: tri?.relevanceScore,
          createdAt: new Date().toISOString(),
        };
        digest.autoDone.push(entry);

        // (b/c) Reply-class mail → prepare a draft (reversible), and queue an
        // await_send so the user can choose to actually send it.
        if (tri && tri.classification === 'reply' && apiKey && !budgetExhausted) {
          if (digest.costUsd >= budget) {
            budgetExhausted = true;
          } else {
            try {
              const threadMessages = deps.getThreadMessages(mail.id, accountEmail);
              const dr = await deps.generateReplyDraft({ threadMessages, mail });
              if (dr.status === 'done' && dr.draft) {
                recordDraft(deps, mail, dr.draft);
                // draft_prepared: reversible record that a draft exists.
                digest.autoDone.push({
                  mailId: mail.id,
                  accountEmail,
                  subject: mail.subject,
                  from: fromText(mail),
                  kind: 'draft_prepared',
                  reversible: true,
                  detail: '返信下書きをノートに保存しました(未送信)。',
                  draft: dr.draft,
                  createdAt: new Date().toISOString(),
                });
                // await_send: irreversible action gated on approval, draft attached.
                digest.awaitingApproval.push({
                  mailId: mail.id,
                  accountEmail,
                  subject: mail.subject,
                  from: fromText(mail),
                  kind: 'await_send',
                  reversible: false,
                  detail: '返信を送信しますか？(承認すると下書き付きの作成フォームを開きます)',
                  draft: dr.draft,
                  createdAt: new Date().toISOString(),
                });
              }
            } catch (err) {
              digest.errors.push(
                `${accountEmail} #${mail.id}: 下書き生成に失敗 — ${(err as Error).message}`,
              );
            }
          }
        }
      }

      // Mark processed regardless of outcome so the same mail isn't reprocessed.
      const arr = state.processed[accountEmail] ?? [];
      if (!arr.includes(mail.id)) arr.push(mail.id);
      state.processed[accountEmail] = arr;
      digest.processedCount += 1;

      if (budgetExhausted) {
        digest.errors.push(
          `課金上限($${budget})に達したため以降の処理を中断しました。`,
        );
        break;
      }
    }
  }

  // Persist state + digest.
  saveState(deps, state);
  deps.writeJson(deps.digestPath, digest);

  return digest;
}
