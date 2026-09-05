// 夜間執事 v2 の純関数テスト(node --test で実行。esbuild でバンドルして走らせる)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBody } from '../mail-intel';
import { tierFor, looksLikeBulk, looksLikeSpam, normalizeDeadline, buildClassifyPrompt, fallbackBrief, DEFAULT_PROFILE } from '../butler-brain';
import type { JudgmentContext, CaseInput } from '../butler-brain';
import { withSenderRule, tierFromRules, EMPTY_RULES } from '../butler-rules';
import { bumpPriorityByDeadline, tagsFor, sortCases, mergeCarryOver, addressedToMe, runButlerPipeline, noteIdFor } from '../pipeline';
import type { PipelineDeps } from '../pipeline';
import type { CandidateMail } from '../mail-intel';
import { extractJson } from '../claude-runner';
import { DEFAULT_SETTINGS } from '../../../src/types/index';
import type { ButlerCase, AppSettings, MailNote } from '../../../src/types/index';
import { AddressType } from '../../../src/types/index';

const ctx: JudgmentContext = {
  today: '2026-09-05',
  profile: DEFAULT_PROFILE,
  decisionRules: '',
  contacts: '| 河合 | 研究推進課 | | t-kawai@u-fukui.ac.jp |',
  contactAddresses: new Set(['t-kawai@u-fukui.ac.jp', 'itomasa@u-fukui.ac.jp']),
  learnedRules: '',
  myAddresses: ['lute@u-fukui.ac.jp'],
  sources: [],
};

// ---------- cleanBody ----------
test('cleanBody strips quoted reply and signature', () => {
  const raw = [
    '重信先生', '', 'お世話になっております。界です。', '日程調整ありがとうございました。', '',
    'On 2026/09/03 23:38, SHIGENOBU Ryuto wrote:', '> 界先生', '> こちら入力しておらず', '',
  ].join('\r\n');
  const out = cleanBody(raw);
  assert.ok(out.includes('日程調整ありがとうございました'));
  assert.ok(!out.includes('wrote:'));
  assert.ok(!out.includes('入力しておらず'));
});

test('cleanBody cuts eM Client style original-message block and === signature', () => {
  const raw = ['河合さま', '', 'いつも大変お世話になっております，重信です。', '押印対応お願い致します。', '', '============================================', '福井大学 学術研究院工学系部門', '', '------ 元のメッセージ ------', '差出人 "産学官連携"', '>重信先生'].join('\n');
  const out = cleanBody(raw);
  assert.ok(out.includes('押印対応'));
  assert.ok(!out.includes('福井大学 学術研究院'));
  assert.ok(!out.includes('元のメッセージ'));
});

test('cleanBody truncates to maxChars', () => {
  const out = cleanBody('あ'.repeat(3000), 100);
  assert.equal(out.length, 101); // 100 + …
});

// ---------- tier ----------
test('tierFor: learned rule wins, then contacts, then stats, then domain', () => {
  const rules = withSenderRule(EMPTY_RULES, 'spammer@example.com', 'noise');
  assert.equal(tierFor('spammer@example.com', { received: 50, replied: 10, sentTo: 10 }, rules, ctx), 'noise');
  assert.equal(tierFor('t-kawai@u-fukui.ac.jp', undefined, EMPTY_RULES, ctx), 'vip');
  assert.equal(tierFor('x@tepco.co.jp', { received: 20, replied: 5, sentTo: 0 }, EMPTY_RULES, ctx), 'vip');
  assert.equal(tierFor('x@tepco.co.jp', { received: 20, replied: 1, sentTo: 0 }, EMPTY_RULES, ctx), 'known');
  assert.equal(tierFor('someone@u-fukui.ac.jp', undefined, EMPTY_RULES, ctx), 'internal');
  assert.equal(tierFor('noreply@shop.example.com', undefined, EMPTY_RULES, ctx), 'auto');
  assert.equal(tierFor('newperson@example.org', undefined, EMPTY_RULES, ctx), 'unknown');
});

