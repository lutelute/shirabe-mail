// === 先生の文体・判断材料を Claude Code に渡す(相棒の頭脳は呼び出し元) ===
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findAccount } from '../db/accounts.js';
import { withDbSync, getSentFolderIds } from '../utils.js';
import { openDbSync } from '../db/connection.js';
import { PATHS, readJson, signatureFor } from './store.js';

export const DEFAULT_PROFILE = `## 重信先生の人物像と判断スタイル
- 福井大学 学術研究院工学系部門 電気・電子工学講座の教員(電力系統・エネルギー分野)。研究室ドメイン pws.fuee.u-fukui.ac.jp は学生・スタッフ。
- 感謝と謝罪をきちんと書く丁寧な文体。関係性を大切にし、異動挨拶やお礼には気持ちを返す(流さない)。
- 学生には短く・優しく・体調最優先。延期や欠席を責めない。
- お金・日程は数字で詰める。平日日中の学外行事は制約が大きい。
- 締切は死守。公式書類(教務課・研究推進課・人事)の期限は最優先。
- 辞退・無視傾向: 面識のない海外ジャーナル/国際会議からの勧誘、商業広告、メルマガ。
- 定型文: 「いつも大変お世話になっております，重信です。」読点は全角カンマ「，」。`;

export const DRAFT_RULES = `返信下書きの書式:
- 1行目は宛名(「〇〇先生」「〇〇さま」「〇〇さん」)。2行目は空行。3行目は挨拶(学外・目上は「いつも大変お世話になっております，重信です。」、学内の親しい相手や学生は「重信です。」)。
- 本文は要点のみ 3〜8 行。相手の依頼・質問には必ず答える。読点は「，」、句点は「。」。
- 学生宛は短く優しく。先生が決めるべき事項が不明なら【 】で空欄にする。勝手に約束しない。
- 結びは「よろしくお願い致します。」。署名は書かない(送信時にアプリが付ける)。本文だけを返す。`;

function readIfExists(p: string, maxChars: number): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const t = fs.readFileSync(p, 'utf-8').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n…(省略)` : t;
  } catch {
    return null;
  }
}

export function resolveReferencesDir(): string | null {
  const home = os.homedir();
  const s = readJson<{ partnerReferencesDir?: string }>(PATHS.settings);
  const candidates = [
    s?.partnerReferencesDir,
    path.join(PATHS.settings, '..', 'references'),
    path.join(home, '.claude', 'skills', 'shirabe', 'references'),
    path.join(home, 'dev', 'github', 'claude-skills', 'skills', 'shirabe', 'references'),
    path.join(home, 'Documents', 'GitHub', 'claude-skills', 'skills', 'shirabe', 'references'),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p; } catch { /* broken link */ }
  }
  return null;
}

const QUOTE_RE = /^(>|On .{6,120} wrote:|-{2,}\s*(元のメッセージ|Original Message)|_{5,}$|(From|差出人)[:：]\s)/i;
const SIG_RE = /^(-- ?|={8,}|[-－_＿*＊]{8,})\s*$/;

export function cleanBody(raw: string, maxChars = 900): string {
  const kept: string[] = [];
  let n = 0;
  for (const line of (raw || '').replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (QUOTE_RE.test(t)) { if (t.startsWith('>')) continue; break; }
    if (n >= 2 && SIG_RE.test(t)) break;
    kept.push(line.replace(/\s+$/, ''));
    if (t) n += 1;
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** 先生が最近書いたメール本文(文体見本) */
export function getSentExemplars(accountEmail: string, n = 3): string[] {
  const acc = findAccount(accountEmail);
  const sent = getSentFolderIds(acc.accountUid, acc.mailSubdir);
  if (sent.size === 0) return [];
  const rows = withDbSync(acc.accountUid, acc.mailSubdir, 'mail_index.dat', (db) =>
    db.prepare(`SELECT id, subject FROM MailItems WHERE folder IN (${[...sent].join(',')}) AND (flags & 65536) = 0 AND subject NOT LIKE 'Fw%' ORDER BY date DESC LIMIT 40`).all() as Array<{ id: number; subject: string }>,
  );
  let fti: ReturnType<typeof openDbSync> | null = null;
  try { fti = openDbSync(acc.accountUid, acc.mailSubdir, 'mail_fti.dat'); } catch { return []; }
  const out: string[] = [];
  try {
    const stmt = fti.prepare('SELECT c1partName AS partName, c2content AS content FROM LocalMailsIndex3_content WHERE c0id = ?');
    for (const r of rows) {
      let parts: Array<{ partName: string; content: string }> = [];
      try { parts = stmt.all(r.id) as Array<{ partName: string; content: string }>; } catch { continue; }
      const pick = parts.find((p) => ['TEXT', '1', '1.1'].includes(p.partName)) ?? parts[0];
      const body = cleanBody(pick?.content ?? '');
      if (body.length < 60 || body.length > 900) continue;
      out.push(`件名: ${r.subject}\n${body}`);
      if (out.length >= n) break;
    }
  } finally {
    fti.close();
  }
  return out;
}

export interface StylePack {
  profile: string;
  decisionRules: string;
  contacts: string;
  learnedRules: string;
  exemplars: string[];
  signature: string;
  draftRules: string;
  sources: string[];
}

export function getStylePack(accountEmail?: string): StylePack {
  const sources: string[] = [];
  const profile = readIfExists(PATHS.profile, 4000);
  if (profile) sources.push('butler-profile.md');
  const ref = resolveReferencesDir();
  const decisionRules = ref ? readIfExists(path.join(ref, 'decision-rules.md'), 5000) : null;
  if (decisionRules) sources.push('decision-rules.md');
  const contacts = ref ? readIfExists(path.join(ref, 'contacts.md'), 5000) : null;
  if (contacts) sources.push('contacts.md');
  const rules = readJson<{ senders?: Record<string, { tier: string; note?: string }>; domains?: Record<string, { tier: string; note?: string }> }>(PATHS.rules);
  const learned: string[] = [];
  for (const [k, r] of Object.entries(rules?.senders ?? {})) learned.push(`- ${k}: ${r.tier === 'vip' ? '常に重要' : '不要'}${r.note ? ` — ${r.note}` : ''}`);
  for (const [k, r] of Object.entries(rules?.domains ?? {})) learned.push(`- @${k}: ${r.tier === 'vip' ? '常に重要' : '不要'}${r.note ? ` — ${r.note}` : ''}`);
  let exemplars: string[] = [];
  if (accountEmail) { try { exemplars = getSentExemplars(accountEmail, 3); } catch { /* optional */ } }
  return {
    profile: profile ?? DEFAULT_PROFILE,
    decisionRules: decisionRules ?? '',
    contacts: contacts ?? '',
    learnedRules: learned.join('\n'),
    exemplars,
    signature: accountEmail ? signatureFor(accountEmail) : '',
    draftRules: DRAFT_RULES,
    sources,
  };
}
