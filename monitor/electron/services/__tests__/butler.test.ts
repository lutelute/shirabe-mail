// 夜間執事 v2 の純関数テスト(node --test で実行。esbuild でバンドルして走らせる)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBody } from '../mail-intel';
import { tierFor, looksLikeBulk, looksLikeSpam, normalizeDeadline, buildClassifyPrompt, fallbackBrief, DEFAULT_PROFILE, normalizeDecision, greetingFor, buildFollowUpPrompt, normalizeEvent } from '../butler-brain';
import type { JudgmentContext, CaseInput } from '../butler-brain';
import { withSenderRule, tierFromRules, EMPTY_RULES } from '../butler-rules';
import { bumpPriorityByDeadline, tagsFor, sortCases, mergeCarryOver, addressedToMe, runButlerPipeline, noteIdFor, reconcileFollowUps, canAutoSend, matchCalendar, titleSimilar } from '../pipeline';
import { buildIcs, toIcsDateTime } from '../calendar-ics';
import { enqueue, cancel, expedite, dueItems, prune, visibleItems, EMPTY_OUTBOX } from '../outbox';
import { composeBody, replySubject, formatFrom } from '../mail-sender';
import { extractSignature } from '../mail-intel';
import { parseEmailAddress } from '../account-discovery';
import { resolveFolder } from '../mailbox-actions';
import type { FollowUp } from '../../../src/types/index';
import type { PipelineDeps } from '../pipeline';
import type { CandidateMail, WaitingThread } from '../mail-intel';
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
  const t = fallbackBrief({ today: '2026-09-05', hour: 9, p1: [{ subject: 'S', from: 'F', ask: 'A', deadline: null }], p2: [], counts: { cases: 1, noise: 2, spam: 3, drafts: 1, fyi: 0 } });
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
        replyKind: i.subject.includes('日程') ? 'schedule' as const : 'other' as const, autoSendSafe: i.subject.includes('日程'), replyScope: 'sender' as const, decision: null, event: null,
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


// =====================================================================
// v3 相棒
// =====================================================================

test('greetingFor / fallbackBrief follow the hour', () => {
  assert.equal(greetingFor(8), 'おはようございます。');
  assert.equal(greetingFor(15), 'お疲れさまです。');
  const t15 = fallbackBrief({ today: '2026-10-07', hour: 15, p1: [], p2: [], counts: { cases: 0, noise: 3, spam: 0, drafts: 0, fyi: 0, tidied: 3, followUps: 2 } });
  assert.ok(t15.startsWith('お疲れさまです。'));
  assert.ok(t15.includes('片付け'));
  assert.ok(t15.includes('返事待ちが2件'));
});

test('normalizeDecision validates question + options', () => {
  assert.equal(normalizeDecision(null), null);
  assert.equal(normalizeDecision({ question: '', options: ['a'] }), null);
  assert.equal(normalizeDecision({ question: '出席しますか?', options: [] }), null);
  assert.deepEqual(normalizeDecision({ question: '出席しますか?', options: ['出席', '欠席', '出席', ''] }), { question: '出席しますか?', options: ['出席', '欠席'] });
});

test('outbox: enqueue → due after delay, cancel only while scheduled, expedite moves sendAt to now', () => {
  const now = new Date('2026-10-07T09:00:00Z');
  const { store: s1, item } = enqueue(EMPTY_OUTBOX, { kind: 'reply', accountEmail: 'a@x', to: ['b@y'], cc: [], subject: 'Re: t', body: 'hi', label: 'b へ', delayMinutes: 5 }, now);
  assert.equal(item.status, 'scheduled');
  assert.equal(dueItems(s1, now).length, 0);
  assert.equal(dueItems(s1, new Date(now.getTime() + 5 * 60_000)).length, 1);
  const ex = expedite(s1, item.id, now);
  assert.equal(dueItems(ex.store, now).length, 1);
  const c1 = cancel(s1, item.id);
  assert.equal(c1.item?.status, 'cancelled');
  assert.ok(cancel(c1.store, item.id).error);   // cancelled → not cancellable again
  // sent items older than a day are hidden; recent ones visible
  const sent = { ...item, status: 'sent' as const, sentAt: new Date(now.getTime() - 2 * 86_400_000).toISOString() };
  assert.equal(visibleItems({ version: 1, items: [sent] }, now).length, 0);
  assert.equal(prune({ version: 1, items: [sent] }, new Date(now.getTime() + 20 * 86_400_000)).items.length, 0);
});

