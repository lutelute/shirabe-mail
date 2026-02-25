import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type {
  MailItem,
  TriageResult,
  ThreadMessage,
  TodoItem,
  AuditParams,
  AuditResult,
  AuditScanProgress,
} from '../../src/types/index';

// --- Concurrency control: limit to 1 concurrent Agent SDK session ---
let activeSession = false;
const sessionQueue: Array<{ resolve: () => void }> = [];

async function acquireSession(): Promise<void> {
  if (!activeSession) {
    activeSession = true;
    return;
  }
  return new Promise<void>((resolve) => {
    sessionQueue.push({ resolve });
  });
}

function releaseSession(): void {
  const next = sessionQueue.shift();
  if (next) {
    next.resolve();
  } else {
    activeSession = false;
  }
}

// --- Shared query options ---
function baseOptions(apiKey: string, maxBudgetUsd?: number): Options {
  return {
    tools: ['Skill', 'Task', 'Read', 'Glob', 'Grep'],
    allowedTools: ['Skill', 'Task', 'Read', 'Glob', 'Grep'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project'],
    env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
    maxBudgetUsd,
    persistSession: false,
  };
}

// --- Extract result and cost from SDK message stream ---
async function collectResult(
  messages: AsyncGenerator<SDKMessage, void>,
): Promise<{ result: string; costUsd: number; isError: boolean }> {
  let result = '';
  let costUsd = 0;
  let isError = false;

  for await (const message of messages) {
    if (message.type === 'result') {
      const resultMsg = message as SDKResultMessage;
      costUsd = resultMsg.total_cost_usd;
      isError = resultMsg.is_error;
      if (resultMsg.subtype === 'success') {
        result = resultMsg.result;
      } else {
        const errors = 'errors' in resultMsg ? resultMsg.errors : [];
        result = errors.join('\n');
        isError = true;
      }
    }
  }

  return { result, costUsd, isError };
}

// --- Parse JSON from agent response text ---
function parseJsonArray<T>(text: string): T[] {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Unparseable response
  }
  return [];
}

function parseJsonObject<T>(text: string): T | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Unparseable response
  }
  return null;
}

// --- Triage Emails ---
export async function triageEmails(
  mails: MailItem[],
  apiKey: string,
): Promise<{ results: TriageResult[]; costUsd: number; error: string | null }> {
  if (!apiKey) {
    return {
      results: [],
      costUsd: 0,
      error: 'APIキーが設定されていません。設定画面でAPIキーを入力してください。',
    };
  }

  if (mails.length === 0) {
    return { results: [], costUsd: 0, error: null };
  }

  await acquireSession();
  try {
    const results: TriageResult[] = [];
    let totalCost = 0;

    // Process in batches of 10
    for (let i = 0; i < mails.length; i += 10) {
      const batch = mails.slice(i, i + 10);
      const mailData = batch.map((m) => ({
        id: m.id,
        subject: m.subject,
        preview: m.preview,
        from: m.from?.address ?? '',
        date: m.date instanceof Date ? m.date.toISOString() : String(m.date),
        accountEmail: m.accountEmail,
      }));

      const prompt = `Use the email-triage skill to classify these emails.

For each email, determine:
1. Classification: "reply" (simple reply needed) or "todo" (requires creating a To-Do item)
2. Relevance score: 0.0 to 1.0 (how relevant/important to the user)
3. Brief reasoning for the classification

Email data:
${JSON.stringify(mailData, null, 2)}

Return ONLY a JSON array with this format:
[
  {
    "mailId": number,
    "classification": "reply" | "todo",
    "relevanceScore": number,
    "reasoning": string
  }
]

Include ALL emails in the result. Output ONLY valid JSON, no other text.`;

      const messages = query({
        prompt,
        options: baseOptions(apiKey),
      });

      const { result, costUsd, isError } = await collectResult(messages);
      totalCost += costUsd;

      if (isError) {
        return { results, costUsd: totalCost, error: result || 'Agent SDK実行エラーが発生しました。' };
      }

      const parsed = parseJsonArray<{
        mailId: number;
        classification: 'reply' | 'todo';
        relevanceScore: number;
        reasoning: string;
      }>(result);

      for (const item of parsed) {
        const sourceMail = batch.find((m) => m.id === item.mailId);
        if (!sourceMail) continue;

        results.push({
          mailId: item.mailId,
          classification: item.classification,
          relevanceScore: item.relevanceScore,
          reasoning: item.reasoning,
        });
      }
    }

    return { results, costUsd: totalCost, error: null };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('invalid')) {
      return {
        results: [],
        costUsd: 0,
        error: 'APIキーが無効です。設定画面で正しいAPIキーを入力してください。',
      };
    }
    return { results: [], costUsd: 0, error: `トリアージ中にエラーが発生しました: ${errorMsg}` };
  } finally {
    releaseSession();
  }
}

