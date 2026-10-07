// === 夜間執事の「頭脳」: 判断コンテキストとプロンプト ===
//
// v1 は「件名+プレビュー256文字」を reply/todo の2値に分けるだけだった。
// v2 は秘書として振る舞う:
//   - 先生の人物像・判断ルール・連絡先・学習ルール(先生の訂正)を毎回読み込む
//   - 送信者との付き合いの深さ(返信履歴)、宛先位置(To/Cc/ML)、スレッドの状態を材料にする
//   - 本文全文を読んで「先生が何をすべきか」「期限」「優先度」を構造化して返す
//   - 返信下書きは先生の実際の送信メールを文体見本にして書く

import * as fs from 'fs';
import * as path from 'path';
import type { ClaudeRunner } from './claude-runner';
import type { ThreadContextMessage } from './mail-intel';
import { rulesToPromptText, tierFromRules, normalizeAddress, domainOf } from './butler-rules';
import type {
  ButlerRules,
  ButlerCaseCategory,
  ButlerPriority,
  SenderTier,
  SenderStats,
  ReplyKind,
  CaseDecision,
  CaseEvent,
} from '../../src/types/index';

// ---------- 判断コンテキスト ----------

export interface JudgmentContext {
  today: string;               // YYYY-MM-DD(ローカル)
  profile: string;
  decisionRules: string;
  contacts: string;
  contactAddresses: Set<string>;
  learnedRules: string;
  myAddresses: string[];
  sources: string[];           // 読み込めたファイル(表示用)
}

export interface JudgmentSources {
  homeDir: string;
  userDataDir: string;
  referencesDir?: string;   // 設定で指定(空なら自動検出)
}

/** 連絡先・判断ルールの置き場所の候補(シンボリックリンク切れに備えて複数見る) */
export function resolveReferencesDir(src: JudgmentSources): string | null {
  const candidates = [
    src.referencesDir,
    path.join(src.userDataDir, 'references'),
    path.join(src.homeDir, '.claude', 'skills', 'shirabe', 'references'),
    path.join(src.homeDir, 'dev', 'github', 'claude-skills', 'skills', 'shirabe', 'references'),
    path.join(src.homeDir, 'Documents', 'GitHub', 'claude-skills', 'skills', 'shirabe', 'references'),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
    } catch { /* broken symlink etc. */ }
  }
  return null;
}

// 先生の人物像(既定)。userData/butler-profile.md があればそちらを優先。
export const DEFAULT_PROFILE = `## 重信先生の人物像と判断スタイル
- 福井大学 学術研究院工学系部門 電気・電子工学講座の教員(電力系統・エネルギー分野)。研究室ドメイン pws.fuee.u-fukui.ac.jp は学生・スタッフ。
- 感謝と謝罪をきちんと書く丁寧な文体。関係性を大切にし、異動挨拶やお礼には気持ちを返す(流さない)。
- 学生には短く・優しく・体調最優先。延期や欠席を責めない。
- 抱え込みがち。運営・調整の負荷が一人に集中している案件は「分担・委譲」を提案してよい。
- お金・日程は数字で詰める(金額、候補日、終電逆算)。平日日中の学外行事は制約が大きい。
- 即対応する相手: 指導教員(伊藤先生 itomasa@u-fukui.ac.jp)、研究推進課(河合さん)、講座事務(榎本さん)、講座長(塩島先生)、教務課(kyoumu-eng@ml.u-fukui.ac.jp)、共同研究先の担当者(東電・北陸電力・エナリス・三菱総研 等)、研究室の学生。
- 締切は死守。公式書類(教務課・研究推進課・人事)の期限は最優先。
- 辞退・無視傾向: 面識のない海外ジャーナル/国際会議からの投稿・査読・登壇・編集委員の勧誘、商業広告、メルマガ、セミナー宣伝。
- 定型文: 「いつも大変お世話になっております，重信です。」読点は全角カンマ「，」。`;

function readIfExists(p: string, maxChars: number): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    let t = fs.readFileSync(p, 'utf-8');
    t = t.replace(/<!--[\s\S]*?-->/g, '');   // 記入例コメントを除去
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n…(省略)` : t;
  } catch {
    return null;
  }
}

function localDateString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function buildJudgmentContext(src: JudgmentSources, rules: ButlerRules, myAddresses: string[]): JudgmentContext {
  const sources: string[] = [];
  const refDir = resolveReferencesDir(src);

  const profilePath = path.join(src.userDataDir, 'butler-profile.md');
  const profile = readIfExists(profilePath, 4000);
  if (profile) sources.push('butler-profile.md');

  const decisionRules = refDir ? readIfExists(path.join(refDir, 'decision-rules.md'), 5000) : null;
  if (decisionRules) sources.push('decision-rules.md');
  const contacts = refDir ? readIfExists(path.join(refDir, 'contacts.md'), 5000) : null;
  if (contacts) sources.push('contacts.md');
  const preferences = refDir ? readIfExists(path.join(refDir, 'preferences.md'), 3000) : null;
  if (preferences) sources.push('preferences.md');

  const contactAddresses = new Set<string>();
  for (const m of (contacts ?? '').matchAll(EMAIL_RE)) contactAddresses.add(m[0].toLowerCase());
  for (const m of DEFAULT_PROFILE.matchAll(EMAIL_RE)) contactAddresses.add(m[0].toLowerCase());
  for (const m of (profile ?? '').matchAll(EMAIL_RE)) contactAddresses.add(m[0].toLowerCase());

  return {
    today: localDateString(),
    profile: (profile ?? DEFAULT_PROFILE) + (preferences ? `\n\n## 先生の流儀(preferences)\n${preferences}` : ''),
    decisionRules: decisionRules ?? '',
    contacts: contacts ?? '',
    contactAddresses,
    learnedRules: rulesToPromptText(rules),
    myAddresses: myAddresses.map((a) => a.toLowerCase()),
    sources,
  };
}

// ---------- 決定論的な判定(AIの前段) ----------

// 自動送信・一斉配信のアドレス形。局所部の接頭辞 / 局所部のどこか / サブドメインの3段で見る
const AUTO_LOCALPART_RE = /^(noreply|no-reply|no_reply|donotreply|do-not-reply|do_not_reply|newsletter|newsletters|mailer|mailer-daemon|notification|notifications|notify|bounce|bounces|campaign|marketing|promo|promotion|em|news|mail|email|info|support|alert|alerts|system|admin|updates|digest|magazine|mailmag|reminder|receipt|receipts|billing|payment|payments|calendar|customer|member|members|service|hello|team|contact)([-_.+].*)?$/i;
const AUTO_LOCALPART_ANY_RE = /(noreply|no-reply|no_reply|donotreply|newsletter|magazine|mailmag|notification|marketing|campaign|unsubscribe)/i;
const AUTO_DOMAIN_RE = /^(mail|email|market|marketing|news|newsletter|info|notify|notification|notifications|bounce|em|e|mailer|campaign|promo|updates|mkt|mg|msg|send|smtp)[0-9]*\./i;