test('mail-sender: replySubject / composeBody / formatFrom', () => {
  assert.equal(replySubject('日程の件'), 'Re: 日程の件');
  assert.equal(replySubject('Re: 日程の件'), 'Re: 日程の件');
  assert.equal(replySubject('RE[2]: 日程の件'), 'RE[2]: 日程の件');
  const body = composeBody('有川さま\n\n重信です。', '====\n福井大学 重信\n====', { fromText: '有川 <a@mri.co.jp>', dateText: '2026/10/1 10:00', toText: 'lute@u-fukui.ac.jp', subject: '日程', body: '候補日を\nください' });
  assert.ok(body.startsWith('有川さま\n\n重信です。\n\n====\n福井大学 重信\n====\n\n------ 元のメッセージ ------'));
  assert.ok(body.endsWith('> 候補日を\n> ください'));
  assert.equal(composeBody('x', '', null), 'x');
  assert.equal(formatFrom('SHIGENOBU Ryuto', 'lute@u-fukui.ac.jp'), '"SHIGENOBU Ryuto" <lute@u-fukui.ac.jp>');
  assert.equal(formatFrom('', 'lute@u-fukui.ac.jp'), 'lute@u-fukui.ac.jp');
});

test('extractSignature finds the ==== block and ignores quoted text', () => {
  const raw = ['河合さま', '', '重信です。', 'よろしくお願い致します。', '', '============================================', '福井大学 学術研究院工学系部門', '重信 颯人', 'E-mail: lute@u-fukui.ac.jp', '============================================', '', '> 元のメッセージ', '> ...'].join('\n');
  const sig = extractSignature(raw);
  assert.ok(sig.startsWith('============================================\n福井大学'));
  assert.ok(sig.endsWith('============================================'));
  assert.ok(!sig.includes('よろしく'));
  assert.equal(extractSignature('短い本文だけ'), '');
});

test('account-discovery: parseEmailAddress', () => {
  assert.deepEqual(parseEmailAddress('"SHIGENOBU Ryuto" <lute@u-fukui.ac.jp>'), { name: 'SHIGENOBU Ryuto', address: 'lute@u-fukui.ac.jp' });
  assert.deepEqual(parseEmailAddress('lute@G.u-fukui.ac.jp'), { name: '', address: 'lute@g.u-fukui.ac.jp' });
});

test('mailbox-actions: resolveFolder prefers special-use, then names', () => {
  const folders = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', flags: new Set<string>(), listed: true, subscribed: true },
    { path: '[Gmail]/すべてのメール', name: 'すべてのメール', delimiter: '/', flags: new Set<string>(), listed: true, subscribed: true, specialUse: '\\All' },
    { path: 'Archive', name: 'Archive', delimiter: '.', flags: new Set<string>(), listed: true, subscribed: true },
  ] as unknown as Parameters<typeof resolveFolder>[0];
  assert.equal(resolveFolder(folders, '\\All', ['Archive']), '[Gmail]/すべてのメール');
  assert.equal(resolveFolder(folders, '\\Archive', ['Archive']), 'Archive');
  assert.equal(resolveFolder(folders, '\\Trash', ['Trash']), null);
});