// --- Extract Todos from Thread ---
export async function extractTodosFromThread(
  threadMessages: ThreadMessage[],
  apiKey: string,
): Promise<{ results: TodoItem[]; costUsd: number; error: string | null }> {
  if (!apiKey) {
    return {
      results: [],
      costUsd: 0,
      error: 'APIキーが設定されていません。設定画面でAPIキーを入力してください。',
    };
  }

  if (threadMessages.length === 0) {
    return { results: [], costUsd: 0, error: null };
  }

  await acquireSession();
  try {
    const threadData = threadMessages.map((m) => ({
      id: m.id,
      subject: m.subject,
      date: m.date instanceof Date ? m.date.toISOString() : String(m.date),
      preview: m.preview,
      from: m.from,
      to: m.to,
      cc: m.cc,
      folderName: m.folderName,
      isSentByMe: m.isSentByMe,
      sourceAccount: m.sourceAccount,
    }));

    const prompt = `Use the todo-extract skill to extract personal action items from this email thread.

IMPORTANT: Extract ONLY tasks that are assigned to ME (the user). Do NOT extract tasks for other people.

Thread messages (chronological):
${JSON.stringify(threadData, null, 2)}

Return ONLY a JSON array with this format:
[
  {
    "action": string (concise description of what I need to do),
    "priority": "high" | "medium" | "low",
    "deadline": string | null (ISO date if found),
    "sourceMailId": number (the message ID where this task was identified),
    "assignedToMe": true,
    "category": "deadline" | "meeting" | "travel" | "admin" | "submission" | "reply" | "request" | "info" | "general"
  }
]

Return [] if no personal action items found. Output ONLY valid JSON, no other text.`;

    const messages = query({
      prompt,
      options: baseOptions(apiKey),
    });

    const { result, costUsd, isError } = await collectResult(messages);

    if (isError) {
      return { results: [], costUsd, error: result || 'Agent SDK実行エラーが発生しました。' };
    }

    const parsed = parseJsonArray<{
      action: string;
      priority: 'high' | 'medium' | 'low';
      deadline: string | null;
      sourceMailId: number;
      assignedToMe: boolean;
      category: string;
    }>(result);

    // Derive threadId from the first message
    const threadId = threadMessages.length > 0 ? threadMessages[0].id : 0;
    const accountEmail = threadMessages.length > 0 ? threadMessages[0].sourceAccount : '';

    const now = new Date();
    const results: TodoItem[] = parsed.map((item, idx) => ({
      id: `agent-todo-${threadId}-${idx}`,
      action: item.action,
      priority: item.priority,
      deadline: item.deadline ? new Date(item.deadline) : null,
      sourceThreadId: threadId,
      sourceMailId: item.sourceMailId,
      assignedToMe: item.assignedToMe,
      category: item.category,
      isCompleted: false,
      accountEmail,
      createdAt: now,
      updatedAt: now,
      source: 'thread' as const,
    }));

    return { results, costUsd, error: null };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('invalid')) {
      return {
        results: [],
        costUsd: 0,
        error: 'APIキーが無効です。設定画面で正しいAPIキーを入力してください。',
      };
    }
    return { results: [], costUsd: 0, error: `To-Do抽出中にエラーが発生しました: ${errorMsg}` };
  } finally {
    releaseSession();
  }
}