export function tierFor(
  address: string,
  stats: SenderStats | undefined,
  rules: ButlerRules,
  ctx: JudgmentContext,
): SenderTier {
  const addr = normalizeAddress(address);
  if (!addr) return 'unknown';
  const ruled = tierFromRules(rules, addr);
  if (ruled) return ruled;
  if (ctx.contactAddresses.has(addr)) return 'vip';
  // メーリングリスト/一斉配信のアドレスは「常連」扱いにしない(返信でCcに入り送信数が膨らむため)
  const domEarly = domainOf(addr);
  const isList = domEarly.startsWith('ml.') || /(^|[.-])ml($|[.-])/.test(addr.slice(0, addr.indexOf('@'))) || /(-all|-members|-menb|-list|^all-|^list-)/.test(addr.slice(0, addr.indexOf('@')));
  if (isList) return domEarly === 'u-fukui.ac.jp' || domEarly.endsWith('.u-fukui.ac.jp') ? 'internal' : 'auto';
  if (stats) {
    if (stats.replied >= 3 || stats.sentTo >= 3) return 'vip';
    if (stats.replied >= 1 || stats.sentTo >= 1) return 'known';
  }
  const dom = domainOf(addr);
  if (dom === 'u-fukui.ac.jp' || dom.endsWith('.u-fukui.ac.jp')) return 'internal';
  const local = addr.slice(0, addr.indexOf('@'));
  if (AUTO_LOCALPART_RE.test(local) || AUTO_LOCALPART_ANY_RE.test(local) || AUTO_DOMAIN_RE.test(dom)) return 'auto';
  return 'unknown';
}

export const TIER_LABEL: Record<SenderTier, string> = {
  vip: '常連',
  internal: '学内',
  known: '面識あり',
  auto: '自動送信',
  unknown: '初見',
  noise: '不要(学習)',
};

const PROMO_KEYWORDS = [
  'unsubscribe', '配信停止', '購読解除', 'メルマガ', 'newsletter', 'セール', 'キャンペーン', 'クーポン',
  '広告', 'sale', 'discount', 'promotion', 'opt out', 'opt-out', 'limited time', '期間限定', '特別価格',
  'special offer', 'click here', 'act now', '今すぐ', '%off', '％off', '割引', '無料', 'webinar', 'ウェビナー',
  'お知らせメール', 'メール配信', '当選', 'congratulations', 'verify your account', 'アカウントを確認',
  'このメールは自動送信', '自動送信です', '返信いただいても', '配信解除', '配信の停止', '受信設定', 'view in browser', 'view this email',
  '画像が表示されない', 'オファー', '新登場', 'ポイント', 'お得', '限定', 'クレジット', 'メールマガジン', 'プレゼント', 'ギフト',
  'coupon', 'deal', 'offer', 'shop now', 'free shipping', '送料無料', 'おすすめ', 'ランキング',
];
const CFP_RE = /(call for (papers|participation|submissions|abstracts)|special issue|invitation to (submit|review|join|serve|contribute|speak|present|publish)|editorial board|guest editor|reviewer invitation|invited (speaker|talk)|keynote|abstract submission|early bird|registration (is )?(now )?open|we invite you|your expertise is invited|top-cited|highly cited|impact factor|article processing|publication fee|manuscript|journal of|international journal|hindawi|mdpi|frontiers in|bentham|omics|scirp|conference (alert|invitation)|last call|final call|deadline extended|\bcfp\b)/i;
const RECRUIT_RE = /(bizreach|ビズリーチ|求人|転職|スカウト|求職|採用のご案内|案件のご紹介)/i;

/** 明らかな一斉配信・勧誘か(AIを呼ばずに noise 扱いにする) */
export function looksLikeBulk(input: { fromAddress: string; subject: string; text: string; tier: SenderTier }): boolean {
  if (input.tier === 'vip' || input.tier === 'known' || input.tier === 'internal') return false;
  const subject = input.subject ?? '';
  const text = `${subject} ${input.text ?? ''}`.toLowerCase();
  if (CFP_RE.test(subject) || CFP_RE.test(text.slice(0, 600))) return true;
  if (RECRUIT_RE.test(text)) return true;
  let hits = 0;
  for (const kw of PROMO_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) hits += 1;
    if (hits >= 2) return true;
  }
  if (input.tier === 'auto' && hits >= 1) return true;
  return false;
}

/** ほぼ確実にスパム(サーバー側の [SPAM] マーク、または典型パターンの重なり) */
export function looksLikeSpam(input: { isSpamFlagged: boolean; fromAddress: string; fromName: string; subject: string; tier: SenderTier }): { spam: boolean; reason: string } {
  if (input.isSpamFlagged) return { spam: true, reason: 'サーバー側で迷惑メール判定済み' };
  if (input.tier === 'vip' || input.tier === 'known' || input.tier === 'internal') return { spam: false, reason: '' };
  const s = input.subject ?? '';
  const name = input.fromName ?? '';
  const addr = input.fromAddress ?? '';
  // ブランド名を騙る + 無関係ドメイン(A m a z o n / パテック フィリップ / ルイ・ヴィトン ...)
  const brandish = /(amazon|a\s+m\s+a\s+z\s+o\s+n|パテック|ロレックス|rolex|ヴィトン|vuitton|hermès|hermes|エルメス|オメガ|omega|prime|nhk|三井住友|smbc|楽天|イオン|ペイペイ|paypay|えきねっと|etc利用|マイナポータル|国税庁|総務省)/i;
  const shadyDomain = /\.(cn|ru|top|xyz|club|work|site|shop|icu|buzz|cfd|lol)$|[0-9]{3,}|-(cn|zh)-|okooo|jiuyou|fishhunte|raristu|tuwaw|hazelon/i;
  if (brandish.test(`${name} ${s}`) && shadyDomain.test(addr)) return { spam: true, reason: 'ブランド名を騙る不審な送信元' };
  if (/(90|80|70|95)\s*[%％]\s*(off|オフ|割引)/i.test(s)) return { spam: true, reason: '極端な割引を謳う広告' };
  return { spam: false, reason: '' };
}

// ---------- 分類 ----------