test('canAutoSend: only delegate + trusted + safe + drafted + no open decision', () => {
  const base = {
    id: 'a::conv-1', accountEmail: 'a', mailId: 1, mailIds: [1], subject: 's', from: 'x', fromAddress: 'x@u-fukui.ac.jp', fromName: 'x', receivedAt: '', addressedToMe: 'to', senderTier: 'internal',
    threadCount: 1, myRepliesInThread: 0, lastFromMe: false, category: 'reply', priority: 'P2', ask: '', summary: '', deadline: null, suggestedAction: '', reason: '', needsDraft: true,
    tags: [], status: 'open', aiSource: 'ai', createdAt: '', runAt: '', draft: 'ok', draftStatus: 'prepared', autoSendSafe: true, replyKind: 'ack', decision: null,
  } as unknown as ButlerCase;
  assert.equal(canAutoSend(base, 'delegate'), true);
  assert.equal(canAutoSend(base, 'assist'), false);
  assert.equal(canAutoSend({ ...base, senderTier: 'unknown' }, 'delegate'), false);
  assert.equal(canAutoSend({ ...base, replyKind: 'decline' }, 'delegate'), false);
  assert.equal(canAutoSend({ ...base, decision: { question: 'q', options: ['a'] } }, 'delegate'), false);
  assert.equal(canAutoSend({ ...base, decision: { question: 'q', options: ['a'], answer: 'a' } }, 'delegate'), true);
  assert.equal(canAutoSend({ ...base, draft: undefined }, 'delegate'), false);
});

test('reconcileFollowUps: opens judged threads, closes answered ones, keeps unknown for next time', () => {
  const now = new Date('2026-10-07T00:00:00Z');
  const w = (conv: string, days: number): WaitingThread & { accountEmail: string } => ({
    accountEmail: 'a', conversationId: conv, mailId: 10, subject: `s-${conv}`, sentAt: new Date(now.getTime() - days * 86_400_000), to: [{ displayName: 'T', address: 't@x', type: AddressType.To }], cc: [], body: 'b', daysWaiting: days, threadCount: 2,
  });
  const prev: FollowUp[] = [
    { id: 'a::conv-old', accountEmail: 'a', conversationId: 'old', mailId: 1, subject: 'old', to: 'T', toAddress: 't@x', sentAt: '', daysWaiting: 5, ask: '', summary: '', status: 'open', aiSource: 'ai', createdAt: '', updatedAt: '' },
    { id: 'a::conv-keep', accountEmail: 'a', conversationId: 'keep', mailId: 2, subject: 'keep', to: 'T', toAddress: 't@x', sentAt: '', daysWaiting: 3, ask: '', summary: '', status: 'snoozed', snoozeUntil: '2026-10-06T00:00:00Z', aiSource: 'ai', createdAt: '', updatedAt: '' },
  ];
  const judgments = new Map([
    ['a::conv-new', { id: 'a::conv-new', needsReply: true, ask: '候補日の回答', summary: 'T に日程', nudgeOk: true, urgency: 'soon' as const }],
    ['a::conv-no', { id: 'a::conv-no', needsReply: false, ask: '', summary: 'お礼だけ', nudgeOk: false, urgency: 'later' as const }],
  ]);
  const r = reconcileFollowUps(prev, [w('keep', 6), w('new', 5), w('no', 5), w('unjudged', 7)], judgments, ['a'], now);
  assert.deepEqual(r.opened.map((f) => f.id), ['a::conv-new']);
  assert.deepEqual(r.closed.map((f) => f.id), ['a::conv-old']);          // もう待ちリストに無い = 返事が来た
  const keep = r.list.find((f) => f.id === 'a::conv-keep')!;
  assert.equal(keep.status, 'open');                                       // snooze 明け
  assert.equal(keep.daysWaiting, 6);
  assert.equal(r.list.find((f) => f.id === 'a::conv-no')?.status, 'closed');
  assert.ok(!r.list.some((f) => f.id === 'a::conv-unjudged'));            // 判定待ちは次回
});

test('buildFollowUpPrompt lists every id', () => {
  const p = buildFollowUpPrompt(ctx, [{ id: 'x::conv-1', subject: 's', toText: 'T <t@x>', tier: 'known', sentAt: '2026-10-01 10:00', daysWaiting: 6, threadCount: 3, body: 'b' }]);
  assert.ok(p.includes('x::conv-1') && p.includes('6日前'));
});

