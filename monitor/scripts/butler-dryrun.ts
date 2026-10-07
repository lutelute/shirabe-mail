// 夜間執事 v2 のドライラン(実DBを読み取り専用で読み、Claude CLI を実際に呼ぶ。書き込みはしない)
// 使い方: npm run butler:dryrun -- [account] [days] [maxCases] [maxDrafts]
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runButlerPipeline } from '../electron/services/pipeline';
import type { PipelineDeps } from '../electron/services/pipeline';
import { getCandidateMails, getSenderStats, getThreadContext, getMailBodies, getSentExemplars, getWaitingThreads } from '../electron/services/mail-intel';
import { getAccounts, getEvents } from '../electron/services/db-reader';
import { createClaudeRunner } from '../electron/services/claude-runner';
import { buildJudgmentContext, classifyCases, draftReply, writeBrief, judgeFollowUps } from '../electron/services/butler-brain';
import { loadRules } from '../electron/services/butler-rules';
import { DEFAULT_SETTINGS } from '../src/types/index';
import type { AppSettings, NightlyDigest } from '../src/types/index';

const [account = 'lute@u-fukui.ac.jp', daysArg = '7', maxCasesArg = '12', maxDraftsArg = '2', modeArg = 'assist'] = process.argv.slice(2);
const OUT_DIR = process.env.BUTLER_DRYRUN_DIR || path.join(os.tmpdir(), 'shirabe-butler-dryrun');
fs.mkdirSync(OUT_DIR, { recursive: true });

function findCli(): string {
  for (const p of [path.join(os.homedir(), '.local/bin/claude'), path.join(os.homedir(), '.claude/bin/claude'), '/usr/local/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

const settings: AppSettings = {
  ...DEFAULT_SETTINGS,
  butlerEnabled: true,
  selectedAccounts: [account],
  butlerAccounts: [account],
  butlerInitialDays: Number(daysArg),
  butlerMaxCasesPerRun: Number(maxCasesArg),
  butlerMaxDraftsPerRun: Number(maxDraftsArg),
  butlerMaxPerAccount: 150,
  partnerMode: (modeArg === 'delegate' || modeArg === 'observe') ? modeArg : 'assist',
};

const runner = createClaudeRunner({
  cliPath: findCli(),
  env: process.env as Record<string, string>,
  workDir: path.join(OUT_DIR, 'cwd'),
  concurrency: 3,
  log: (m) => console.error(m),
  getEffort: () => settings.butlerEffort || 'xhigh',
});

const statsCache = new Map<string, ReturnType<typeof getSenderStats>>();
const deps: PipelineDeps = {
  loadSettings: () => settings,
  loadRules: () => loadRules(path.join(OUT_DIR, 'butler-rules.json')),
  buildContext: (rules) => buildJudgmentContext({ homeDir: os.homedir(), userDataDir: OUT_DIR }, rules, getAccounts().map((a) => a.email)),
  getCandidates: (acct, q) => getCandidateMails(acct, { ...q, unreadOnly: q.unreadOnly ?? true }),
  getSenderStats: (acct) => {
    let s = statsCache.get(acct);
    if (!s) { s = getSenderStats(acct, 400); statsCache.set(acct, s); }
    return s;
  },
  getThread: (acct, conv) => getThreadContext(acct, conv, { maxMessages: 8, maxCharsPerMessage: 1200 }),
  getBodies: (acct, ids) => getMailBodies(acct, ids, 1500),
  getExemplars: (acct) => getSentExemplars(acct, 3),
  classify: (ctx, inputs, model, onProgress) => classifyCases(runner, ctx, inputs, model, { batchSize: 6, onProgress }),
  draft: (ctx, params, model) => draftReply(runner, ctx, params, model),
  brief: (input, model) => writeBrief(runner, input, model),
  moveToQuarantine: async () => ({ success: false, error: 'dry-run' }),
  hasImapCredentials: () => false,
  getNote: () => null,
  saveNote: () => undefined,
  butlerStatePath: path.join(OUT_DIR, 'butler-state.json'),
  digestPath: path.join(OUT_DIR, 'nightly-digest.json'),
  readJson: <T,>(p: string): T | null => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; } },
  writeJson: (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2)),
  onProgress: (p) => console.error(`[progress] ${p.stage}: ${p.message}`),
  log: (m) => console.error(m),
  dryRun: true,
  // v3: 返事待ち(読むだけ)。片付け・送信予定はドライランでは無効
  getWaitingThreads: (acct, opts) => getWaitingThreads(acct, opts),
  judgeFollowUps: async (ctx, inputs, model) => {
    const r = await judgeFollowUps(runner, ctx, inputs, model);
    const byId = new Map(inputs.map((i) => [i.id, i]));
    console.log(`\n=== 返事待ちの判定(${inputs.length}件) ===`);
    for (const j of r.judgments.values()) {
      const i = byId.get(j.id);
      console.log(`[${j.needsReply ? 'WAIT' : 'no'}][${j.urgency}][nudge=${j.nudgeOk}] ${i?.daysWaiting}日 ${i?.toText.slice(0, 40)}「${i?.subject.slice(0, 50)}」\n  ask: ${j.ask}\n  ${j.summary}`);
    }
    return r;
  },
  followUpsPath: path.join(OUT_DIR, 'followups.json'),
  getCalendarEvents: (acct, days) => getEvents(acct, days),
  journal: (e) => console.error(`[journal] ${e.kind}: ${e.text}`),
};