test('tierFor: mailing lists are not VIP even with many sent-to', () => {
  assert.equal(tierFor('kougakubu-soumu@ml.u-fukui.ac.jp', { received: 100, replied: 0, sentTo: 12 }, EMPTY_RULES, ctx), 'internal');
  assert.equal(tierFor('hvdc-jimu@ml.mri.co.jp', { received: 10, replied: 0, sentTo: 8 }, EMPTY_RULES, ctx), 'auto');
});

test('tierFor: marketing senders are auto even with odd local parts / subdomains', () => {
  assert.equal(tierFor('email@market.temuemail.com', undefined, EMPTY_RULES, ctx), 'auto');
  assert.equal(tierFor('anamagazine@mail.ana.co.jp', undefined, EMPTY_RULES, ctx), 'auto');
  assert.equal(tierFor('noreply-payments@booking.com', undefined, EMPTY_RULES, ctx), 'auto');
  assert.equal(tierFor('calendar-notification@google.com', undefined, EMPTY_RULES, ctx), 'auto');
  assert.equal(tierFor('taro.yamada@example.co.jp', undefined, EMPTY_RULES, ctx), 'unknown');
});

test('looksLikeBulk: auto sender + one promo phrase is enough', () => {
  assert.equal(looksLikeBulk({ fromAddress: 'email@market.temuemail.com', subject: '【国内発送】新登場', text: '注意：このメールは自動送信です。', tier: 'auto' }), true);
  assert.equal(looksLikeBulk({ fromAddress: 'anamagazine@mail.ana.co.jp', subject: '旅のヒント', text: '※ 画像が表示されない場合はこちら', tier: 'auto' }), true);
  assert.equal(looksLikeBulk({ fromAddress: 'noreply-payments@booking.com', subject: '領収書', text: '予約番号 123 決済日', tier: 'auto' }), false);
});

test('rules: set/unset sender rule', () => {
  let r = withSenderRule(EMPTY_RULES, 'A@Example.com', 'vip', 'テスト');
  assert.equal(tierFromRules(r, 'a@example.com'), 'vip');
  r = withSenderRule(r, 'a@example.com', null);
  assert.equal(tierFromRules(r, 'a@example.com'), null);
});

// ---------- bulk / spam ----------
test('looksLikeBulk detects CFP / promo, but never for vip/known/internal', () => {
  assert.equal(looksLikeBulk({ fromAddress: 'eee@aca.cn', subject: 'Call for Participation: SGSE 2026', text: '', tier: 'unknown' }), true);
  assert.equal(looksLikeBulk({ fromAddress: 'contact@ledge.co.jp', subject: 'AIニュース3選', text: '配信停止はこちら unsubscribe', tier: 'unknown' }), true);
  assert.equal(looksLikeBulk({ fromAddress: 'x@tepco.co.jp', subject: 'Call for papers', text: 'unsubscribe 配信停止', tier: 'vip' }), false);
  assert.equal(looksLikeBulk({ fromAddress: 'new@corp.co.jp', subject: '共同研究のご相談', text: '初めてご連絡いたします。', tier: 'unknown' }), false);
});

test('looksLikeSpam honours server [SPAM] flag and brand-spoofing', () => {
  assert.equal(looksLikeSpam({ isSpamFlagged: true, fromAddress: 'a@b.c', fromName: '', subject: 'x', tier: 'unknown' }).spam, true);
  assert.equal(looksLikeSpam({ isSpamFlagged: false, fromAddress: 'noreply@mail22.raristudio.com', fromName: 'A  m  a  z  o  n', subject: 'Primeの定期更新', tier: 'unknown' }).spam, true);
  assert.equal(looksLikeSpam({ isSpamFlagged: false, fromAddress: 'taniguis@fepc.or.jp', fromName: '谷口', subject: '中間報告会のご案内', tier: 'vip' }).spam, false);
});

// ---------- deadline / priority ----------
test('normalizeDeadline handles ISO, JP and month/day forms', () => {
  assert.equal(normalizeDeadline('2026-9-18', '2026-09-05'), '2026-09-18');
  assert.equal(normalizeDeadline('2026/09/18', '2026-09-05'), '2026-09-18');
  assert.equal(normalizeDeadline('9/18', '2026-09-05'), '2026-09-18');
  assert.equal(normalizeDeadline('1/10', '2026-09-05'), '2027-01-10');
  assert.equal(normalizeDeadline('来週', '2026-09-05'), null);
  assert.equal(normalizeDeadline(null, '2026-09-05'), null);
});