test('runButlerPipeline v3: tidy archives noise, delegate schedules safe replies, follow-ups tracked', async () => {
  const files = new Map<string, unknown>();
  const notes = new Map<string, MailNote>();
  const settings: AppSettings = { ...DEFAULT_SETTINGS, butlerEnabled: true, selectedAccounts: ['lute@u-fukui.ac.jp'], partnerMode: 'delegate', partnerAutoTidy: true, butlerMaxDraftsPerRun: 3 };
  const mails: CandidateMail[] = [
    mkMail({ id: 2, subject: 'Call for papers: Journal of X', from: { displayName: 'J', address: 'em@journal.com', type: AddressType.From } }),
    mkMail({ id: 3, subject: '資料ありがとうございました', conversationId: 'conv-B', from: { displayName: '河合', address: 't-kawai@u-fukui.ac.jp', type: AddressType.From }, to: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.To }] }),
    mkMail({ id: 5, subject: '審査の可否について', conversationId: 'conv-C', from: { displayName: '千住', address: 'senju@u-ryukyu.ac.jp', type: AddressType.From }, to: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.To }] }),
  ];
  const tidied: number[] = [];
  const scheduled: string[] = [];
  const journal: string[] = [];
  const deps: PipelineDeps = {
    loadSettings: () => settings,
    loadRules: () => EMPTY_RULES,
    buildContext: () => ctx,
    getCandidates: () => mails,
    getSenderStats: () => new Map([['senju@u-ryukyu.ac.jp', { received: 5, replied: 3, sentTo: 2 }]]),
    getThread: (_a, conv) => ({ conversationId: conv, count: 1, myReplies: 0, lastFromMe: false, lastAt: new Date(), messages: [] }),
    getBodies: (_a, ids) => new Map(ids.map((i) => [i, `body ${i}`])),
    getExemplars: () => [],
    classify: async (_c, inputs) => ({
      judgments: new Map(inputs.map((i) => [i.id, i.subject.includes('ありがとう')
        ? { id: i.id, category: 'reply' as const, priority: 'P3' as const, ask: 'お礼に返事', summary: 's', deadline: null, suggestedAction: '返信', reason: 'r', needsDraft: true, replyKind: 'thanks' as const, autoSendSafe: true, replyScope: 'sender' as const, decision: null, event: null }
        : { id: i.id, category: 'reply' as const, priority: 'P2' as const, ask: '可否を回答', summary: 's', deadline: null, suggestedAction: '返信', reason: 'r', needsDraft: true, replyKind: 'accept' as const, autoSendSafe: false, replyScope: 'sender' as const, decision: { question: '副査を引き受けますか?', options: ['引き受ける', '辞退する'] }, event: { title: '予備審査', start: '2026-11-15T10:00', end: null, allDay: false, kind: 'meeting' as const } },
      ])),
      aiCalls: 1, costUsd: 0, errors: [],
    }),
    draft: async () => ({ ok: true, draft: '河合さま\n\n重信です。', costUsd: 0 }),
    brief: async (b) => ({ text: fallbackBrief(b), costUsd: 0, ai: false }),
    moveToQuarantine: async () => ({ success: false }),
    hasImapCredentials: () => true,
    getNote: (id) => notes.get(id) ?? null,
    saveNote: (n) => { notes.set(n.id, n); },
    butlerStatePath: 'state', digestPath: 'digest',
    readJson: <T,>(p: string) => (files.get(p) as T) ?? null,
    writeJson: (p, d) => { files.set(p, JSON.parse(JSON.stringify(d))); },
    now: () => new Date('2026-10-07T00:00:00Z'),
    canTidy: () => true,
    tidy: async (_a, ids) => { tidied.push(...ids); return { done: ids, archiveFolder: 'Archive' }; },
    canSend: () => true,
    enqueueSend: async (c) => { scheduled.push(c.id); return `ob-${c.mailId}`; },
    getWaitingThreads: () => [{ conversationId: 'W1', mailId: 77, subject: '候補日のお願い', sentAt: new Date('2026-10-01T00:00:00Z'), to: [{ displayName: '有川', address: 's_arikawa@mri.co.jp', type: AddressType.To }], cc: [], body: '候補日をお知らせください', daysWaiting: 6, threadCount: 1 }],
    judgeFollowUps: async (_c, inputs) => ({ judgments: new Map(inputs.map((i) => [i.id, { id: i.id, needsReply: true, ask: '候補日の回答', summary: '有川さんに日程', nudgeOk: true, urgency: 'soon' as const }])), aiCalls: 1, costUsd: 0, errors: [] }),
    followUpsPath: 'followups',
    journal: (e) => { journal.push(`${e.kind}:${e.text}`); },
  };
  const digest = await runButlerPipeline(deps, { force: true });
  // 片付け
  assert.deepEqual(tidied, [2]);
  const tg = digest.groups!.find((g) => g.kind === 'tidied')!;
  assert.equal(tg.items.length, 1);
  assert.equal(tg.archiveFolder, 'Archive');
  assert.equal(digest.stats?.tidied, 1);
  // 任せる: お礼(thanks, vip, safe) は送信予定へ。決定が要る案件は下書きも作らず問いだけ
  const kawai = digest.cases!.find((c) => c.fromAddress === 't-kawai@u-fukui.ac.jp')!;
  assert.equal(kawai.status, 'scheduled');
  assert.equal(kawai.outboxId, 'ob-3');
  assert.deepEqual(scheduled, [kawai.id]);
  const senju = digest.cases!.find((c) => c.fromAddress === 'senju@u-ryukyu.ac.jp')!;
  assert.equal(senju.status, 'open');
  assert.equal(senju.draft, undefined);
  assert.equal(senju.decision?.question, '副査を引き受けますか?');
  assert.equal(digest.stats?.decisions, 1);
  assert.equal(digest.stats?.scheduled, 1);
  // 返事待ち
  const fus = files.get('followups') as FollowUp[];
  assert.equal(fus.length, 1);
  assert.equal(fus[0].status, 'open');
  assert.equal(fus[0].ask, '候補日の回答');
  assert.equal(digest.stats?.followUps, 1);
  assert.equal(digest.mode, 'delegate');
  assert.ok(journal.some((j) => j.startsWith('archived:')) && journal.some((j) => j.startsWith('scheduled:')) && journal.some((j) => j.startsWith('run:')));
  // 2回目: 送信予定中の案件は引き継がれ、返事が来た待ちは閉じる
  const deps2: PipelineDeps = { ...deps, getCandidates: () => [], getWaitingThreads: () => [] };
  const digest2 = await runButlerPipeline(deps2, { force: true });
  assert.equal(digest2.cases!.find((c) => c.id === kawai.id)?.status, 'scheduled');
  assert.equal((files.get('followups') as FollowUp[])[0].status, 'closed');
});

