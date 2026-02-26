import { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { MailItem, MailNote, ThreadMessage, QuickLabel } from '../types';

// ─── Types ────────────────────────────────────────────────
export interface NoteTask {
  noteId: string;
  mailId: number;
  subject: string;
  status: 'running' | 'done' | 'error';
  mode: 'light' | 'deep';
  startedAt: number;
}

interface NoteServiceValue {
  /** Fire-and-forget note generation that survives view changes */
  requestGeneration: (
    mail: MailItem,
    threadMessages: ThreadMessage[],
    mode: 'light' | 'deep',
    existingNote?: MailNote | null,
  ) => void;
  /** Check if a noteId is currently generating */
  isGenerating: (noteId: string) => boolean;
  /** All tasks (running + recently completed) */
  tasks: Map<string, NoteTask>;
  /** Count of currently running tasks */
  runningCount: number;
  /** Set of noteIds completed in last few seconds (for UI refresh hints) */
  recentlyCompleted: Set<string>;
}

// ─── Helpers ──────────────────────────────────────────────
function noteIdFromMail(mail: MailItem): string {
  return mail.conversationId ? `conv-${mail.conversationId}` : `mail-${mail.id}`;
}

function buildLightPrompt(
  mail: MailItem,
  threadMessages: ThreadMessage[],
  existingNote?: MailNote | null,
): string {
  const MAX_MSG_LEN = 3000;
  const MAX_THREAD_LEN = 30000;
  let threadSection: string;

  if (threadMessages && threadMessages.length > 0) {
    const parts: string[] = [];
    let totalLen = 0;
    for (let i = 0; i < threadMessages.length; i++) {
      const msg = threadMessages[i];
      const dir = msg.isSentByMe ? '【自分が送信】' : '【受信】';
      const date = new Date(msg.date);
      const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
      const body = msg.preview?.slice(0, MAX_MSG_LEN) || '(本文なし)';
      const part = `--- メッセージ ${i + 1}/${threadMessages.length} ${dir} ---\n差出人: ${msg.from}\n宛先: ${msg.to.join(', ')}${msg.cc.length > 0 ? `\nCC: ${msg.cc.join(', ')}` : ''}\n日時: ${dateStr}\n件名: ${msg.subject}\n本文:\n${body}`;
      if (totalLen + part.length > MAX_THREAD_LEN) {
        parts.push(`\n... 以降 ${threadMessages.length - i}通は省略 ...`);
        break;
      }
      parts.push(part);
      totalLen += part.length;
    }
    threadSection = parts.join('\n\n');
  } else {
    threadSection = `件名: ${mail.subject}\n差出人: ${mail.from?.displayName || mail.from?.address || '不明'}\n本文: ${mail.preview?.slice(0, 2000) || '(本文なし)'}`;
  }

  const existingSection = existingNote?.content
    ? `\n\n=== 既存ノート ===\n${existingNote.content}`
    : '';

  return `あなたは業務メール分析のエキスパートです。以下のメールスレッド全文を読み、この案件について深く分析してください。

=== メール情報 ===
件名: ${mail.subject}
アカウント: ${mail.accountEmail}

=== スレッド全文（${threadMessages?.length || 1}通） ===
${threadSection}
${existingSection}

以下の観点で分析し、マークダウン形式で出力してください:

## 案件概要
このスレッドは何の仕事/案件か。1-2文で簡潔に。

## 自分の役割
アカウント所有者（${mail.accountEmail}）は何を求められているか。

## 現在のステータス
- 誰のアクション待ちか
- 何が未解決か

## アクション
- [ ] 具体的にやるべきこと（→自分 or →相手）

## ⚠️ 期限
- 明示された期限（日付）
- 暗示された期限

## 判定
[不要 / 要返信 / 個別対応 / 保留 / 対応済] — 理由を1文で

## メモ
- 背景情報や注意点`;
}

function buildDeepPrompt(mail: MailItem): string {
  return `あなたはメール分析の専門家です。以下のメールについてMCPツールを使って徹底的に調査し、ノートを作成・更新してください。

=== 対象メール ===
メールID: ${mail.id}
${mail.conversationId ? `会話ID: ${mail.conversationId}` : ''}
件名: ${mail.subject}
差出人: ${mail.from?.displayName || mail.from?.address || '不明'}
アカウント: ${mail.accountEmail}

=== 調査手順 ===
1. mcp__shirabe__get_note でメールID ${mail.id} の既存ノートを確認
2. mcp__shirabe__get_mail_detail でメールID ${mail.id} の本文を取得
3. mcp__shirabe__get_mail_thread でスレッド全体を取得
4. mcp__shirabe__analyze_thread でアクション項目・緊急度を分析
5. mcp__shirabe__update_note で調査結果をノートに保存:
   - mail_id: ${mail.id}
   - content: マークダウン形式の分析結果
   - todos: アクション項目
   - tags: 判定カテゴリ (urgent/reply/action/info/unnecessary/hold)
   ${mail.conversationId ? `- conversation_id: ${mail.conversationId}` : ''}

=== ノート出力形式 ===
## 案件概要
## 自分の役割
## 現在のステータス
## 判定
**【カテゴリ】** — 理由
## アクション
- [ ] タスク（→自分 or →相手）
## ⚠️ 期限
## メモ

必ず最後に update_note でノートに保存すること。
replace_content: true で全体を置き換え。`;
}

function extractLabel(markdown: string): QuickLabel | undefined {
  const m = markdown.match(/## 判定\s*\n\s*\*?\*?\s*【?\s*(至急|要返信|要対応|個別対応|情報|不要|保留|対応済)/);
  if (!m) {
    const m2 = markdown.match(/## 判定\s*\n\s*\[?\s*(不要|要返信|個別対応|保留|対応済)/);
    if (m2) {
      const map: Record<string, QuickLabel> = { '不要': 'unnecessary', '要返信': 'reply', '個別対応': 'action', '保留': 'hold', '対応済': 'done' };
      return map[m2[1]];
    }
    return undefined;
  }
  const map: Record<string, QuickLabel> = {
    '至急': 'action', '要返信': 'reply', '要対応': 'action', '個別対応': 'action',
    '情報': 'done', '不要': 'unnecessary', '保留': 'hold', '対応済': 'done',
  };
  return map[m[1]];
}

// ─── Context ──────────────────────────────────────────────
const NoteServiceContext = createContext<NoteServiceValue | null>(null);

export function NoteServiceProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Map<string, NoteTask>>(new Map());
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<string>>(new Set());
  const [runningCount, setRunningCount] = useState(0);
  const runningRef = useRef<Set<string>>(new Set());

  const requestGeneration = useCallback((
    mail: MailItem,
    threadMessages: ThreadMessage[],
    mode: 'light' | 'deep',
    existingNote?: MailNote | null,
  ) => {
    const noteId = noteIdFromMail(mail);

    // Don't duplicate running tasks
    if (runningRef.current.has(noteId)) return;
    runningRef.current.add(noteId);
    setRunningCount(runningRef.current.size);

    const task: NoteTask = {
      noteId,
      mailId: mail.id,
      subject: mail.subject,
      status: 'running',
      mode,
      startedAt: Date.now(),
    };
    setTasks(prev => new Map(prev).set(noteId, task));

    // Build prompt
    const prompt = mode === 'deep'
      ? buildDeepPrompt(mail)
      : buildLightPrompt(mail, threadMessages, existingNote);

    // Fire and forget — survives component unmounts
    window.electronAPI.runClaudeAnalysis(prompt, { mode })
      .then(async (result) => {
        if (mode === 'deep') {
          // Deep mode: MCP may have saved directly
          const reloaded = await window.electronAPI.getNote(noteId);
          if (reloaded) return; // MCP saved it
        }

        if (result.status === 'done' && result.markdown) {
          const now = new Date().toISOString();
          const threadCount = threadMessages?.length ?? 1;
          const detectedLabel = extractLabel(result.markdown);

          if (existingNote) {
            const updated: MailNote = {
              ...existingNote,
              content: result.markdown,
              quickLabel: detectedLabel || existingNote.quickLabel,
              threadMessageCount: threadCount,
              updatedAt: now,
              history: [
                ...existingNote.history,
                { timestamp: now, type: 'ai_proposal', content: `${mode === 'deep' ? '深層' : ''}生成（${threadCount}通）: ${result.markdown.slice(0, 80)}` },
              ],
            };
            await window.electronAPI.saveNote(updated);
          } else {
            const newNote: MailNote = {
              id: noteId,
              mailId: mail.id,
              accountEmail: mail.accountEmail,
              subject: mail.subject,
              content: result.markdown,
              todos: [],
              quickLabel: detectedLabel,
              threadMessageCount: threadCount,
              history: [
                { timestamp: now, type: 'created', content: 'ノート作成' },
                { timestamp: now, type: 'ai_proposal', content: `AI生成（${threadCount}通）: ${result.markdown.slice(0, 80)}` },
              ],
              createdAt: now,
              updatedAt: now,
            };
            await window.electronAPI.saveNote(newNote);
          }
        }
      })
      .catch((err) => {
        console.error(`[NoteService] Error generating note ${noteId}:`, err);
        setTasks(prev => {
          const next = new Map(prev);
          const t = next.get(noteId);
          if (t) next.set(noteId, { ...t, status: 'error' });
          return next;
        });
      })
      .finally(() => {
        runningRef.current.delete(noteId);
        setRunningCount(runningRef.current.size);
        setTasks(prev => {
          const next = new Map(prev);
          const t = next.get(noteId);
          if (t && t.status === 'running') next.set(noteId, { ...t, status: 'done' });
          return next;
        });
        // Signal recently completed
        setRecentlyCompleted(prev => new Set(prev).add(noteId));
        setTimeout(() => {
          setRecentlyCompleted(prev => {
            const next = new Set(prev);
            next.delete(noteId);
            return next;
          });
        }, 5000);
      });
  }, []);

  const isGenerating = useCallback((noteId: string) => {
    return runningRef.current.has(noteId);
  }, []);

  return (
    <NoteServiceContext.Provider value={{ requestGeneration, isGenerating, tasks, runningCount, recentlyCompleted }}>
      {children}
    </NoteServiceContext.Provider>
  );
}

export function useNoteService(): NoteServiceValue {
  const ctx = useContext(NoteServiceContext);
  if (!ctx) throw new Error('useNoteService must be used within NoteServiceProvider');
  return ctx;
}
