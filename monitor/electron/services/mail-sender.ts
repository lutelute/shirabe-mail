// === SMTP 送信(nodemailer) ===
//
// 相棒が先生の名前で送る唯一の出口。ここを通るものは必ず outbox(遅延+取消)を経ている。
//  - 返信ヘッダ(In-Reply-To / References)を付けてスレッドを壊さない
//  - 本文 = 下書き + 署名 + 引用(日本語メーラーの流儀)
//  - 送った生データを返す(送信済みフォルダへの APPEND に使う)

import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
// ESM(package.json type: module)ではディレクトリ指定が解決できないので index.js まで書く
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SmtpCredentials } from '../../src/types/index';

export interface SendInput {
  smtp: SmtpCredentials;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

export interface SendOutcome {
  messageId: string;
  raw: Buffer;
  accepted: string[];
  rejected: string[];
}

function transportFor(c: SmtpCredentials) {
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    requireTLS: !c.secure,
    auth: { user: c.user, pass: c.password },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

export async function verifySmtp(c: SmtpCredentials): Promise<{ success: boolean; error?: string }> {
  try {
    await transportFor(c).verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: friendlySmtpError((err as Error).message) };
  }
}

export function friendlySmtpError(msg: string): string {
  if (/535|invalid (login|credentials)|authentication failed|username and password not accepted/i.test(msg)) {
    return 'ユーザー名かパスワードが違います(Gmail はアプリパスワードが必要です)。';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'サーバーが見つかりません(ホスト名を確認)。';
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) return 'サーバーに接続できません(ポート・ネットワークを確認)。';
  return msg.slice(0, 200);
}

export function replySubject(subject: string): string {
  const s = (subject || '').trim();
  if (/^(re|回答)(\[\d+\])?\s*[:：]/i.test(s)) return s;
  return `Re: ${s}`;
}

export interface QuotedOriginal {
  fromText: string;
  dateText: string;
  toText: string;
  subject: string;
  body: string;
}

/** 下書き + 署名 + 引用 を組み立てる(署名・引用は空なら付けない) */
export function composeBody(draft: string, signature: string, original?: QuotedOriginal | null): string {
  const parts: string[] = [draft.trim()];
  const sig = (signature || '').trim();
  if (sig) parts.push('', sig);
  if (original && original.body.trim()) {
    const quoted = original.body.replace(/\r/g, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    parts.push(
      '',
      '------ 元のメッセージ ------',
      `差出人: ${original.fromText}`,
      `送信日時: ${original.dateText}`,
      `宛先: ${original.toText}`,
      `件名: ${original.subject}`,
      '',
      quoted,
    );
  }
  return parts.join('\n');
}

export function formatFrom(name: string, address: string): string {
  const n = (name || '').trim();
  return n ? `"${n.replace(/"/g, '')}" <${address}>` : address;
}

/** 送らずに RFC822 を組み立てる(eM Client の下書きフォルダへ置く用) */
export async function buildRawMessage(input: Omit<SendInput, 'smtp'>): Promise<{ messageId: string; raw: Buffer }> {
  const domain = input.from.address.split('@')[1] || 'shirabe.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const raw = await new MailComposer({
    from: formatFrom(input.from.name, input.from.address),
    to: input.to,
    cc: input.cc.length > 0 ? input.cc : undefined,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references || undefined,
    messageId,
    date: new Date(),
  }).compile().build();
  return { messageId, raw };
}

export async function sendMail(input: SendInput): Promise<SendOutcome> {
  const domain = input.from.address.split('@')[1] || 'shirabe.local';
  const messageId = `<${randomUUID()}@${domain}>`;
  const date = new Date();
  const mail = {
    from: formatFrom(input.from.name, input.from.address),
    to: input.to,
    cc: input.cc.length > 0 ? input.cc : undefined,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references || undefined,
    messageId,
    date,
  };
  const transport = transportFor(input.smtp);
  const info = await transport.sendMail(mail);
  const raw = await new MailComposer(mail).compile().build();
  return {
    messageId: info.messageId || messageId,
    raw,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}