test('runButlerPipeline v3: observe mode never tidies nor schedules', async () => {
  const files = new Map<string, unknown>();
  let tidyCalled = false;
  const settings: AppSettings = { ...DEFAULT_SETTINGS, butlerEnabled: true, selectedAccounts: ['lute@u-fukui.ac.jp'], partnerMode: 'observe' };
  const deps: PipelineDeps = {
    loadSettings: () => settings, loadRules: () => EMPTY_RULES, buildContext: () => ctx,
    getCandidates: () => [mkMail({ id: 2, subject: 'Call for papers: Journal of X', from: { displayName: 'J', address: 'em@journal.com', type: AddressType.From } })],
    getSenderStats: () => new Map(), getThread: () => ({ conversationId: '', count: 0, myReplies: 0, lastFromMe: false, lastAt: null, messages: [] }),
    getBodies: () => new Map(), getExemplars: () => [],
    classify: async () => ({ judgments: new Map(), aiCalls: 0, costUsd: 0, errors: [] }),
    draft: async () => ({ ok: false, draft: '', costUsd: 0 }), brief: async (b) => ({ text: fallbackBrief(b), costUsd: 0, ai: false }),
    moveToQuarantine: async () => ({ success: false }), hasImapCredentials: () => true, getNote: () => null, saveNote: () => undefined,
    butlerStatePath: 'state', digestPath: 'digest', readJson: <T,>(p: string) => (files.get(p) as T) ?? null, writeJson: (p, d) => { files.set(p, d); },
    canTidy: () => true, tidy: async (_a, ids) => { tidyCalled = true; return { done: ids, archiveFolder: 'Archive' }; },
  };
  const d = await runButlerPipeline(deps, { force: true });
  assert.equal(tidyCalled, false);
  assert.equal(d.groups!.find((g) => g.kind === 'noise_list')?.items.length, 1);
  assert.equal(d.mode, 'observe');
});