const t0 = Date.now();
runButlerPipeline(deps, { force: true }).then((digest: NightlyDigest) => {
  fs.writeFileSync(path.join(OUT_DIR, 'digest-dryrun.json'), JSON.stringify(digest, null, 2));
  console.log(`\n=== 申し送り ===\n${digest.brief}\n`);
  console.log(`=== 統計 === ${JSON.stringify(digest.stats)} 所要 ${(Date.now() - t0) / 1000}s`);
  for (const g of digest.groups ?? []) console.log(`[group:${g.kind}] ${g.label} ${g.items.length}通 — ${g.reason}`);
  console.log('\n=== 案件 ===');
  for (const c of digest.cases ?? []) {
    console.log(`\n[${c.priority}][${c.category}][${c.senderTier}/${c.addressedToMe}] ${c.subject.slice(0, 60)}\n  from: ${c.from.slice(0, 60)}  thread=${c.threadCount}/my=${c.myRepliesInThread}/lastFromMe=${c.lastFromMe}\n  ask: ${c.ask}\n  deadline: ${c.deadline}  action: ${c.suggestedAction}  draft: ${c.needsDraft}${c.draftStatus ? `(${c.draftStatus})` : ''}  kind=${c.replyKind} scope=${c.replyScope} autoSendSafe=${c.autoSendSafe}\n  summary: ${c.summary}\n  reason: ${c.reason}${c.draftHint ? `\n  hint: ${c.draftHint}` : ''}${c.decision ? `\n  ❓ ${c.decision.question} [${c.decision.options.join(' / ')}]` : ''}${c.event ? `\n  📅 ${c.event.title} ${c.event.start}${c.event.end ? `〜${c.event.end}` : ''} [${c.event.kind}] → ${c.calendarStatus}${c.calendarMatch ? `(=${c.calendarMatch})` : ''}` : ''}`);
    if (c.draft) console.log(`  --- 下書き ---\n${c.draft.split('\n').map((l) => '  | ' + l).join('\n')}`);
  }
  try {
    const fus = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'followups.json'), 'utf-8')) as Array<{ status: string; to: string; subject: string; daysWaiting: number; ask: string; summary: string }>;
    console.log(`\n=== 返事待ち(${fus.filter((f) => f.status === 'open').length}件 open / ${fus.length}件) ===`);
    for (const f of fus) console.log(`[${f.status}] ${f.daysWaiting}日 ${f.to.slice(0, 40)}「${f.subject.slice(0, 50)}」\n  ask: ${f.ask}\n  ${f.summary}`);
  } catch { /* none */ }
  if (digest.errors.length) console.log('\n=== errors ===\n' + digest.errors.join('\n'));
  console.log(`\n(digest saved: ${path.join(OUT_DIR, 'digest-dryrun.json')})`);
}).catch((e) => { console.error(e); process.exit(1); });