// --- Historical Audit ---
export async function runHistoricalAudit(
  params: AuditParams,
  onProgress: (progress: AuditScanProgress) => void,
): Promise<{ result: AuditResult | null; costUsd: number; error: string | null }> {
  const { apiKey, accountEmail, startDate, endDate, topic } = params;

  if (!apiKey) {
    return {
      result: null,
      costUsd: 0,
      error: 'APIキーが設定されていません。設定画面でAPIキーを入力してください。',
    };
  }

  await acquireSession();
  try {
    // Calculate month range for progress tracking
    const start = startDate instanceof Date ? startDate : new Date(startDate);
    const end = endDate instanceof Date ? endDate : new Date(endDate);
    const totalMonths =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) +
      1;

    // Report initial progress
    onProgress({
      currentMonth: 0,
      totalMonths,
      percentComplete: 0,
      estimatedCostUsd: 0,
    });

    const topicFilter = topic ? `\nTopic/keyword filter: "${topic}"` : '';

    const prompt = `Use the historical-audit skill to perform a historical email audit.

Parameters:
- Account: ${accountEmail}
- Date range: ${start.toISOString().split('T')[0]} to ${end.toISOString().split('T')[0]}
- Total months to scan: ${totalMonths}${topicFilter}

Analyze the email history and provide:
1. Monthly activity summaries (message counts and key themes per month)
2. Key threads (most important conversations by message count and relevance)
3. Overall findings and patterns

Return ONLY a JSON object with this format:
{
  "dateRange": { "start": "ISO date", "end": "ISO date" },
  "monthlyActivity": [
    { "month": "YYYY-MM", "count": number, "summary": string }
  ],
  "keyThreads": [
    { "threadId": number, "subject": string, "messageCount": number, "dateRange": string }
  ],
  "findings": [string]
}

Output ONLY valid JSON, no other text.`;

    // Use maxBudgetUsd for expensive historical operations
    const options = baseOptions(apiKey, params.apiKey ? 5.0 : undefined);

    const messages = query({ prompt, options });

    let resultText = '';
    let totalCost = 0;

    for await (const message of messages) {
      if (message.type === 'result') {
        const resultMsg = message as SDKResultMessage;
        totalCost = resultMsg.total_cost_usd;

        if (resultMsg.subtype === 'success') {
          resultText = resultMsg.result;
        } else {
          const errors = 'errors' in resultMsg ? resultMsg.errors : [];
          return {
            result: null,
            costUsd: totalCost,
            error: errors.join('\n') || '監査中にエラーが発生しました。',
          };
        }
      }

      // Update progress based on cost accumulation (approximation)
      if (message.type === 'assistant' || message.type === 'result') {
        const estimatedProgress = Math.min(
          totalMonths,
          Math.floor((totalCost / 0.05) * totalMonths),
        );
        onProgress({
          currentMonth: estimatedProgress,
          totalMonths,
          percentComplete: Math.min(100, (estimatedProgress / totalMonths) * 100),
          estimatedCostUsd: totalCost,
        });
      }
    }

    // Final progress update
    onProgress({
      currentMonth: totalMonths,
      totalMonths,
      percentComplete: 100,
      estimatedCostUsd: totalCost,
    });

    const parsed = parseJsonObject<{
      dateRange: { start: string; end: string };
      monthlyActivity: { month: string; count: number; summary: string }[];
      keyThreads: { threadId: number; subject: string; messageCount: number; dateRange: string }[];
      findings: string[];
    }>(resultText);

    if (!parsed) {
      return {
        result: null,
        costUsd: totalCost,
        error: '監査結果の解析に失敗しました。',
      };
    }

    const auditResult: AuditResult = {
      dateRange: {
        start: new Date(parsed.dateRange.start),
        end: new Date(parsed.dateRange.end),
      },
      monthlyActivity: parsed.monthlyActivity,
      keyThreads: parsed.keyThreads,
      findings: parsed.findings,
    };

    return { result: auditResult, costUsd: totalCost, error: null };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('401') || errorMsg.includes('authentication') || errorMsg.includes('invalid')) {
      return {
        result: null,
        costUsd: 0,
        error: 'APIキーが無効です。設定画面で正しいAPIキーを入力してください。',
      };
    }
    return { result: null, costUsd: 0, error: `監査中にエラーが発生しました: ${errorMsg}` };
  } finally {
    releaseSession();
  }
}