// ---------- v3.1 カレンダー ----------
test('normalizeEvent: validates date, fills allDay, drops past', () => {
  assert.equal(normalizeEvent(null, '2026-10-07'), null);
  assert.deepEqual(normalizeEvent({ title: '役員会', start: '2026-10-29T17:00', end: '2026-10-29T19:00', allDay: false, kind: 'meeting', location: '金沢' }, '2026-10-07'),
    { title: '役員会', start: '2026-10-29T17:00', end: '2026-10-29T19:00', allDay: false, location: '金沢', kind: 'meeting' });
  assert.deepEqual(normalizeEvent({ title: '提出期限', start: '2026-10-8', allDay: true, kind: 'deadline' }, '2026-10-07'), { title: '提出期限', start: '2026-10-08', end: null, allDay: true, location: undefined, kind: 'deadline' });
  assert.equal(normalizeEvent({ title: '過去', start: '2026-09-01', allDay: true, kind: 'event' }, '2026-10-07'), null);
  assert.equal(normalizeEvent({ title: 'x', start: '来週', allDay: true, kind: 'event' }, '2026-10-07'), null);
});

test('titleSimilar / matchCalendar: same day + similar title → registered', () => {
  assert.equal(titleSimilar('電気学会北陸支部役員会', '【電気学会】北陸支部 役員会'), true);
  assert.equal(titleSimilar('エナリス定例', '福井大学様定例(エナリス)'), true);
  assert.equal(titleSimilar('役員会', '歯医者'), false);
  const events = [
    { id: 1, summary: '北陸支部役員会', description: '', location: '', start: new Date('2026-10-29T17:00:00'), end: new Date('2026-10-29T19:00:00'), status: 0, type: 0, organizerName: '', organizerAddress: '', accountEmail: 'a', isAllDay: false },
    { id: 2, summary: '出張', description: '', location: '', start: new Date('2026-11-15T00:00:00'), end: new Date('2026-11-16T00:00:00'), status: 0, type: 0, organizerName: '', organizerAddress: '', accountEmail: 'a', isAllDay: true },
  ];
  assert.deepEqual(matchCalendar({ title: '電気学会北陸支部役員会', start: '2026-10-29T17:00', allDay: false, kind: 'meeting' }, events), { status: 'registered', match: '北陸支部役員会' });
  assert.equal(matchCalendar({ title: '電気学会北陸支部役員会', start: '2026-10-30T17:00', allDay: false, kind: 'meeting' }, events).status, 'missing');
  assert.equal(matchCalendar({ title: '予備審査', start: '2026-11-15', allDay: true, kind: 'meeting' }, events).status, 'missing');
  // 同時刻で言い方が違う同じ予定(共通語あり) → 登録済み。共通語なし → 未登録
  const tepco = [{ id: 3, summary: '東電金本さんリクルート', description: '', location: '', start: new Date('2026-10-20T16:00:00'), end: new Date('2026-10-20T17:00:00'), status: 0, type: 0, organizerName: '', organizerAddress: '', accountEmail: 'a', isAllDay: false }];
  assert.equal(matchCalendar({ title: '東電PG 2028卒向け説明会', start: '2026-10-20T16:00', allDay: false, kind: 'event' }, tepco).status, 'registered');
  assert.equal(matchCalendar({ title: '最適化講義', start: '2026-10-20T16:00', allDay: false, kind: 'event' }, tepco).status, 'missing');
});

test('buildIcs: timed and all-day events', () => {
  const timed = buildIcs({ title: '役員会', start: '2026-10-29T17:00', end: '2026-10-29T19:00', allDay: false, kind: 'meeting', location: '金沢, 会議室' }, new Date('2026-10-07T00:00:00Z'));
  assert.ok(timed.includes('DTSTART;TZID=Asia/Tokyo:20261029T170000'));
  assert.ok(timed.includes('DTEND;TZID=Asia/Tokyo:20261029T190000'));
  assert.ok(timed.includes('LOCATION:金沢\\, 会議室'));
  const allDay = buildIcs({ title: '締切', start: '2026-10-08', allDay: true, kind: 'deadline' });
  assert.ok(allDay.includes('DTSTART;VALUE=DATE:20261008'));
  assert.ok(allDay.includes('DTEND;VALUE=DATE:20261009'));
  const noEnd = buildIcs({ title: 'x', start: '2026-10-08T23:30', allDay: false, kind: 'other' });
  assert.ok(noEnd.includes('DTEND;TZID=Asia/Tokyo:20261009T003000'));
  assert.deepEqual(toIcsDateTime('2026-10-08'), { value: '20261008', allDay: true });
});