test('bumpPriorityByDeadline promotes near deadlines for reply/action only', () => {
  assert.equal(bumpPriorityByDeadline({ category: 'action', priority: 'P3', deadline: '2026-09-06' }, '2026-09-05'), 'P1');
  assert.equal(bumpPriorityByDeadline({ category: 'action', priority: 'P3', deadline: '2026-09-10' }, '2026-09-05'), 'P2');
  assert.equal(bumpPriorityByDeadline({ category: 'action', priority: 'P1', deadline: '2026-09-30' }, '2026-09-05'), 'P1');
  assert.equal(bumpPriorityByDeadline({ category: 'fyi', priority: 'P3', deadline: '2026-09-06' }, '2026-09-05'), 'P3');
});

test('tagsFor maps category/priority to note tags', () => {
  assert.deepEqual(tagsFor('reply', 'P1'), ['reply', 'urgent']);
  assert.deepEqual(tagsFor('action', 'P2'), ['action']);
  assert.deepEqual(tagsFor('fyi', 'P1'), ['info']);
  assert.deepEqual(tagsFor('noise', 'P4'), ['unnecessary']);
});

// ---------- cases ----------
function mkCase(over: Partial<ButlerCase>): ButlerCase {
  return {
    id: 'a::mail-1', accountEmail: 'a', mailId: 1, mailIds: [1], subject: 's', from: 'f', fromAddress: 'f@x', fromName: 'f',
    receivedAt: '2026-09-05T00:00:00.000Z', addressedToMe: 'to', senderTier: 'unknown', threadCount: 1, myRepliesInThread: 0, lastFromMe: false,
    category: 'action', priority: 'P3', ask: '', summary: '', deadline: null, suggestedAction: '', reason: '', needsDraft: false,
    tags: [], status: 'open', aiSource: 'ai', createdAt: '2026-09-05T00:00:00.000Z', runAt: '2026-09-05T00:00:00.000Z', ...over,
  };
}

test('sortCases: priority, then deadline, then newest', () => {
  const s = sortCases([
    mkCase({ id: '1', priority: 'P3' }),
    mkCase({ id: '2', priority: 'P1', deadline: '2026-09-20' }),
    mkCase({ id: '3', priority: 'P1', deadline: '2026-09-10' }),
    mkCase({ id: '4', priority: 'P2' }),
  ]).map((c) => c.id);
  assert.deepEqual(s, ['3', '2', '4', '1']);
});

test('mergeCarryOver keeps open/later cases within 14 days, new wins, later→open on new mail', () => {
  const now = new Date('2026-09-05T09:00:00Z');
  const prev = [
    mkCase({ id: 'keep', status: 'open', runAt: '2026-09-01T00:00:00Z' }),
    mkCase({ id: 'old', status: 'open', runAt: '2026-08-01T00:00:00Z' }),
    mkCase({ id: 'done', status: 'done', runAt: '2026-09-04T00:00:00Z' }),
    mkCase({ id: 'later', status: 'later', runAt: '2026-09-04T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }),
  ];
  const fresh = [mkCase({ id: 'later', status: 'open', priority: 'P1' }), mkCase({ id: 'new' })];
  const merged = mergeCarryOver(prev, fresh, now);
  const ids = merged.map((c) => c.id).sort();
  assert.deepEqual(ids, ['keep', 'later', 'new']);
  const later = merged.find((c) => c.id === 'later')!;
  assert.equal(later.status, 'open');
  assert.equal(later.priority, 'P1');
  assert.equal(later.createdAt, '2026-09-01T00:00:00Z');
});

function mkMail(over: Partial<CandidateMail>): CandidateMail {
  return {
    id: 1, subject: 'x', date: new Date('2026-09-05T00:00:00Z'), receivedDate: null, preview: 'p', importance: 1, flags: 0, folder: 2,
    from: { displayName: 'F', address: 'f@x.com', type: AddressType.From }, to: [], cc: [], isRead: false, isFlagged: false, accountEmail: 'lute@u-fukui.ac.jp',
    folderKind: 'inbox', isSpamFlagged: false, replyDate: null, ...over,
  };
}

test('addressedToMe distinguishes to / cc / list', () => {
  const me = ['lute@u-fukui.ac.jp'];
  assert.equal(addressedToMe(mkMail({ to: [{ displayName: '', address: 'LUTE@u-fukui.ac.jp', type: AddressType.To }] }), me), 'to');
  assert.equal(addressedToMe(mkMail({ to: [{ displayName: '', address: 'a@b', type: AddressType.To }], cc: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.Cc }] }), me), 'cc');
  assert.equal(addressedToMe(mkMail({ subject: '[kyojukai2nd] x', to: [{ displayName: '', address: 'kyojukai@ml.u-fukui.ac.jp', type: AddressType.To }] }), me), 'list');
});