export interface CaseInput {
  id: string;
  accountEmail: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  tier: SenderTier;
  stats?: SenderStats;
  addressedToMe: 'to' | 'cc' | 'list' | 'unknown';
  receivedAt: string;
  threadCount: number;
  myReplies: number;
  lastFromMe: boolean;
  body: string;
  history: Array<{ date: string; who: string; excerpt: string }>;
}

export interface CaseJudgment {
  id: string;
  category: ButlerCaseCategory;
  priority: ButlerPriority;
  ask: string;
  summary: string;
  deadline: string | null;
  suggestedAction: string;
  reason: string;
  needsDraft: boolean;
  draftHint?: string;
  // v3
  replyKind: ReplyKind;
  autoSendSafe: boolean;
  replyScope: 'sender' | 'all';
  decision: CaseDecision | null;
  event: CaseEvent | null;
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    cases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: ['reply', 'action', 'fyi', 'noise', 'spam'] },
          priority: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] },
          ask: { type: 'string' },
          summary: { type: 'string' },
          deadline: { type: ['string', 'null'] },
          suggestedAction: { type: 'string' },
          reason: { type: 'string' },
          needsDraft: { type: 'boolean' },
          draftHint: { type: 'string' },
          replyKind: { type: 'string', enum: ['ack', 'thanks', 'schedule', 'answer', 'accept', 'decline', 'other'] },
          autoSendSafe: { type: 'boolean' },
          replyScope: { type: 'string', enum: ['sender', 'all'] },
          decision: {
            type: ['object', 'null'],
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['question', 'options'],
          },
          event: {
            type: ['object', 'null'],
            properties: {
              title: { type: 'string' },
              start: { type: 'string' },
              end: { type: ['string', 'null'] },
              allDay: { type: 'boolean' },
              location: { type: 'string' },
              kind: { type: 'string', enum: ['meeting', 'deadline', 'event', 'other'] },
            },
            required: ['title', 'start', 'allDay', 'kind'],
          },
        },
        required: ['id', 'category', 'priority', 'ask', 'summary', 'deadline', 'suggestedAction', 'reason', 'needsDraft', 'replyKind', 'autoSendSafe', 'replyScope', 'decision', 'event'],
      },
    },
  },
  required: ['cases'],
};

export const SYSTEM_CLASSIFY = `あなたは福井大学 重信颯人先生の有能な秘書「調(しらべ)」です。先生の受信メールを読み、先生が「何をすべきか」を判断して構造化データで返します。

判断原則:
1. ask には「先生自身に求められている行動」だけを1文で書く(他人宛の依頼や情報共有は fyi)。主語は省き「〜に9/12までに候補日を回答する」の形。
2. priority: P1 = 今日〜2日以内に動く(期限が3日以内 / 相手が催促している / VIP・学内公式からの直接依頼 / 学生の緊急事) , P2 = 今週中 , P3 = いずれ・読めばよい , P4 = 対応不要。
3. category: reply = 返信が必要 / action = 返信以外の作業(提出・支払い・登録・フォーム回答・出欠登録・押印など) / fyi = 読むだけでよい / noise = 不要(勧誘・宣伝・無関係) / spam = 迷惑メール。
4. deadline: 件名・本文にある回答期限・提出期限・支払期限を YYYY-MM-DD で。相対表現(今週中・来週月曜)は今日の日付から解決。無ければ null。開催日と締切を混同しない。
5. reason: 根拠を一言(相手との関係・返信履歴・宛先位置・期限・催促の有無)。判断ルールや学習ルールを使ったら「ルール: …」と明記。
6. needsDraft: 返信文を用意すれば先生が楽になる場合 true(確認・お礼・日程回答・受諾/辞退・簡単な質問への回答)。先生の意向が不明な判断案件は true にして draftHint に選択肢や埋めるべき点を書く。fyi/noise/spam は false。
7. 送信者との付き合いの深さ(受信/返信/送信数)と宛先位置を重視する。返信履歴が多い相手は重要。Cc や ML のみで自分宛の依頼が無ければ fyi にする。ただし ML 経由でも「各教員は〜してください」「回答〆切」のような全員宛の作業依頼は action。
8. スレッドで最後の発言が先生自身なら相手待ち → fyi か P3。相手からの再送・催促(「ご回答いただいていない」)は P1。
9. 学生(研究室ドメイン・学生ID)からの相談・体調連絡は優しく即対応 → reply P1。
10. 面識のない海外ジャーナル/会議からの投稿・査読・登壇・編集委員の勧誘、商用セミナー宣伝は noise。
11. summary は 2 行以内。相手が誰で、何の案件で、今どういう状態かを書く。
12. suggestedAction は短い動詞句: 「返信する」「候補日を回答」「フォームに回答」「書類を提出」「支払い手続き」「出欠を登録」「学生に返事」「読むだけ」「無視でよい」など。
13. replyKind: 返信の種類。ack = 受領・了解の返事 / thanks = お礼 / schedule = 日程の回答・確定 / answer = 質問への回答 / accept = 受諾 / decline = 辞退 / other。reply 以外は other。
14. decision: 先生本人が決めないと返事が書けない事項があれば {question, options} を1つだけ。question は「〜しますか?」の1文、options は2〜4個の短い選択肢(例: ["出席する","欠席する","候補日を出す"])。自由記述が要るなら options に「自分で書く」を含める。決めることが無ければ null。needsDraft が true でも decision があれば下書きは答えの後に作る。
15. autoSendSafe: 先生の判断なしに相棒が送っても安全なら true。条件: category が reply、decision が null、replyKind が ack / thanks / schedule(既に確定した日程の了解)のどれか、相手が常連・学内・面識あり、そして金銭・契約・評価・採否・学生の進路や成績・謝罪・対外的な約束・初めての相手を含まない。少しでも迷えば false。
16. replyScope: 元メールに自分以外の宛先(To/Cc)が複数いて全員が経緯を共有すべきなら all、そうでなければ sender。学内の事務連絡・複数人での日程調整は all が多い。
17. event: 先生が出る(または押さえるべき)会議・打合せ・行事・審査・締切の日時が本文に具体的に書かれていれば1つだけ。title は短く(「北陸支部役員会」「エナリス定例」)、start は YYYY-MM-DDTHH:MM(時刻不明・終日は YYYY-MM-DD で allDay true)、年は今日の日付から補う。end は分かれば。kind は meeting / deadline(提出・回答期限) / event(講演・行事) / other。候補日の列挙・未確定の調整中・過去の日付は null。
必ず全案件を id ごとに返す。`;

