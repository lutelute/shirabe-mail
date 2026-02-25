import Anthropic from '@anthropic-ai/sdk';
import type { MailItem, ActionItem } from '../../src/types/index';
import { triageEmails as triageEmailsAgent } from './claude-agent';

// --- Extraction mode ---
export type ExtractionMode = 'keyword' | 'ai' | 'agent';

// --- Keyword definitions ---
const HIGH_KEYWORDS = ['至急', '緊急', 'ASAP', '本日中', '今すぐ', '直ちに'];
const MEDIUM_KEYWORDS = ['締切', '提出', '返信', '依頼', '申請', '報告'];
const LOW_KEYWORDS = ['出張', '会議', '打ち合わせ', '連絡', '確認', 'お知らせ'];

const CATEGORY_MAP: [RegExp, string][] = [
  [/締切|期限|〆切/, 'deadline'],
  [/会議|打ち合わせ|ミーティング/, 'meeting'],
  [/出張/, 'travel'],
  [/申請|報告|届出/, 'admin'],
  [/提出/, 'submission'],
  [/返信|回答/, 'reply'],
  [/依頼|お願い/, 'request'],
  [/連絡|確認|お知らせ/, 'info'],
];

// --- Date extraction ---
function extractDeadline(text: string): Date | null {
  const now = new Date();

  // X月X日
  const mdMatch = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (mdMatch) {
    const month = parseInt(mdMatch[1], 10) - 1;
    const day = parseInt(mdMatch[2], 10);
    const year = now.getFullYear();
    const d = new Date(year, month, day);
    if (d < now) d.setFullYear(year + 1);
    return d;
  }

  // X/X
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10) - 1;
    const day = parseInt(slashMatch[2], 10);
    const year = now.getFullYear();
    const d = new Date(year, month, day);
    if (d < now) d.setFullYear(year + 1);
    return d;
  }

  // Relative dates
  if (text.includes('明日')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (text.includes('今週')) {
    const d = new Date(now);
    const dayOfWeek = d.getDay();
    d.setDate(d.getDate() + (5 - dayOfWeek)); // Friday
    return d;
  }
  if (text.includes('来週')) {
    const d = new Date(now);
    const dayOfWeek = d.getDay();
    d.setDate(d.getDate() + (12 - dayOfWeek)); // Next Friday
    return d;
  }
  if (text.includes('今月末')) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return d;
  }

  return null;
}

function detectCategory(text: string): string {
  for (const [pattern, category] of CATEGORY_MAP) {
    if (pattern.test(text)) return category;
  }
  return 'general';
}

function detectPriority(text: string): 'high' | 'medium' | 'low' {
  for (const kw of HIGH_KEYWORDS) {
    if (text.includes(kw)) return 'high';
  }
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) return 'medium';
  }
  for (const kw of LOW_KEYWORDS) {
    if (text.includes(kw)) return 'low';
  }
  return 'low';
}

function hasActionKeyword(text: string): boolean {
  const allKeywords = [...HIGH_KEYWORDS, ...MEDIUM_KEYWORDS, ...LOW_KEYWORDS];
  return allKeywords.some((kw) => text.includes(kw));
}

function keywordExtract(mail: MailItem): ActionItem | null {
  const text = `${mail.subject} ${mail.preview}`;
  if (!hasActionKeyword(text)) return null;

  return {
    id: `kw-${mail.id}`,
    mailId: mail.id,
    subject: mail.subject,
    action: mail.subject,
    deadline: extractDeadline(text),
    priority: detectPriority(text),
    category: detectCategory(text),
    source: 'keyword',
    accountEmail: mail.accountEmail,
    isCompleted: false,
  };
}

// --- AI mode ---
const aiCache = new Map<number, ActionItem[]>();