test('noteIdFor matches the renderer convention (conv- first)', () => {
  assert.equal(noteIdFor({ id: 5, conversationId: 'abc' }), 'conv-abc');
  assert.equal(noteIdFor({ id: 5 }), 'mail-5');
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('結果: {"a":[1,2]} です'), { a: [1, 2] });
  assert.equal(extractJson('nothing'), null);
});

test('buildClassifyPrompt includes context and every case id', () => {
  const inputs: CaseInput[] = [{
    id: 'c1', accountEmail: 'a', subject: 'S', fromName: 'N', fromAddress: 'n@x', tier: 'vip', addressedToMe: 'to', receivedAt: '2026-09-05 10:00',
    threadCount: 1, myReplies: 0, lastFromMe: false, body: 'B', history: [],
  }];
  const p = buildClassifyPrompt(ctx, inputs);
  assert.ok(p.includes('id: c1'));
  assert.ok(p.includes('今日の日付: 2026-09-05'));
  assert.ok(p.includes('関係者一覧'));
});

test('fallbackBrief is a sentence, not empty', () => {
  const t = fallbackBrief({ today: '2026-09-05', p1: [{ subject: 'S', from: 'F', ask: 'A', deadline: null }], p2: [], counts: { cases: 1, noise: 2, spam: 3, drafts: 1, fyi: 0 } });
  assert.ok(t.startsWith('おはようございます'));
  assert.ok(t.includes('S'));
});