function statsText(s?: SenderStats): string {
  if (!s) return '履歴なし';
  return `受信${s.received}/先生の返信${s.replied}/先生から送信${s.sentTo}`;
}

const TO_LABEL: Record<CaseInput['addressedToMe'], string> = {
  to: 'To(自分宛)',
  cc: 'Cc',
  list: 'メーリングリスト/一斉',
  unknown: '不明',
};

export function buildClassifyPrompt(ctx: JudgmentContext, inputs: CaseInput[]): string {
  const parts: string[] = [];
  parts.push(`今日の日付: ${ctx.today}`);
  parts.push(`先生のメールアドレス: ${ctx.myAddresses.join(', ')}`);
  parts.push('');
  parts.push(ctx.profile);
  if (ctx.decisionRules) parts.push(`\n## 先生の判断ルール(最優先で参照)\n${ctx.decisionRules}`);
  if (ctx.contacts) parts.push(`\n## 関係者一覧\n${ctx.contacts}`);
  if (ctx.learnedRules) parts.push(`\n## 学習ルール(先生が直接指定。必ず従う)\n${ctx.learnedRules}`);
  parts.push('\n---\n## 判定する案件');
  inputs.forEach((c, i) => {
    parts.push(`\n### 案件 ${i + 1} (id: ${c.id})`);
    parts.push(`件名: ${c.subject || '(件名なし)'}`);
    parts.push(`差出人: ${c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress} | 関係: ${TIER_LABEL[c.tier]}(${statsText(c.stats)}) | 宛先位置: ${TO_LABEL[c.addressedToMe]}`);
    parts.push(`受信: ${c.receivedAt} | スレッド: ${c.threadCount}通(先生の返信${c.myReplies}回、最後の発言は${c.lastFromMe ? '先生' : '相手'})`);
    parts.push(`本文:\n${c.body || '(本文なし)'}`);
    if (c.history.length > 0) {
      parts.push('過去の経緯(古い順・抜粋):');
      for (const h of c.history) parts.push(`- ${h.date} ${h.who}: ${h.excerpt}`);
    }
  });
  parts.push('\n上記の全案件について判定を返してください。');
  return parts.join('\n');
}

export interface ClassifyOutcome {
  judgments: Map<string, CaseJudgment>;
  aiCalls: number;
  costUsd: number;
  errors: string[];
}

const VALID_CATEGORY = new Set(['reply', 'action', 'fyi', 'noise', 'spam']);
const VALID_PRIORITY = new Set(['P1', 'P2', 'P3', 'P4']);
const VALID_REPLY_KIND = new Set(['ack', 'thanks', 'schedule', 'answer', 'accept', 'decline', 'other']);

/** CLI 経由で混ざることのある置換文字(U+FFFD)を落とす */
export function cleanAiText(s: unknown): string {
  return String(s ?? '').replace(/\uFFFD/g, '').trim();
}

/** AI の event を検証。日付が読めない・過去(昨日より前)なら null */
export function normalizeEvent(raw: unknown, today: string): CaseEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<CaseEvent>;
  const title = String(e.title ?? '').trim();
  const m = String(e.start ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!title || !m) return null;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const yesterday = new Date(`${today}T00:00:00`); yesterday.setDate(yesterday.getDate() - 1);
  if (new Date(`${day}T00:00:00`).getTime() < yesterday.getTime()) return null;
  const allDay = !!e.allDay || !m[4];
  const start = allDay ? day : `${day}T${m[4].padStart(2, '0')}:${m[5]}`;
  let end: string | null = null;
  const me = String(e.end ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (me) {
    const eday = `${me[1]}-${me[2].padStart(2, '0')}-${me[3].padStart(2, '0')}`;
    end = allDay || !me[4] ? eday : `${eday}T${me[4].padStart(2, '0')}:${me[5]}`;
  }
  const kind = (['meeting', 'deadline', 'event', 'other'] as const).includes(e.kind as 'meeting') ? (e.kind as CaseEvent['kind']) : 'other';
  return { title, start, end, allDay, location: e.location ? String(e.location).trim() : undefined, kind };
}

/** AI の decision を検証(問いと 1〜5 個の選択肢が揃っていなければ null) */
export function normalizeDecision(raw: unknown): CaseDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as { question?: unknown; options?: unknown };
  const question = cleanAiText(d.question);
  const options = Array.isArray(d.options) ? d.options.map((o) => cleanAiText(o)).filter(Boolean).slice(0, 5) : [];
  if (!question || options.length === 0) return null;
  return { question, options: Array.from(new Set(options)) };
}

export function normalizeDeadline(raw: string | null | undefined, today: string): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{4})[/年](\d{1,2})[/月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/月](\d{1,2})/);
  if (m) {
    // 年なし → 今日以降で最も近い年
    const y = Number(today.slice(0, 4));
    const cand = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return cand < today ? `${y + 1}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : cand;
  }
  return null;
}

export async function classifyCases(
  runner: ClaudeRunner,
  ctx: JudgmentContext,
  inputs: CaseInput[],
  model: string,
  opts?: { batchSize?: number; onProgress?: (done: number, total: number) => void },
): Promise<ClassifyOutcome> {
  const out: ClassifyOutcome = { judgments: new Map(), aiCalls: 0, costUsd: 0, errors: [] };
  if (inputs.length === 0) return out;
  const batchSize = Math.max(1, opts?.batchSize ?? 6);
  const batches: CaseInput[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) batches.push(inputs.slice(i, i + batchSize));

  let done = 0;
  const absorb = (batch: CaseInput[], data: { cases?: Partial<CaseJudgment>[] }) => {
    for (const j of data.cases ?? []) {
      if (!j || typeof j.id !== 'string') continue;
      if (!batch.some((b) => b.id === j.id)) continue;
      out.judgments.set(j.id, {
        id: j.id,
        category: (VALID_CATEGORY.has(String(j.category)) ? j.category : 'fyi') as ButlerCaseCategory,
        priority: (VALID_PRIORITY.has(String(j.priority)) ? j.priority : 'P3') as ButlerPriority,
        ask: cleanAiText(j.ask),
        summary: cleanAiText(j.summary),
        deadline: normalizeDeadline(j.deadline ?? null, ctx.today),
        suggestedAction: cleanAiText(j.suggestedAction),
        reason: cleanAiText(j.reason),
        needsDraft: !!j.needsDraft,
        draftHint: j.draftHint ? String(j.draftHint).trim() : undefined,
        replyKind: (VALID_REPLY_KIND.has(String(j.replyKind)) ? j.replyKind : 'other') as ReplyKind,
        autoSendSafe: !!j.autoSendSafe && j.category === 'reply' && !normalizeDecision(j.decision),
        replyScope: j.replyScope === 'all' ? 'all' : 'sender',
        decision: normalizeDecision(j.decision),
        event: normalizeEvent(j.event, ctx.today),
      });
    }
  };
  // 失敗したバッチは半分に割って1〜2段まで再試行(1件の失敗で6件を道連れにしない)
  const runBatch = async (batch: CaseInput[], label: string, depth: number): Promise<void> => {
    const res = await runner.run<{ cases: Partial<CaseJudgment>[] }>({
      label,
      model,
      systemPrompt: SYSTEM_CLASSIFY,
      prompt: buildClassifyPrompt(ctx, batch),
      schema: CLASSIFY_SCHEMA,
      timeoutMs: 150_000,
    });
    out.aiCalls += 1;
    out.costUsd += res.costUsd;
    if (!res.ok || !res.data) {
      if (batch.length > 1 && depth < 2) {
        const mid = Math.ceil(batch.length / 2);
        await Promise.all([
          runBatch(batch.slice(0, mid), `${label}a`, depth + 1),
          runBatch(batch.slice(mid), `${label}b`, depth + 1),
        ]);
        return;
      }
      out.errors.push(res.error ?? '分類に失敗しました');
      return;
    }
    absorb(batch, res.data);
  };

  await Promise.all(
    batches.map(async (batch, bi) => {
      await runBatch(batch, `classify#${bi + 1}`, 0);
      done += 1;
      opts?.onProgress?.(done, batches.length);
    }),
  );
  // 応答から漏れた案件があれば、まとめてもう一度だけ聞く
  const missing = inputs.filter((i) => !out.judgments.has(i.id));
  if (missing.length > 0 && missing.length < inputs.length) {
    await runBatch(missing.slice(0, batchSize), 'classify#retry', 2);
  }
  return out;
}