test('runButlerPipeline: calendar cross-check marks missing events and counts them', async () => {
  const files = new Map<string, unknown>();
  const settings: AppSettings = { ...DEFAULT_SETTINGS, butlerEnabled: true, selectedAccounts: ['lute@u-fukui.ac.jp'] };
  const deps: PipelineDeps = {
    loadSettings: () => settings, loadRules: () => EMPTY_RULES, buildContext: () => ctx,
    getCandidates: () => [mkMail({ id: 9, subject: '役員会のご案内', conversationId: 'conv-E', from: { displayName: '山本', address: 'y@ieej.or.jp', type: AddressType.From }, to: [{ displayName: '', address: 'lute@u-fukui.ac.jp', type: AddressType.To }] })],
    getSenderStats: () => new Map([['y@ieej.or.jp', { received: 3, replied: 2, sentTo: 1 }]]),
    getThread: () => ({ conversationId: 'conv-E', count: 1, myReplies: 0, lastFromMe: false, lastAt: null, messages: [] }),
    getBodies: () => new Map(), getExemplars: () => [],
    classify: async (_c, inputs) => ({ judgments: new Map(inputs.map((i) => [i.id, { id: i.id, category: 'action' as const, priority: 'P2' as const, ask: '出欠回答', summary: 's', deadline: '2026-10-09', suggestedAction: '出欠を登録', reason: 'r', needsDraft: false, replyKind: 'other' as const, autoSendSafe: false, replyScope: 'sender' as const, decision: null, event: { title: '北陸支部役員会', start: '2026-10-29T17:00', end: '2026-10-29T19:00', allDay: false, kind: 'meeting' as const } }])), aiCalls: 1, costUsd: 0, errors: [] }),
    draft: async () => ({ ok: false, draft: '', costUsd: 0 }), brief: async (b) => ({ text: fallbackBrief(b), costUsd: 0, ai: false }),
    moveToQuarantine: async () => ({ success: false }), hasImapCredentials: () => false, getNote: () => null, saveNote: () => undefined,
    butlerStatePath: 'state', digestPath: 'digest', readJson: <T,>(p: string) => (files.get(p) as T) ?? null, writeJson: (p, d) => { files.set(p, JSON.parse(JSON.stringify(d))); },
    now: () => new Date('2026-10-07T00:00:00Z'),
    getCalendarEvents: () => [{ id: 1, summary: '歯医者', description: '', location: '', start: new Date('2026-10-29T17:00:00'), end: new Date('2026-10-29T18:00:00'), status: 0, type: 0, organizerName: '', organizerAddress: '', accountEmail: 'a', isAllDay: false }],
  };
  const d = await runButlerPipeline(deps, { force: true });
  const c = d.cases![0];
  assert.equal(c.event?.title, '北陸支部役員会');
  assert.equal(c.calendarStatus, 'missing');
  assert.equal(d.stats?.calendarMissing, 1);
  assert.ok(d.brief?.includes('カレンダーに入っていない予定が1件'));
  // 登録されたら次回は registered
  const deps2: PipelineDeps = { ...deps, getCandidates: () => [], getCalendarEvents: () => [{ id: 2, summary: '電気学会 北陸支部役員会', description: '', location: '', start: new Date('2026-10-29T17:00:00'), end: new Date('2026-10-29T19:00:00'), status: 0, type: 0, organizerName: '', organizerAddress: '', accountEmail: 'a', isAllDay: false }] };
  const d2 = await runButlerPipeline(deps2, { force: true });
  assert.equal(d2.cases![0].calendarStatus, 'registered');
  assert.equal(d2.stats?.calendarMissing, 0);
});
