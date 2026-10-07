// === 相棒ツール(MCP): Claude Code から「今日」の案件を読み、決め、下書き、送信予定に載せる ===
//
// アプリ(調)と同じ JSON を読み書きする。送信そのものはアプリが outbox を処理して行う(遅延+取消)。
// AI はここでは呼ばない。文体や判断材料は partner_style で呼び出し元に渡す。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMailThread } from '../tools/get-mail-thread.js';
import {
  PATHS, readJson, writeJson, loadDigest, saveDigest, loadOutbox, saveOutbox, loadFollowUps, saveFollowUps,
  appendJournal, readJournal, requestRun, canSend, sendDelayMinutes, replySubject, enqueueOutbox, cancelOutbox, summarizeToday,
} from './store.js';
import type { ButlerCase, ButlerCaseStatus } from './store.js';
import { resolveReplyRecipients } from './recipients.js';
import { getStylePack } from './style.js';

const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', error: message }) }], isError: true });

function withCase<T>(caseId: string, fn: (c: ButlerCase) => T): { ok: true; value: T; c: ButlerCase } | { ok: false; error: string } {
  const digest = loadDigest();
  const c = digest?.cases?.find((x) => x.id === caseId);
  if (!digest || !c) return { ok: false, error: `案件が見つかりません: ${caseId}(partner_today で id を確認)` };
  const value = fn(c);
  saveDigest(digest);
  return { ok: true, value, c };
}