// ---------- 返信下書き ----------

export const SYSTEM_DRAFT = `あなたは福井大学の重信颯人先生の秘書として、先生本人が送る返信メールの下書きを書きます。

書式ルール:
- 1行目は宛名(「〇〇先生」「〇〇さま」「〇〇さん」)。呼称は相手の署名や過去のやりとりに合わせる。
- 2行目は空行。3行目は挨拶。学外・目上・久しぶりの相手は「いつも大変お世話になっております，重信です。」、学内の親しい相手や学生は「重信です。」でよい。
- 本文は要点のみ、3〜8行。相手の依頼・質問には必ず答える(受諾/辞退/回答/候補日)。
- 読点は全角カンマ「，」、句点は「。」。敬語は丁寧だが硬すぎない。感謝や恐縮の一言を自然に入れる。
- 学生宛は短く優しく、体調や事情を最優先する。責めない。
- 先生が決めるべき事項(候補日・金額・可否・数値)が不明なら【 】で空欄にする(例:【候補日を記入】【可否】)。勝手に約束・断言しない。
- 結びは「よろしくお願い致します。」「引き続きよろしくお願い致します。」など。署名は書かない(メーラーが付ける)。
- 出力は本文のみ。件名・説明・前置き・コードブロックは書かない。`;

export interface DraftParams {
  subject: string;
  fromName: string;
  fromAddress: string;
  thread: ThreadContextMessage[];
  exemplars: string[];
  ask: string;
  draftHint?: string;
  instruction?: string;
  existingDraft?: string;
  decisionQuestion?: string;   // 先生に聞いた問い
  decisionAnswer?: string;     // 先生の答え(これを本文に反映する)
}

export function buildDraftPrompt(ctx: JudgmentContext, p: DraftParams): string {
  const parts: string[] = [];
  parts.push(`今日の日付: ${ctx.today}`);
  parts.push(ctx.profile);
  if (p.exemplars.length > 0) {
    parts.push('\n## 先生が実際に書いた最近のメール(文体の見本。宛名・挨拶・句読点・結びをこの流儀に合わせる)');
    p.exemplars.forEach((e, i) => parts.push(`\n--- 見本 ${i + 1} ---\n${e}`));
  }
  parts.push('\n## 返信する案件');
  parts.push(`件名: ${p.subject}`);
  parts.push(`相手: ${p.fromName ? `${p.fromName} <${p.fromAddress}>` : p.fromAddress}`);
  parts.push(`先生がすべきこと: ${p.ask || '(未指定)'}`);
  if (p.draftHint) parts.push(`下書きの方針メモ: ${p.draftHint}`);
  if (p.decisionAnswer) {
    parts.push(`\n## 先生の決定(必ず本文に反映し、この点は【 】で空欄にしない)`);
    if (p.decisionQuestion) parts.push(`問い: ${p.decisionQuestion}`);
    parts.push(`答え: ${p.decisionAnswer}`);
  }
  parts.push('\n## スレッド(古い順)');
  for (const m of p.thread) {
    const d = m.date instanceof Date ? m.date : new Date(m.date);
    const stamp = isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    parts.push(`\n--- ${m.isSentByMe ? '先生(自分)' : m.from} (${stamp}) ---`);
    if (m.to.length > 0) parts.push(`To: ${m.to.join(', ')}`);
    if (m.cc.length > 0) parts.push(`Cc: ${m.cc.join(', ')}`);
    parts.push(m.body || '(本文なし)');
  }
  if (p.existingDraft) parts.push(`\n## 現在の下書き(これを改善する)\n${p.existingDraft}`);
  if (p.instruction) parts.push(`\n## 先生からの追加指示\n${p.instruction}`);
  parts.push('\n最新のメールへの返信本文だけを出力してください。');
  return parts.join('\n');
}

export async function draftReply(
  runner: ClaudeRunner,
  ctx: JudgmentContext,
  p: DraftParams,
  model: string,
): Promise<{ ok: boolean; draft: string; error?: string; costUsd: number }> {
  const res = await runner.run<unknown>({
    label: 'draft',
    model,
    systemPrompt: SYSTEM_DRAFT,
    prompt: buildDraftPrompt(ctx, p),
    timeoutMs: 150_000,
  });
  if (!res.ok) return { ok: false, draft: '', error: res.error, costUsd: res.costUsd };
  let text = res.text.trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!text) return { ok: false, draft: '', error: '空の下書きが返りました', costUsd: res.costUsd };
  return { ok: true, draft: text, costUsd: res.costUsd };
}

// ---------- 朝の申し送り ----------

