import Anthropic from '@anthropic-ai/sdk';
import type { MailItem, JunkClassification } from '../../src/types/index';

// --- Keyword-based junk detection (fallback, no API key needed) ---

const JUNK_KEYWORDS = [
  'unsubscribe', '配信停止', 'メルマガ', 'newsletter', 'セール',
  'キャンペーン', 'クーポン', 'PR', '広告', 'noreply', 'no-reply',
  'sale', 'discount', 'promotion', 'opt out', 'opt-out',
  '購読解除', 'メール配信', 'お知らせメール',
  'limited time', '期間限定', '特別価格', 'special offer',
  'click here', 'act now', '今すぐ',
];

const JUNK_SENDER_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /newsletter@/i,
  /marketing@/i,
  /promo@/i,
  /mailer@/i,
  /updates@.*\.(com|net|org)$/i,  // generic updates@ from commercial domains only
  /bounce@/i,
  /campaign@/i,
  /bulk@/i,
];

// Patterns that were too aggressive — removed from detection:
// info@, news@, notification@ — commonly used by universities, institutions, and work services

// Domains that are inherently work/academic — always Safe
const SAFE_DOMAIN_SUFFIXES = [
  '.ac.jp', '.edu', '.go.jp', '.gov', '.lg.jp',
  '.or.jp', // non-profit organizations in Japan
];

function isSafeDomain(address: string): boolean {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  return SAFE_DOMAIN_SUFFIXES.some((s) => domain.endsWith(s));
}

function isReplyOrForward(subject: string): boolean {
  return /^(Re:|Fwd:|Fw:|RE:|FW:)/i.test(subject.trim());
}

/**
 * Check if a sender domain is in the whitelist.
 * Whitelist entries can be full domains (e.g. "u-fukui.ac.jp")
 * or partial suffixes (e.g. ".ac.jp" matches all academic domains).
 */
function isWhitelistedSender(senderAddress: string, whitelistDomains: string[]): boolean {
  if (!senderAddress || whitelistDomains.length === 0) return false;
  const domain = senderAddress.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return false;
  return whitelistDomains.some((wd) => {
    const w = wd.toLowerCase().trim();
    if (!w) return false;
    // Exact domain match or suffix match
    return domain === w || domain.endsWith(`.${w}`) || (w.startsWith('.') && domain.endsWith(w));
  });
}

export function detectJunkByKeywords(mails: MailItem[], whitelistDomains: string[] = []): JunkClassification[] {
  return mails.map((mail) => {
    const text = `${mail.subject} ${mail.preview}`.toLowerCase();
    const senderAddr = mail.from?.address?.toLowerCase() ?? '';

    // Whitelist check — whitelisted senders are always Safe
    if (isWhitelistedSender(senderAddr, whitelistDomains)) {
      return {
        mailId: mail.id,
        isJunk: false,
        confidence: 0.95,
        reasoning: 'ホワイトリストドメインからのメール',
        detectedPatterns: [],
      };
    }

    // Academic/government domain — always Safe
    if (isSafeDomain(senderAddr)) {
      return {
        mailId: mail.id,
        isJunk: false,
        confidence: 0.9,
        reasoning: '学術・公共機関ドメインからのメール',
        detectedPatterns: [],
      };
    }

    // Reply/Forward — likely part of a conversation, not junk
    if (isReplyOrForward(mail.subject)) {
      return {
        mailId: mail.id,
        isJunk: false,
        confidence: 0.85,
        reasoning: '返信・転送メール（スレッドの一部）',
        detectedPatterns: [],
      };
    }

    const matchedKeywords = JUNK_KEYWORDS.filter((kw) =>
      text.includes(kw.toLowerCase()),
    );

    const matchedSender = JUNK_SENDER_PATTERNS.some((pat) =>
      pat.test(senderAddr),
    );

    const detectedPatterns: string[] = [...matchedKeywords];
    if (matchedSender) {
      detectedPatterns.push(`sender: ${senderAddr}`);
    }

    // Require higher threshold — at least 2 patterns to be junk
    const isJunk = detectedPatterns.length >= 2;
    const confidence = isJunk
      ? Math.min(0.9, 0.3 + detectedPatterns.length * 0.15)
      : Math.min(0.3, detectedPatterns.length * 0.15);

    return {
      mailId: mail.id,
      isJunk,
      confidence,
      reasoning: isJunk
        ? `キーワード検出: ${detectedPatterns.join(', ')}`
        : 'ジャンクメールのパターンに一致しませんでした',
      detectedPatterns,
    };
  });
}