// ---------- pipeline end-to-end with fake deps ----------
test('runButlerPipeline: spam grouped, noise excluded, AI cases judged, notes only for reply/action', async () => {
  const notes = new Map<string, MailNote>();
  const files = new Map<string, unknown>();
  const settings: AppSettings = { ...DEFAULT_SETTINGS, butlerEnabled: true, selectedAccounts: ['lute@u-fukui.ac.jp'], butlerMaxCasesPerRun: 10, butlerMaxDraftsPerRun: 1 };
  const mails: CandidateMail[] = [
    mkMail({ id: 1, subject: '[SPAM] 90%OFF', from: { displayName: 'パテック', address: 'x@okooo.cn', type: AddressType.From }, isSpamFlagged: true }),
    mkMail({ id: 2, subject: 'Call for papers: Journal of X', from: { displayName: 'J', address: 'em@journal.com', type: AddressType.From } }),
    mkMail({ id: 3, subject: '日程調整のお願い', conversationId: 'conv-A', from: { displayName: '有川', address: 's_arikawa@mri.co.jp', type: AddressType.From }, to: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.To }] }),
    mkMail({ id: 4, subject: 'FYI 転送', from: { displayName: '伊藤', address: 'itomasa@u-fukui.ac.jp', type: AddressType.From }, to: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.To }] }),
  ];
  let classifyCalls = 0;
  const deps: PipelineDeps = {
    loadSettings: () => settings,
    loadRules: () => EMPTY_RULES,
    buildContext: () => ctx,
    getCandidates: () => mails,
    getSenderStats: () => new Map([['s_arikawa@mri.co.jp', { received: 49, replied: 20, sentTo: 5 }]]),
    getThread: (_a, conv) => ({ conversationId: conv, count: 2, myReplies: 1, lastFromMe: false, lastAt: new Date(), messages: [
      { id: 30, date: new Date('2026-09-01'), from: '先生', fromAddress: 'lute@u-fukui.ac.jp', to: [], cc: [], isSentByMe: true, body: '前回の返信', subject: 's' },
      { id: 3, date: new Date('2026-09-05'), from: '有川 <s_arikawa@mri.co.jp>', fromAddress: 's_arikawa@mri.co.jp', to: ['lute@u-fukui.ac.jp'], cc: [], isSentByMe: false, body: '候補日をお知らせください', subject: 's' },
    ] }),
    getBodies: (_a, ids) => new Map(ids.map((i) => [i, `body of ${i}`])),
    getExemplars: () => ['件名: x\n〇〇さま\n\n重信です。'],
    classify: async (_c, inputs) => {
      classifyCalls += 1;
      const judgments = new Map(inputs.map((i) => [i.id, {
        id: i.id, category: i.subject.includes('日程') ? 'reply' as const : 'fyi' as const, priority: i.subject.includes('日程') ? 'P2' as const : 'P3' as const,
        ask: 'ask', summary: 'sum', deadline: i.subject.includes('日程') ? '2026-09-06' : null, suggestedAction: 'act', reason: 'why', needsDraft: i.subject.includes('日程'),
      }]));
      return { judgments, aiCalls: 1, costUsd: 0.01, errors: [] };
    },
    draft: async () => ({ ok: true, draft: '有川様\n\n重信です。', costUsd: 0.01 }),
    brief: async (b) => ({ text: fallbackBrief(b), costUsd: 0, ai: false }),
    moveToQuarantine: async () => ({ success: false }),
    hasImapCredentials: () => false,
    getNote: (id) => notes.get(id) ?? null,
    saveNote: (n) => { notes.set(n.id, n); },
    butlerStatePath: 'state', digestPath: 'digest',
    readJson: <T,>(p: string) => (files.get(p) as T) ?? null,
    writeJson: (p, d) => { files.set(p, JSON.parse(JSON.stringify(d))); },
    now: () => new Date('2026-09-05T09:00:00Z'),
  };
  const digest = await runButlerPipeline(deps, { force: true });
  assert.equal(digest.version, 2);
  assert.equal(classifyCalls, 1);
  assert.equal(digest.stats?.spam, 1);
  assert.equal(digest.stats?.noise, 1);
  const spamGroup = digest.groups!.find((g) => g.kind === 'spam_delete')!;
  assert.equal(spamGroup.items.length, 1);
  assert.equal(digest.cases!.length, 2);
  const arikawa = digest.cases!.find((c) => c.fromAddress === 's_arikawa@mri.co.jp')!;
  assert.equal(arikawa.senderTier, 'vip');
  assert.equal(arikawa.priority, 'P1');            // 期限 9/6 → 引き上げ
  assert.equal(arikawa.draftStatus, 'prepared');
  assert.deepEqual(arikawa.tags, ['reply', 'urgent']);
  assert.equal(arikawa.noteId, 'conv-conv-A');
  assert.ok(notes.has('conv-conv-A'));
  const ito = digest.cases!.find((c) => c.fromAddress === 'itomasa@u-fukui.ac.jp')!;
  assert.equal(ito.category, 'fyi');
  assert.ok(!notes.has('mail-4'));               // fyi はノートを作らない
  assert.equal(digest.processedCount, 4);
  const state = files.get('state') as { processed: Record<string, number[]>; lastRunAt: string };
  assert.deepEqual([...state.processed['lute@u-fukui.ac.jp']].sort(), [1, 2, 3, 4]);
  assert.ok(digest.brief && digest.brief.length > 0);

  // 2回目: 新着なし → 未完了案件は引き継がれる
  const deps2: PipelineDeps = { ...deps, getCandidates: () => [] };
  const digest2 = await runButlerPipeline(deps2, { force: true });
  assert.equal(digest2.cases!.length, 2);
  assert.equal(digest2.stats?.candidates, 0);
});

test('runButlerPipeline: disabled and not forced → empty digest without writes', async () => {
  let wrote = false;
  const deps = {
    loadSettings: () => ({ ...DEFAULT_SETTINGS, butlerEnabled: false }),
    writeJson: () => { wrote = true; },
    readJson: () => null,
  } as unknown as PipelineDeps;
  const d = await runButlerPipeline(deps);
  assert.equal(d.processedCount, 0);
  assert.equal(wrote, false);
});