export function registerPartnerTools(server: McpServer): void {
  server.tool(
    'partner_today',
    '相棒の「今日」: 申し送り、決めてほしいこと、送るだけの案件、やること、送信予定、返事待ちを一覧する(アプリ「調」と同じ状態)',
    {},
    async () => text(summarizeToday(loadDigest(), loadOutbox(), loadFollowUps())),
  );

  server.tool(
    'partner_case',
    '案件の詳細(判定・根拠・下書き・問い)とスレッド本文を返す',
    { case_id: z.string().describe('partner_today の id') },
    async ({ case_id }) => {
      const c = loadDigest()?.cases?.find((x) => x.id === case_id);
      if (!c) return fail(`案件が見つかりません: ${case_id}`);
      let thread: unknown = null;
      try { thread = getMailThread({ mail_id: c.mailId, account: c.accountEmail }); } catch (err) { thread = { error: (err as Error).message }; }
      return text({ case: c, canSend: canSend(c.accountEmail), thread });
    },
  );

  server.tool(
    'partner_style',
    '先生の文体・人物像・判断ルール・連絡先・学習ルール・最近の送信メール(見本)・署名を返す。下書きや催促文を書く前に読む',
    { account: z.string().optional().describe('見本と署名を取るアカウント(省略可)') },
    async ({ account }) => text(getStylePack(account)),
  );

  server.tool(
    'partner_decide',
    '「決めてください」の問いに先生の答えを記録する。続けて partner_set_draft で答えを反映した下書きを書く',
    { case_id: z.string(), answer: z.string().min(1).describe('先生の決定(選択肢の文言か自由記述)') },
    async ({ case_id, answer }) => {
      const r = withCase(case_id, (c) => {
        c.decision = { ...(c.decision ?? { question: '', options: [] }), answer, answeredAt: new Date().toISOString() };
      });
      if (!r.ok) return fail(r.error);
      appendJournal({ kind: 'decided', text: `決定(MCP): 「${r.c.subject.slice(0, 30)}」→ ${answer}`, caseId: case_id, accountEmail: r.c.accountEmail });
      return text({ status: 'done', case_id, next: 'partner_style を読み、先生の文体で下書きを書いて partner_set_draft に渡す' });
    },
  );

  server.tool(
    'partner_set_draft',
    '案件の返信下書きを保存する(本文のみ。署名・引用は送信時にアプリが付ける)。送るときは partner_send',
    { case_id: z.string(), body: z.string().min(1) },
    async ({ case_id, body }) => {
      const r = withCase(case_id, (c) => {
        c.draft = body;
        c.draftStatus = 'prepared';
        c.draftEdited = true;
        c.needsDraft = true;
      });
      if (!r.ok) return fail(r.error);
      return text({ status: 'done', case_id, length: body.length, canSend: canSend(r.c.accountEmail) });
    },
  );

  server.tool(
    'partner_send',
    '案件の返信を送信予定に載せる(既定は設定の猶予分後に送信、それまで取消可)。アプリ「調」が実際の送信を行う。SMTP 未設定のアカウントでは送れない',
    {
      case_id: z.string(),
      body: z.string().optional().describe('本文を差し替える場合。省略時は保存済みの下書き'),
      delay_minutes: z.number().int().min(0).max(1440).optional().describe('送信までの猶予(分)。省略時は設定値'),
      reply_scope: z.enum(['sender', 'all']).optional().describe('差出人のみ / 元メールの全員(省略時は案件の判定)'),
    },
    async ({ case_id, body, delay_minutes, reply_scope }) => {
      const digest = loadDigest();
      const c = digest?.cases?.find((x) => x.id === case_id);
      if (!digest || !c) return fail(`案件が見つかりません: ${case_id}`);
      const draft = (body ?? c.draft ?? '').trim();
      if (!draft) return fail('本文がありません(partner_set_draft で下書きを保存するか body を渡す)');
      if (!canSend(c.accountEmail)) return fail(`${c.accountEmail} は SMTP 未設定です。調の 設定 → 相棒 → アカウントの接続 で設定してください`);
      let rcpt;
      try { rcpt = resolveReplyRecipients(c.accountEmail, c.mailId, reply_scope ?? c.replyScope ?? 'sender'); } catch (err) { return fail((err as Error).message); }
      const delay = delay_minutes ?? sendDelayMinutes();
      const r = enqueueOutbox(loadOutbox(), {
        kind: 'reply', caseId: c.id, accountEmail: c.accountEmail, to: rcpt.to, cc: rcpt.cc,
        subject: replySubject(c.subject), body: draft, inReplyToMailId: c.mailId,
        label: `${c.fromName || c.fromAddress} へ「${c.subject.slice(0, 40)}」`, auto: false, via: 'mcp',
      }, delay);
      saveOutbox(r.store);
      if (body) { c.draft = body; c.draftEdited = true; }
      c.status = 'scheduled';
      c.outboxId = r.item.id;
      c.statusChangedAt = new Date().toISOString();
      saveDigest(digest);
      appendJournal({ kind: 'scheduled', text: `送信予定(MCP・${delay}分後): ${r.item.label}`, caseId: c.id, mailId: c.mailId, accountEmail: c.accountEmail });
      return text({ status: 'done', outbox_id: r.item.id, send_at: r.item.sendAt, to: rcpt.to, cc: rcpt.cc, subject: r.item.subject, note: '調が起動していれば送信時刻に送ります。取消は partner_cancel_send' });
    },
  );

  server.tool(
    'partner_cancel_send',
    '送信予定を取り消す(送信前のみ)',
    { outbox_id: z.string() },
    async ({ outbox_id }) => {
      const r = cancelOutbox(loadOutbox(), outbox_id);
      if (r.error || !r.item) return fail(r.error ?? '取り消せません');
      saveOutbox(r.store);
      if (r.item.caseId) withCase(r.item.caseId, (c) => { if (c.status === 'scheduled') { c.status = 'open'; c.outboxId = undefined; } });
      if (r.item.followUpId) {
        const list = loadFollowUps();
        const f = list.find((x) => x.id === r.item?.followUpId);
        if (f && f.status === 'nudged') { f.status = 'open'; f.outboxId = undefined; f.updatedAt = new Date().toISOString(); saveFollowUps(list); }
      }
      appendJournal({ kind: 'cancelled', text: `送信を取り消し(MCP): ${r.item.label}`, caseId: r.item.caseId, accountEmail: r.item.accountEmail });
      return text({ status: 'done', outbox_id });
    },
  );

  server.tool(
    'partner_case_status',
    '案件の状態を変える: done(済み) / later(後で) / dismissed(しない) / open(戻す)',
    { case_id: z.string(), status: z.enum(['open', 'done', 'later', 'dismissed']) },
    async ({ case_id, status }) => {
      const r = withCase(case_id, (c) => { c.status = status as ButlerCaseStatus; c.statusChangedAt = new Date().toISOString(); });
      if (!r.ok) return fail(r.error);
      appendJournal({ kind: status === 'done' ? 'closed' : 'decided', text: `案件を ${status} に(MCP): 「${r.c.subject.slice(0, 40)}」`, caseId: case_id, accountEmail: r.c.accountEmail });
      return text({ status: 'done', case_id, new_status: status });
    },
  );

  server.tool(
    'partner_followups',
    '返事待ち(先生が送って返事が無いスレッド)の一覧',
    {},
    async () => text(loadFollowUps().filter((f) => f.status !== 'closed')),
  );

  server.tool(
    'partner_nudge',
    '返事待ちの相手へ催促を送信予定に載せる(本文は呼び出し元が partner_style を踏まえて書く)',
    { followup_id: z.string(), body: z.string().min(1), delay_minutes: z.number().int().min(0).max(1440).optional() },
    async ({ followup_id, body, delay_minutes }) => {
      const list = loadFollowUps();
      const f = list.find((x) => x.id === followup_id);
      if (!f) return fail(`返事待ちが見つかりません: ${followup_id}`);
      if (!canSend(f.accountEmail)) return fail(`${f.accountEmail} は SMTP 未設定です`);
      const delay = delay_minutes ?? sendDelayMinutes();
      const r = enqueueOutbox(loadOutbox(), {
        kind: 'nudge', followUpId: f.id, accountEmail: f.accountEmail, to: [f.to || f.toAddress], cc: [],
        subject: replySubject(f.subject), body, inReplyToMailId: f.mailId,
        label: `${f.to.split('<')[0].trim() || f.toAddress} へ催促「${f.subject.slice(0, 40)}」`, auto: false, via: 'mcp',
      }, delay);
      saveOutbox(r.store);
      f.nudgeDraft = body; f.status = 'nudged'; f.outboxId = r.item.id; f.updatedAt = new Date().toISOString();
      saveFollowUps(list);
      appendJournal({ kind: 'nudged', text: `催促を送信予定(MCP・${delay}分後): ${r.item.label}`, accountEmail: f.accountEmail });
      return text({ status: 'done', outbox_id: r.item.id, send_at: r.item.sendAt });
    },
  );

  server.tool(
    'partner_followup_status',
    '返事待ちの状態を変える: closed(閉じる) / snoozed(まだ待つ) / open(戻す)',
    { followup_id: z.string(), status: z.enum(['open', 'closed', 'snoozed']), days: z.number().int().min(1).max(60).optional().describe('snoozed のとき何日待つか(既定3)') },
    async ({ followup_id, status, days }) => {
      const list = loadFollowUps();
      const f = list.find((x) => x.id === followup_id);
      if (!f) return fail(`返事待ちが見つかりません: ${followup_id}`);
      f.status = status;
      f.snoozeUntil = status === 'snoozed' ? new Date(Date.now() + (days ?? 3) * 86_400_000).toISOString() : undefined;
      f.updatedAt = new Date().toISOString();
      saveFollowUps(list);
      return text({ status: 'done', followup_id, new_status: status, snooze_until: f.snoozeUntil ?? null });
    },
  );

  server.tool(
    'partner_sender_rule',
    '送信者を「常に重要(vip)」「不要(noise)」として覚える(null で解除)。次回以降の判定に効く',
    { address: z.string().email(), tier: z.enum(['vip', 'noise']).nullable(), note: z.string().optional() },
    async ({ address, tier, note }) => {
      const rules = readJson<{ senders: Record<string, unknown>; domains: Record<string, unknown> }>(PATHS.rules) ?? { senders: {}, domains: {} };
      const key = address.trim().toLowerCase();
      if (tier === null) delete rules.senders[key];
      else rules.senders[key] = { tier, note, updatedAt: new Date().toISOString() };
      writeJson(PATHS.rules, rules);
      appendJournal({ kind: 'decided', text: `送信者ルール(MCP): ${key} → ${tier ?? '解除'}` });
      return text({ status: 'done', address: key, tier });
    },
  );

  server.tool(
    'partner_journal',
    '相棒の日誌(何をしたか)を新しい順に返す',
    { limit: z.number().int().min(1).max(200).default(40) },
    async ({ limit }) => text(readJournal(limit)),
  );

  server.tool(
    'partner_run',
    'アプリ「調」に今すぐ確認(新着の判定・下書き・返事待ちの更新)を頼む。調が起動している必要がある',
    {},
    async () => {
      requestRun('mcp');
      return text({ status: 'requested', note: '調が起動していれば数秒で確認が始まります。結果は partner_today で' });
    },
  );
}