// --- AI-based junk detection (requires API key) ---

export async function detectJunkWithAI(
  mails: MailItem[],
  apiKey: string,
  whitelistDomains: string[] = [],
): Promise<JunkClassification[]> {
  if (!apiKey) {
    return detectJunkByKeywords(mails, whitelistDomains);
  }

  // Pre-filter whitelisted mails — skip AI call for them
  const whitelistedResults: JunkClassification[] = [];
  const mailsToCheck: MailItem[] = [];

  for (const mail of mails) {
    const senderAddr = mail.from?.address?.toLowerCase() ?? '';
    if (isWhitelistedSender(senderAddr, whitelistDomains)) {
      whitelistedResults.push({
        mailId: mail.id,
        isJunk: false,
        confidence: 0.95,
        reasoning: 'ホワイトリストドメインからのメール',
        detectedPatterns: [],
      });
    } else if (isSafeDomain(senderAddr)) {
      whitelistedResults.push({
        mailId: mail.id,
        isJunk: false,
        confidence: 0.9,
        reasoning: '学術・公共機関ドメインからのメール',
        detectedPatterns: [],
      });
    } else if (isReplyOrForward(mail.subject)) {
      whitelistedResults.push({
        mailId: mail.id,
        isJunk: false,
        confidence: 0.85,
        reasoning: '返信・転送メール（スレッドの一部）',
        detectedPatterns: [],
      });
    } else {
      mailsToCheck.push(mail);
    }
  }

  if (mailsToCheck.length === 0) {
    return whitelistedResults;
  }

  const client = new Anthropic({ apiKey });
  const results: JunkClassification[] = [...whitelistedResults];

  // Process in batches of 10
  for (let i = 0; i < mailsToCheck.length; i += 10) {
    const batch = mailsToCheck.slice(i, i + 10);
    const mailData = batch.map((m) => ({
      id: m.id,
      subject: m.subject,
      preview: m.preview.slice(0, 200),
      from: m.from?.address ?? '',
      fromName: m.from?.displayName ?? '',
    }));

    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: `以下のメールをジャンクメール（広告、ニュースレター、プロモーション、自動通知等）か判定してください。

重要な判定基準:
- 大学・研究機関・学会(.ac.jp, .edu, 学会ドメイン)からのメールは原則として仕事メール（Safe）と判定
- 個人宛で返信が含まれるスレッド（Re:, Fwd:）はジャンクではない
- info@やnotification@でも、教育機関・政府機関からのものはSafe
- 会議案内、授業関連、学務連絡、研究関連はすべてSafe
- 明確な商業広告・マーケティング・購読ニュースレターのみJunkと判定

メールデータ:
${JSON.stringify(mailData, null, 2)}

各メールについてJSON配列で返してください:
[
  {
    "mailId": number,
    "isJunk": boolean,
    "confidence": number (0.0-1.0),
    "reasoning": string (簡潔な理由),
    "detectedPatterns": string[] (検出パターン)
  }
]

JSONのみ出力してください。`,
          },
        ],
      });

      const text =
        response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as JunkClassification[];
        results.push(...parsed);
      } else {
        // Fallback to keyword detection for this batch
        results.push(...detectJunkByKeywords(batch, whitelistDomains));
      }
    } catch {
      // Fallback to keyword detection on error
      results.push(...detectJunkByKeywords(batch, whitelistDomains));
    }
  }

  return results;
}