export const SYSTEM_BRIEF = `あなたは重信先生の相棒「調(しらべ)」。先生が画面を開いた最初に読む申し送りを書く。
- 時間帯に合った挨拶(朝=おはようございます / 昼・午後=お疲れさまです / 夜=お疲れさまです)で始め、2〜4文・300字以内。文章で(箇条書き禁止)。
- 順番: 今日動くべきこと(相手と案件名を具体的に) → 決めてほしいこと(件数と一番急ぐもの) → 今週の期限 → 任せた送信・片付けた件数 → 返事待ち。
- 今日動く案件が無ければ「今日急ぐものはありません。」と一言で済ませ、水増ししない。
- 自分が「段取りを進める」「指示をください」などと約束・要求しない。先生への簡潔な報告だけ。
- 数字と固有名詞を使う。抽象的な励ましや過剰な敬語の重ね(〜でございます等)は書かない。`;

export interface BriefInput {
  today: string;
  hour?: number;
  p1: Array<{ subject: string; from: string; ask: string; deadline: string | null }>;
  p2: Array<{ subject: string; from: string; ask: string; deadline: string | null }>;
  decisions?: Array<{ subject: string; from: string; question: string }>;
  counts: { cases: number; noise: number; spam: number; drafts: number; fyi: number; tidied?: number; scheduled?: number; followUps?: number; decisions?: number; calendarMissing?: number };
}

export function buildBriefPrompt(b: BriefInput): string {
  const fmt = (x: { subject: string; from: string; ask: string; deadline: string | null }) =>
    `- ${x.from}「${x.subject}」: ${x.ask}${x.deadline ? `(期限 ${x.deadline})` : ''}`;
  const c = b.counts;
  const extras: string[] = [];
  if (c.tidied) extras.push(`一斉配信${c.tidied}件を既読にしてアーカイブ`);
  else if (c.noise) extras.push(`ノイズ${c.noise}件を除外`);
  if (c.spam) extras.push(`迷惑メール${c.spam}件`);
  if (c.scheduled) extras.push(`定型返信${c.scheduled}通を送信予定に(取消可)`);
  if (c.drafts) extras.push(`返信下書き${c.drafts}通`);
  if (c.followUps) extras.push(`返事待ち${c.followUps}件`);
  if (c.calendarMissing) extras.push(`カレンダー未登録の予定${c.calendarMissing}件(要登録)`);
  return [
    `今日: ${b.today}${b.hour !== undefined ? ` ${b.hour}時` : ''}`,
    `今日動く(P1) ${b.p1.length}件:`,
    ...b.p1.map(fmt),
    `決めてほしいこと ${(b.decisions ?? []).length}件:`,
    ...(b.decisions ?? []).map((d) => `- ${d.from}「${d.subject}」: ${d.question}`),
    `今週中(P2) ${b.p2.length}件:`,
    ...b.p2.map(fmt),
    `その他: 案件${c.cases}件、参考のみ${c.fyi}件。${extras.join('、')}。`,
  ].join('\n');
}

export function greetingFor(hour: number): string {
  if (hour >= 4 && hour < 11) return 'おはようございます。';
  return 'お疲れさまです。';
}

export function fallbackBrief(b: BriefInput): string {
  const first = b.p1[0];
  const p1s = b.p1.length === 0 ? '今日中に動く案件はありません。' : `今日は${b.p1.length}件動けば十分です。まず${first.from}の「${first.subject}」(${first.ask})から。`;
  const dn = (b.decisions ?? []).length;
  const ds = dn > 0 ? `決めてほしいことが${dn}件あります。` : '';
  const p2s = b.p2.length > 0 ? `今週中の案件が${b.p2.length}件あります。` : '';
  const c = b.counts;
  const tidy = c.tidied ? `一斉配信${c.tidied}件は片付け、` : c.noise ? `ノイズ${c.noise}件は除外し、` : '';
  const rest = `${tidy}返信下書きを${c.drafts}通用意しました。${c.followUps ? `返事待ちが${c.followUps}件あります。` : ''}${c.calendarMissing ? `カレンダーに入っていない予定が${c.calendarMissing}件あります。` : ''}`;
  return `${greetingFor(b.hour ?? new Date().getHours())}${p1s}${ds}${p2s}${rest}`;
}

export async function writeBrief(runner: ClaudeRunner, b: BriefInput, model: string): Promise<{ text: string; costUsd: number; ai: boolean }> {
  const res = await runner.run<unknown>({
    label: 'brief',
    model,
    systemPrompt: SYSTEM_BRIEF,
    prompt: buildBriefPrompt(b),
    timeoutMs: 60_000,
  });
  if (res.ok && res.text.trim()) return { text: res.text.trim(), costUsd: res.costUsd, ai: true };
  return { text: fallbackBrief(b), costUsd: res.costUsd, ai: false };
}


// =====================================================================
// v3 相棒: 返事待ちの判定 / 催促文
// =====================================================================

export interface FollowUpInput {
  id: string;
  subject: string;
  toText: string;
  tier: SenderTier;
  sentAt: string;        // YYYY-MM-DD HH:MM
  daysWaiting: number;
  threadCount: number;
  body: string;          // 先生が書いた本文
}

export interface FollowUpJudgment {
  id: string;
  needsReply: boolean;
  ask: string;
  summary: string;
  nudgeOk: boolean;
  urgency: 'now' | 'soon' | 'later';
}

const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          needsReply: { type: 'boolean' },
          ask: { type: 'string' },
          summary: { type: 'string' },
          nudgeOk: { type: 'boolean' },
          urgency: { type: 'string', enum: ['now', 'soon', 'later'] },
        },
        required: ['id', 'needsReply', 'ask', 'summary', 'nudgeOk', 'urgency'],
      },
    },
  },
  required: ['items'],
};

export const SYSTEM_FOLLOWUP = `あなたは福井大学 重信颯人先生の相棒「調(しらべ)」。先生が送ったメールのうち「相手からの返事を待っているもの」を見分ける。
- needsReply: 先生がその相手に回答・資料・判断・日程・確認などを求めていて、それがまだ来ていない前提で待つべきなら true。報告・お礼・了解・添付の送付だけで返事が要らないなら false。メーリングリスト宛や一斉連絡も false。
- ask: 先生が相手に求めたことを1文(主語は省く。「候補日の回答」「書類の返送」など)。
- summary: 1行。誰に何の件で。
- nudgeOk: 今の時点で催促してよいか。目上・学外で待ち日数が5日未満なら false。学生・業者・学内事務・期限が迫るものは true。
- urgency: now(期限や会議が近い) / soon(今週中に欲しい) / later。
必ず全件 id ごとに返す。`;