async function aiExtract(
  mails: MailItem[],
  apiKey: string,
): Promise<ActionItem[]> {
  const cached: ActionItem[] = [];
  const uncached: MailItem[] = [];

  for (const mail of mails) {
    const hit = aiCache.get(mail.id);
    if (hit) {
      cached.push(...hit);
    } else {
      uncached.push(mail);
    }
  }

  if (uncached.length === 0) return cached;

  const client = new Anthropic({ apiKey });
  const results: ActionItem[] = [...cached];

  // Process in batches of 10
  for (let i = 0; i < uncached.length; i += 10) {
    const batch = uncached.slice(i, i + 10);
    const mailData = batch.map((m) => ({
      id: m.id,
      subject: m.subject,
      preview: m.preview,
      from: m.from?.address ?? '',
      date: m.date.toISOString(),
      accountEmail: m.accountEmail,
    }));

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: `You are an email action item extractor. Given email data, extract action items.
Return a JSON array. Each element:
{
  "mailId": number,
  "subject": string,
  "action": string (concise description of required action),
  "deadline": string|null (ISO date if found),
  "priority": "high"|"medium"|"low",
  "category": "deadline"|"meeting"|"travel"|"admin"|"submission"|"reply"|"request"|"info"|"general"
}
Only include emails that require action. Return [] if none. Output ONLY valid JSON.`,
      messages: [
        {
          role: 'user',
          content: JSON.stringify(mailData),
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const parsed: Array<{
        mailId: number;
        subject: string;
        action: string;
        deadline: string | null;
        priority: 'high' | 'medium' | 'low';
        category: string;
      }> = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

      for (const item of parsed) {
        const sourceMail = batch.find((m) => m.id === item.mailId);
        if (!sourceMail) continue;

        const actionItem: ActionItem = {
          id: `ai-${item.mailId}`,
          mailId: item.mailId,
          subject: item.subject,
          action: item.action,
          deadline: item.deadline ? new Date(item.deadline) : null,
          priority: item.priority,
          category: item.category,
          source: 'ai',
          accountEmail: sourceMail.accountEmail,
          isCompleted: false,
        };
        results.push(actionItem);

        // Cache per mail
        const existing = aiCache.get(item.mailId) ?? [];
        existing.push(actionItem);
        aiCache.set(item.mailId, existing);
      }
    } catch {
      // Skip unparseable responses
    }
  }

  return results;
}

// --- Agent mode (delegates to Claude Agent SDK via claude-agent.ts) ---
async function agentExtract(
  mails: MailItem[],
  apiKey: string,
): Promise<ActionItem[]> {
  const { results: triageResults, error } = await triageEmailsAgent(
    mails,
    apiKey,
  );

  if (error || triageResults.length === 0) {
    return [];
  }

  const actions: ActionItem[] = [];
  for (const triageResult of triageResults) {
    // Only create action items for emails classified as 'todo'
    if (triageResult.classification !== 'todo') continue;

    const sourceMail = mails.find((m) => m.id === triageResult.mailId);
    if (!sourceMail) continue;

    const text = `${sourceMail.subject} ${sourceMail.preview}`;

    // Use agent reasoning as action description, fall back to subject
    const action = triageResult.reasoning || sourceMail.subject;

    // Derive priority from relevance score (agent-based) with keyword override
    const keywordPriority = detectPriority(text);
    const agentPriority: 'high' | 'medium' | 'low' =
      triageResult.relevanceScore >= 0.8
        ? 'high'
        : triageResult.relevanceScore >= 0.5
          ? 'medium'
          : 'low';
    // Use whichever is higher priority
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const priority =
      priorityOrder[keywordPriority] >= priorityOrder[agentPriority]
        ? keywordPriority
        : agentPriority;

    actions.push({
      id: `agent-${triageResult.mailId}`,
      mailId: triageResult.mailId,
      subject: sourceMail.subject,
      action,
      deadline: extractDeadline(text),
      priority,
      category: detectCategory(text),
      source: 'agent',
      accountEmail: sourceMail.accountEmail,
      isCompleted: false,
    });
  }

  return actions;
}

// --- Main export ---
/**
 * Extract action items from emails using the specified mode.
 *
 * Modes:
 * - 'keyword': Pattern-based extraction using Japanese keyword lists (no API needed)
 * - 'ai': Direct Anthropic SDK extraction via Claude Haiku (requires API key)
 * - 'agent': Claude Agent SDK extraction via claude-agent.ts (requires API key, opt-in)
 *
 * For backward compatibility, `modeOrUseAI` also accepts a boolean:
 * - true  → 'ai' mode
 * - false → 'keyword' mode
 */
export async function extractActions(
  mails: MailItem[],
  modeOrUseAI: ExtractionMode | boolean,
  apiKey: string,
): Promise<ActionItem[]> {
  // Derive mode from boolean for backward compatibility
  const mode: ExtractionMode =
    typeof modeOrUseAI === 'boolean'
      ? modeOrUseAI
        ? 'ai'
        : 'keyword'
      : modeOrUseAI;

  if (mode === 'agent' && apiKey) {
    return agentExtract(mails, apiKey);
  }

  if (mode === 'ai' && apiKey) {
    return aiExtract(mails, apiKey);
  }

  // Default: keyword mode
  const actions: ActionItem[] = [];
  for (const mail of mails) {
    const action = keywordExtract(mail);
    if (action) actions.push(action);
  }
  return actions;
}