export function buildFollowUpPrompt(ctx: JudgmentContext, inputs: FollowUpInput[]): string {
  const parts: string[] = [`今日の日付: ${ctx.today}`, ctx.profile.split('\n').slice(0, 12).join('\n'), '\n---\n## 先生が送って返事が無いメール'];
  inputs.forEach((f, i) => {
    parts.push(`\n### ${i + 1} (id: ${f.id})`);
    parts.push(`件名: ${f.subject || '(件名なし)'}`);
    parts.push(`宛先: ${f.toText} | 関係: ${TIER_LABEL[f.tier]} | 送信: ${f.sentAt} (${f.daysWaiting}日前) | スレッド: ${f.threadCount}通`);
    parts.push(`先生の本文:\n${f.body || '(本文なし)'}`);
  });
  parts.push('\n上記の全件について判定を返してください。');
  return parts.join('\n');
}

export async function judgeFollowUps(
  runner: ClaudeRunner,
  ctx: JudgmentContext,
  inputs: FollowUpInput[],
  model: string,
): Promise<{ judgments: Map<string, FollowUpJudgment>; aiCalls: number; costUsd: number; errors: string[] }> {
  const out = { judgments: new Map<string, FollowUpJudgment>(), aiCalls: 0, costUsd: 0, errors: [] as string[] };
  if (inputs.length === 0) return out;
  const batches: FollowUpInput[][] = [];
  for (let i = 0; i < inputs.length; i += 8) batches.push(inputs.slice(i, i + 8));
  await Promise.all(batches.map(async (batch, bi) => {
    const res = await runner.run<{ items: Partial<FollowUpJudgment>[] }>({
      label: `followup#${bi + 1}`,
      model,
      systemPrompt: SYSTEM_FOLLOWUP,
      prompt: buildFollowUpPrompt(ctx, batch),
      schema: FOLLOWUP_SCHEMA,
      timeoutMs: 120_000,
    });
    out.aiCalls += 1;
    out.costUsd += res.costUsd;
    if (!res.ok || !res.data) { out.errors.push(res.error ?? '返事待ちの判定に失敗'); return; }
    for (const j of res.data.items ?? []) {
      if (!j || typeof j.id !== 'string' || !batch.some((b) => b.id === j.id)) continue;
      out.judgments.set(j.id, {
        id: j.id,
        needsReply: !!j.needsReply,
        ask: cleanAiText(j.ask),
        summary: cleanAiText(j.summary),
        nudgeOk: !!j.nudgeOk,
        urgency: j.urgency === 'now' || j.urgency === 'soon' ? j.urgency : 'later',
      });
    }
  }));
  return out;
}

export const SYSTEM_NUDGE = `あなたは福井大学の重信颯人先生の相棒として、返事が来ていない相手へ先生本人が送る短いリマインドを書く。
- 1行目は宛名(「〇〇先生」「〇〇さま」「〇〇さん」。相手の署名や過去のやりとりに合わせる)。2行目は空行。3行目は挨拶(学外・目上は「いつも大変お世話になっております，重信です。」、学内の親しい相手・学生は「重信です。」)。
- 「先日お送りした〜の件，ご確認いただけましたでしょうか。」の形で柔らかく。相手を責めない。期限や会議が近ければ一言添える。
- 3〜6行。読点は全角カンマ「，」。結びは「お忙しいところ恐れ入りますが，よろしくお願い致します。」など。署名は書かない。
- 出力は本文のみ。件名・説明・前置きは書かない。`;

export interface NudgeParams {
  subject: string;
  toName: string;
  toAddress: string;
  sentAt: string;
  daysWaiting: number;
  ask: string;
  myBody: string;
  exemplars: string[];
  instruction?: string;
}

export function buildNudgePrompt(ctx: JudgmentContext, p: NudgeParams): string {
  const parts: string[] = [`今日の日付: ${ctx.today}`, ctx.profile];
  if (p.exemplars.length > 0) {
    parts.push('\n## 先生が実際に書いた最近のメール(文体の見本)');
    p.exemplars.forEach((e, i) => parts.push(`\n--- 見本 ${i + 1} ---\n${e}`));
  }
  parts.push('\n## 催促する案件');
  parts.push(`件名: ${p.subject}`);
  parts.push(`相手: ${p.toName ? `${p.toName} <${p.toAddress}>` : p.toAddress}`);
  parts.push(`先生が送った日: ${p.sentAt}(${p.daysWaiting}日前)`);
  parts.push(`先生が求めたこと: ${p.ask}`);
  parts.push(`\n## 先生が送った本文\n${p.myBody || '(本文なし)'}`);
  if (p.instruction) parts.push(`\n## 先生からの追加指示\n${p.instruction}`);
  parts.push('\nリマインドの本文だけを出力してください。');
  return parts.join('\n');
}

export async function draftNudge(runner: ClaudeRunner, ctx: JudgmentContext, p: NudgeParams, model: string): Promise<{ ok: boolean; draft: string; error?: string; costUsd: number }> {
  const res = await runner.run<unknown>({ label: 'nudge', model, systemPrompt: SYSTEM_NUDGE, prompt: buildNudgePrompt(ctx, p), timeoutMs: 120_000 });
  if (!res.ok) return { ok: false, draft: '', error: res.error, costUsd: res.costUsd };
  const text = res.text.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
  if (!text) return { ok: false, draft: '', error: '空の催促文が返りました', costUsd: res.costUsd };
  return { ok: true, draft: text, costUsd: res.costUsd };
}

// =====================================================================
// v3.1 作業への受け渡し: 案件 → 該当フォルダの推定 + 作業指示書
// =====================================================================

export interface HandoffInput {
  subject: string;
  fromName: string;
  fromAddress: string;
  ask: string;
  summary: string;
  deadline: string | null;
  category: string;
  thread: ThreadContextMessage[];
  folderMap: string;     // references/folder-map.md(無ければ空)
  recentFolders: string[];
}

export interface HandoffJudgment {
  folder: string | null;       // 絶対パス(folderMap のベースパス + 相対)。分からなければ null
  folderReason: string;
  title: string;               // 作業の短い題
  instructions: string;        // 作業指示書(Markdown)
  deliverable: string;         // 成果物(1行)
}

const HANDOFF_SCHEMA = {
  type: 'object',
  properties: {
    folder: { type: ['string', 'null'] },
    folderReason: { type: 'string' },
    title: { type: 'string' },
    instructions: { type: 'string' },
    deliverable: { type: 'string' },
  },
  required: ['folder', 'folderReason', 'title', 'instructions', 'deliverable'],
};

export const SYSTEM_HANDOFF = `あなたは福井大学 重信颯人先生の相棒「調(しらべ)」。メールの案件を「作業」に引き渡すための準備をする。
出力は2つ:
1. folder: この案件の資料がある(または置くべき)フォルダの絶対パス。フォルダマップのベースパスと年度・カテゴリ番号・案件名の流儀に従って推定する。該当がはっきりしないときは年度とカテゴリまでの既存フォルダにとどめる。まったく分からなければ null。存在しない深いパスを創作しない。
2. instructions: 先生(またはその場で動く Claude Code)がそのフォルダで作業を始めるための指示書(Markdown、400〜900字)。見出し: 「## 目的」「## 相手と経緯」(日付・誰が何を言ったか)「## やること」(番号付き、具体的に。参照すべきファイル名の見当があれば書く)「## 期限と制約」「## 成果物」「## 返信の方針」(作業後に相手へ何を返すか)。推測は「(推定)」と明記。先生の判断が要る点は「【先生の判断】」で示す。
title は 12 字程度の作業名、deliverable は成果物を1行で。`;

export function buildHandoffPrompt(ctx: JudgmentContext, h: HandoffInput): string {
  const parts: string[] = [`今日の日付: ${ctx.today}`, ctx.profile];
  if (h.folderMap) parts.push(`\n## フォルダマップ\n${h.folderMap}`);
  if (h.recentFolders.length > 0) parts.push(`\n## 最近使ったフォルダ\n${h.recentFolders.map((f) => `- ${f}`).join('\n')}`);
  parts.push('\n## 案件');
  parts.push(`件名: ${h.subject}`);
  parts.push(`相手: ${h.fromName ? `${h.fromName} <${h.fromAddress}>` : h.fromAddress}`);
  parts.push(`種別: ${h.category} / 期限: ${h.deadline ?? 'なし'}`);
  parts.push(`先生がすべきこと: ${h.ask}`);
  parts.push(`要約: ${h.summary}`);
  parts.push('\n## スレッド(古い順)');
  for (const m of h.thread) {
    const d = m.date instanceof Date ? m.date : new Date(m.date);
    const stamp = isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    parts.push(`\n--- ${m.isSentByMe ? '先生(自分)' : m.from} (${stamp}) ---\n${m.body || '(本文なし)'}`);
  }
  parts.push('\nフォルダの推定と作業指示書を返してください。');
  return parts.join('\n');
}

export async function prepareHandoff(runner: ClaudeRunner, ctx: JudgmentContext, h: HandoffInput, model: string): Promise<{ ok: boolean; data?: HandoffJudgment; error?: string; costUsd: number }> {
  const res = await runner.run<Partial<HandoffJudgment>>({ label: 'handoff', model, systemPrompt: SYSTEM_HANDOFF, prompt: buildHandoffPrompt(ctx, h), schema: HANDOFF_SCHEMA, timeoutMs: 150_000 });
  if (!res.ok || !res.data) return { ok: false, error: res.error ?? '作業指示書の生成に失敗しました', costUsd: res.costUsd };
  const d = res.data;
  const folder = typeof d.folder === 'string' && d.folder.trim().startsWith('/') ? d.folder.trim().replace(/\/+$/, '') : null;
  return {
    ok: true,
    costUsd: res.costUsd,
    data: {
      folder,
      folderReason: String(d.folderReason ?? '').trim(),
      title: String(d.title ?? '').trim() || h.subject.slice(0, 20),
      instructions: String(d.instructions ?? '').trim(),
      deliverable: String(d.deliverable ?? '').trim(),
    },
  };
}

// =====================================================================
// v3.1 予定だけを後から抜く(event 欄の無い旧案件の補完)
// =====================================================================

export interface EventOnlyInput { id: string; subject: string; receivedAt: string; body: string }

const EVENT_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          event: {
            type: ['object', 'null'],
            properties: {
              title: { type: 'string' }, start: { type: 'string' }, end: { type: ['string', 'null'] }, allDay: { type: 'boolean' },
              location: { type: 'string' }, kind: { type: 'string', enum: ['meeting', 'deadline', 'event', 'other'] },
            },
            required: ['title', 'start', 'allDay', 'kind'],
          },
        },
        required: ['id', 'event'],
      },
    },
  },
  required: ['items'],
};

export const SYSTEM_EVENT_ONLY = `あなたは重信先生の相棒「調」。各メールから、先生が出る(または押さえるべき)会議・打合せ・行事・審査・締切の日時を1つだけ抜き出す。
- title は短く。start は YYYY-MM-DDTHH:MM(時刻不明・終日は YYYY-MM-DD で allDay true)。年は今日の日付と受信日から補う。end は分かれば。
- kind: meeting / deadline(提出・回答期限) / event(講演・行事) / other。
- 候補日の列挙・未確定の調整中・過去の日付・先生に関係ない予定は null。
必ず全件 id ごとに返す。`;

export async function extractEvents(runner: ClaudeRunner, ctx: JudgmentContext, inputs: EventOnlyInput[], model: string): Promise<{ events: Map<string, CaseEvent | null>; aiCalls: number; costUsd: number; errors: string[] }> {
  const out = { events: new Map<string, CaseEvent | null>(), aiCalls: 0, costUsd: 0, errors: [] as string[] };
  if (inputs.length === 0) return out;
  const batches: EventOnlyInput[][] = [];
  for (let i = 0; i < inputs.length; i += 10) batches.push(inputs.slice(i, i + 10));
  await Promise.all(batches.map(async (batch, bi) => {
    const prompt = [`今日の日付: ${ctx.today}`, '## メール', ...batch.map((b, i) => `\n### ${i + 1} (id: ${b.id})\n件名: ${b.subject}\n受信: ${b.receivedAt}\n本文:\n${(b.body || '').slice(0, 1200)}`), '\n全件について予定を返してください。'].join('\n');
    const res = await runner.run<{ items: Array<{ id: string; event: unknown }> }>({ label: `events#${bi + 1}`, model, systemPrompt: SYSTEM_EVENT_ONLY, prompt, schema: EVENT_ONLY_SCHEMA, timeoutMs: 120_000 });
    out.aiCalls += 1;
    out.costUsd += res.costUsd;
    if (!res.ok || !res.data) { out.errors.push(res.error ?? '予定の抽出に失敗'); return; }
    for (const it of res.data.items ?? []) {
      if (!it || typeof it.id !== 'string' || !batch.some((b) => b.id === it.id)) continue;
      out.events.set(it.id, normalizeEvent(it.event, ctx.today));
    }
  }));
  return out;
}
