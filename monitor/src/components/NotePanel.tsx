import { useState, useEffect, useCallback, useRef } from 'react';
import type { MailItem, MailNote, MailTag, NoteTodo, NoteHistoryEntry, QuickLabel, ThreadMessage } from '../types';
import { BUILTIN_TAGS } from '../types';

// ─── Quick label definitions (for backward compat) ──────
const QUICK_LABELS: { id: QuickLabel; label: string; color: string }[] = [
  { id: 'unnecessary', label: '不要',   color: 'text-red-400 bg-red-500/15 border-red-500/30' },
  { id: 'reply',       label: '要返信', color: 'text-amber-400 bg-amber-500/15 border-amber-500/30' },
  { id: 'action',      label: '個別対応', color: 'text-orange-400 bg-orange-500/15 border-orange-500/30' },
  { id: 'hold',        label: '保留',   color: 'text-violet-400 bg-violet-500/15 border-violet-500/30' },
  { id: 'done',        label: '対応済', color: 'text-green-400 bg-green-500/15 border-green-500/30' },
];

function labelDef(id: QuickLabel | undefined) {
  return QUICK_LABELS.find((l) => l.id === id);
}

// ─── Tag color map (same as MailTable) ────────────────────
const TAG_COLOR_MAP: Record<string, { bg: string; text: string; border: string }> = {
  amber:   { bg: 'bg-amber-500/15',   text: 'text-amber-400',   border: 'border-amber-500/30' },
  orange:  { bg: 'bg-orange-500/15',  text: 'text-orange-400',  border: 'border-orange-500/30' },
  violet:  { bg: 'bg-violet-500/15',  text: 'text-violet-400',  border: 'border-violet-500/30' },
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  red:     { bg: 'bg-red-500/15',     text: 'text-red-400',     border: 'border-red-500/30' },
  sky:     { bg: 'bg-sky-500/15',     text: 'text-sky-400',     border: 'border-sky-500/30' },
  rose:    { bg: 'bg-rose-500/15',    text: 'text-rose-400',    border: 'border-rose-500/30' },
};

function resolveNoteTags(note: MailNote | null): string[] {
  if (!note) return [];
  if (note.tags && note.tags.length > 0) return note.tags;
  if (note.quickLabel) return [note.quickLabel];
  return [];
}

function TagBadge({ tag, onRemove }: { tag: MailTag; onRemove?: () => void }) {
  const colors = TAG_COLOR_MAP[tag.color] ?? { bg: 'bg-surface-600', text: 'text-surface-300', border: 'border-surface-500' };
  return (
    <span className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-px rounded border ${colors.bg} ${colors.text} ${colors.border}`}>
      {tag.label}
      {onRemove && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="hover:text-white ml-0.5">&times;</button>
      )}
    </span>
  );
}

// ─── Add tag dropdown ───────────────────────────────────
function AddTagDropdown({ currentTags, onAdd }: { currentTags: string[]; onAdd: (tagId: string) => void }) {
  const [open, setOpen] = useState(false);
  const available = BUILTIN_TAGS.filter(t => !currentTags.includes(t.id));
  if (available.length === 0) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[9px] text-surface-400 hover:text-surface-200 px-1 py-px rounded bg-surface-800 hover:bg-surface-700 transition-colors"
      >
        + タグ
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-surface-800 border border-surface-600 rounded shadow-lg p-1 min-w-[100px]">
          {available.map(tag => {
            const colors = TAG_COLOR_MAP[tag.color] ?? { bg: 'bg-surface-600', text: 'text-surface-300', border: 'border-surface-500' };
            return (
              <button
                key={tag.id}
                onClick={() => { onAdd(tag.id); setOpen(false); }}
                className={`block w-full text-left px-1.5 py-0.5 text-[9px] rounded ${colors.text} hover:${colors.bg} transition-colors`}
              >
                {tag.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Note ID from mail ──────────────────────────────────
function noteIdFromMail(mail: MailItem): string {
  return mail.conversationId
    ? `conv-${mail.conversationId}`
    : `mail-${mail.id}`;
}

// ─── Todo item component ─────────────────────────────────
function TodoRow({
  todo,
  onToggle,
  onDelete,
}: {
  todo: NoteTodo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 group py-0.5">
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => onToggle(todo.id)}
        className="w-3 h-3 rounded-sm border-surface-500 bg-surface-800 text-accent-500 focus:ring-0 flex-shrink-0"
      />
      <span className={`text-[11px] flex-1 min-w-0 ${
        todo.completed ? 'text-surface-400 line-through' : 'text-surface-100'
      }`}>
        {todo.text}
      </span>
      <button
        onClick={() => onDelete(todo.id)}
        className="text-[10px] text-surface-400 hover:text-red-400 opacity-0 group-hover:opacity-100 flex-shrink-0"
      >
        &times;
      </button>
    </div>
  );
}

// ─── History entry ───────────────────────────────────────
function HistoryEntry({ entry }: { entry: NoteHistoryEntry }) {
  const typeLabel = entry.type === 'ai_proposal' ? 'AI' : entry.type === 'created' ? '作成' : '更新';
  const typeColor = entry.type === 'ai_proposal' ? 'text-purple-400 bg-purple-500/15' : 'text-surface-300 bg-surface-700';
  const date = new Date(entry.timestamp);
  const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

  return (
    <div className="border-l-2 border-surface-600 pl-2 py-1">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={`text-[9px] px-1 py-px rounded ${typeColor}`}>{typeLabel}</span>
        <span className="text-[9px] text-surface-400">{timeStr}</span>
      </div>
      <p className="text-[10px] text-surface-300 whitespace-pre-wrap line-clamp-3">{entry.content}</p>
    </div>
  );
}

// ─── Simple markdown renderer ───────────────────────────
function renderInline(text: string): React.ReactNode[] {
  // Process inline: **bold**, ⚠️/🔴 markers, `code`
  const parts: React.ReactNode[] = [];
  const inlineRe = /(\*\*(.+?)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2]) {
      parts.push(<strong key={m.index} className="text-surface-50 font-semibold">{m[2]}</strong>);
    } else if (m[4]) {
      parts.push(<code key={m.index} className="text-[10px] bg-surface-700 px-0.5 rounded text-orange-300">{m[4]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Detect line context for coloring
function lineColor(text: string): string {
  const t = text.toLowerCase();
  if (/期限|締切|〆切|deadline|due/.test(t)) return 'text-red-400';
  if (/至急|緊急|urgent|重要/.test(t)) return 'text-red-500 font-semibold';
  if (/要返信|返信|reply/.test(t)) return 'text-amber-400';
  if (/対応|確認|提出|報告|連絡/.test(t)) return 'text-amber-300';
  if (/完了|済|done|resolved/.test(t)) return 'text-green-400';
  return 'text-surface-200';
}

function headingStyle(content: string): string {
  const t = content.toLowerCase();
  if (/⚠️|期限|締切|deadline/.test(t)) return 'text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded';
  if (/アクション|action|対応/.test(t)) return 'text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded';
  if (/判定|verdict/.test(t)) return 'text-accent-400 bg-accent-500/10 px-1.5 py-0.5 rounded';
  if (/要点|summary|概要/.test(t)) return 'text-surface-100 bg-surface-700/50 px-1.5 py-0.5 rounded';
  if (/メモ|note|関連|背景/.test(t)) return 'text-surface-300 bg-surface-700/30 px-1.5 py-0.5 rounded';
  return 'text-surface-100';
}

function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  // Track current section heading for context
  let currentSection = '';
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();
        // Heading ##
        if (trimmed.startsWith('## ')) {
          const content = trimmed.slice(3);
          currentSection = content.toLowerCase();
          return (
            <div key={i} className={`text-[11px] font-bold mt-2 mb-0.5 inline-block ${headingStyle(content)}`}>
              {renderInline(content)}
            </div>
          );
        }

        // Determine if this line is in an action/todo section
        const isActionSection = /アクション|action|対応|todo|タスク/.test(currentSection);
        const isDeadlineSection = /期限|締切|deadline/.test(currentSection);

        // Checkbox list - [ ] or - [x] → always checkbox
        if (/^[-*]\s*\[[ x]\]/.test(trimmed)) {
          const checked = /\[x\]/i.test(trimmed);
          const content = trimmed.replace(/^[-*]\s*\[[ x]\]\s*/, '');
          const color = checked ? '' : lineColor(content);
          return (
            <label key={i} className={`flex items-start gap-1.5 pl-1 py-0.5 rounded cursor-default ${
              !checked ? 'bg-amber-500/5' : ''
            }`}>
              <input
                type="checkbox"
                checked={checked}
                readOnly
                className={`w-3.5 h-3.5 mt-px rounded border flex-shrink-0 focus:ring-0 ${
                  checked
                    ? 'border-green-500/50 bg-green-500/20 text-green-500'
                    : 'border-amber-500/50 bg-surface-800 text-amber-500'
                }`}
              />
              <span className={`text-[10px] leading-snug ${
                checked ? 'text-surface-400 line-through' : color
              }`}>
                {renderInline(content)}
              </span>
            </label>
          );
        }

        // Bullet list → checkbox in action/deadline sections, plain bullet otherwise
        if (/^[-*]\s/.test(trimmed)) {
          const content = trimmed.replace(/^[-*]\s+/, '');
          const color = lineColor(content);

          if (isActionSection || isDeadlineSection) {
            return (
              <label key={i} className="flex items-start gap-1.5 pl-1 py-0.5 rounded cursor-default bg-amber-500/5">
                <input
                  type="checkbox"
                  checked={false}
                  readOnly
                  className={`w-3.5 h-3.5 mt-px rounded border flex-shrink-0 focus:ring-0 ${
                    isDeadlineSection
                      ? 'border-red-500/50 bg-surface-800 text-red-500'
                      : 'border-amber-500/50 bg-surface-800 text-amber-500'
                  }`}
                />
                <span className={`text-[10px] leading-snug ${
                  isDeadlineSection ? 'text-red-400' : color
                }`}>
                  {renderInline(content)}
                </span>
              </label>
            );
          }

          return (
            <div key={i} className="flex items-start gap-1 pl-1">
              <span className="text-[10px] text-surface-500 flex-shrink-0 mt-px">•</span>
              <span className={`text-[10px] ${color}`}>{renderInline(content)}</span>
            </div>
          );
        }
        // Empty line
        if (!trimmed) return <div key={i} className="h-1" />;
        // Normal text
        return (
          <p key={i} className={`text-[10px] leading-relaxed ${lineColor(trimmed)}`}>{renderInline(trimmed)}</p>
        );
      })}
    </div>
  );
}

// ─── Main NotePanel ──────────────────────────────────────
interface NotePanelProps {
  mail: MailItem;
  apiKey: string;
  threadMessages?: ThreadMessage[];
}

export default function NotePanel({ mail, apiKey, threadMessages }: NotePanelProps) {
  const [note, setNote] = useState<MailNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [newTodo, setNewTodo] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const noteId = noteIdFromMail(mail);

  // Load note when mail changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.electronAPI.getNote(noteId).then((loaded) => {
      if (!cancelled) {
        setNote(loaded);
        setEditing(false);
        setShowHistory(false);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [noteId]);

  const saveNote = useCallback(async (updated: MailNote) => {
    setNote(updated);
    await window.electronAPI.saveNote(updated);
  }, []);

  // Create new note
  const handleCreate = useCallback(() => {
    const now = new Date().toISOString();
    const newNote: MailNote = {
      id: noteId,
      mailId: mail.id,
      accountEmail: mail.accountEmail,
      subject: mail.subject,
      content: '',
      todos: [],
      history: [{ timestamp: now, type: 'created', content: 'ノート作成' }],
      createdAt: now,
      updatedAt: now,
    };
    saveNote(newNote);
    setEditing(true);
    setEditContent('');
  }, [noteId, mail, saveNote]);

  // Save edit
  const handleSaveEdit = useCallback(() => {
    if (!note) return;
    const now = new Date().toISOString();
    const updated: MailNote = {
      ...note,
      content: editContent,
      updatedAt: now,
      history: [...note.history, { timestamp: now, type: 'updated', content: editContent.slice(0, 100) }],
    };
    saveNote(updated);
    setEditing(false);
  }, [note, editContent, saveNote]);

  // Toggle quick label
  const handleQuickLabel = useCallback((labelId: QuickLabel) => {
    if (!note) {
      // Auto-create note with label
      const now = new Date().toISOString();
      const newNote: MailNote = {
        id: noteId,
        mailId: mail.id,
        accountEmail: mail.accountEmail,
        subject: mail.subject,
        content: '',
        todos: [],
        quickLabel: labelId,
        tags: [labelId],
        history: [{ timestamp: now, type: 'created', content: `タグ: ${BUILTIN_TAGS.find((t) => t.id === labelId)?.label}` }],
        createdAt: now,
        updatedAt: now,
      };
      saveNote(newNote);
      return;
    }
    const now = new Date().toISOString();
    const isToggleOff = note.quickLabel === labelId;
    const newTags = isToggleOff
      ? (note.tags ?? []).filter(t => t !== labelId)
      : [...new Set([...(note.tags ?? []), labelId])];
    const updated: MailNote = {
      ...note,
      quickLabel: isToggleOff ? undefined : labelId,
      tags: newTags,
      updatedAt: now,
    };
    saveNote(updated);
  }, [note, noteId, mail, saveNote]);

  // Toggle todo
  const handleToggleTodo = useCallback((todoId: string) => {
    if (!note) return;
    const updated: MailNote = {
      ...note,
      todos: note.todos.map((t) => t.id === todoId ? { ...t, completed: !t.completed } : t),
      updatedAt: new Date().toISOString(),
    };
    saveNote(updated);
  }, [note, saveNote]);

  // Delete todo
  const handleDeleteTodo = useCallback((todoId: string) => {
    if (!note) return;
    const updated: MailNote = {
      ...note,
      todos: note.todos.filter((t) => t.id !== todoId),
      updatedAt: new Date().toISOString(),
    };
    saveNote(updated);
  }, [note, saveNote]);

  // Add todo
  const handleAddTodo = useCallback(() => {
    if (!note || !newTodo.trim()) return;
    const now = new Date().toISOString();
    const todo: NoteTodo = {
      id: `todo-${Date.now()}`,
      text: newTodo.trim(),
      completed: false,
      createdAt: now,
    };
    const updated: MailNote = {
      ...note,
      todos: [...note.todos, todo],
      updatedAt: now,
    };
    saveNote(updated);
    setNewTodo('');
  }, [note, newTodo, saveNote]);

  // AI: Update note (re-analyze with existing note context)
  const handleAiUpdate = useCallback(async () => {
    if (!note || !apiKey || aiLoading) return;
    setAiLoading(true);
    try {
      const prompt = `以下のメールを分析して、既存ノートを更新してください。
新しい情報があれば追記、状況変化があれば修正。重要な箇所は**太字**、
締切は赤字相当（⚠️マーク付き）、緊急度が分かるように記載してください。

件名: ${mail.subject}
差出人: ${mail.from?.displayName || mail.from?.address || '不明'}
本文: ${mail.preview?.slice(0, 1500) || '(本文なし)'}

既存ノート:
${note.content || '(空)'}

以下の形式で出力（マークダウン）:
## 判定
[不要 / 要返信 / 個別対応 / 保留 / 対応済] — 理由を1文で

## 要点
- **重要な点は太字**で記載
- ...

## アクション
- [ ] 具体的なタスク（担当が自分なら「→自分」）
- [ ] ...

## ⚠️ 期限
- 日付と内容

## メモ
- 背景情報や注意点`;

      const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'light' });
      if (result.status === 'done' && result.markdown) {
        const now = new Date().toISOString();
        const updated: MailNote = {
          ...note,
          content: result.markdown,
          updatedAt: now,
          history: [
            ...note.history,
            { timestamp: now, type: 'ai_proposal', content: `更新: ${result.markdown.slice(0, 100)}` },
          ],
        };
        saveNote(updated);
      }
    } finally {
      setAiLoading(false);
    }
  }, [note, mail, apiKey, aiLoading, saveNote]);

  // AI: Reconsider (fresh analysis ignoring existing note)
  const handleAiReconsider = useCallback(async () => {
    if (!note || !apiKey || aiLoading) return;
    setAiLoading(true);
    try {
      const prompt = `以下のメールを白紙から分析してください。
先入観なく、内容を読み、重要箇所を**太字**、締切を⚠️付き、
緊急なものは🔴マークで強調してください。

件名: ${mail.subject}
差出人: ${mail.from?.displayName || mail.from?.address || '不明'}
本文: ${mail.preview?.slice(0, 2000) || '(本文なし)'}

以下の形式で出力（マークダウン）:
## 判定
[不要 / 要返信 / 個別対応 / 保留 / 対応済] — 理由を1文で

## 要点
- **重要な点は太字**で記載
- ...

## アクション
- [ ] 具体的なタスク（担当が自分なら「→自分」）
- [ ] ...

## ⚠️ 期限
- 日付と内容

## メモ
- 背景情報や注意点

## 判断
このメールに対して取るべき行動（返信要/不要/対応必要/情報のみ等）`;

      const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'light' });
      if (result.status === 'done' && result.markdown) {
        const now = new Date().toISOString();
        const updated: MailNote = {
          ...note,
          content: result.markdown,
          updatedAt: now,
          history: [
            ...note.history,
            { timestamp: now, type: 'ai_proposal', content: `再検討: ${result.markdown.slice(0, 100)}` },
          ],
        };
        saveNote(updated);
      }
    } finally {
      setAiLoading(false);
    }
  }, [note, mail, apiKey, aiLoading, saveNote]);

  // Shared: generate or update note with AI analysis
  const generateOrUpdateNote = useCallback(async () => {
    if (!apiKey || aiLoading) return;
    setAiLoading(true);
    try {
      // Build thread context (cap each message to 3000 chars, total thread to 30000 chars)
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
          const part = `--- メッセージ ${i + 1}/${threadMessages.length} ${dir} ---
差出人: ${msg.from}
宛先: ${msg.to.join(', ')}${msg.cc.length > 0 ? `\nCC: ${msg.cc.join(', ')}` : ''}
日時: ${dateStr}
件名: ${msg.subject}
本文:
${body}`;
          if (totalLen + part.length > MAX_THREAD_LEN) {
            parts.push(`\n... 以降 ${threadMessages.length - i}通は省略（文字数制限） ...`);
            break;
          }
          parts.push(part);
          totalLen += part.length;
        }
        threadSection = parts.join('\n\n');
      } else {
        threadSection = `件名: ${mail.subject}\n差出人: ${mail.from?.displayName || mail.from?.address || '不明'}\n本文: ${mail.preview?.slice(0, 2000) || '(本文なし)'}`;
      }

      const existingNoteSection = note?.content
        ? `\n\n=== 既存ノート ===\n${note.content}`
        : '';

      const prompt = `あなたは業務メール分析のエキスパートです。以下のメールスレッド全文を読み、この案件について深く分析してください。

=== メール情報 ===
件名: ${mail.subject}
アカウント: ${mail.accountEmail}

=== スレッド全文（${threadMessages?.length || 1}通） ===
${threadSection}
${existingNoteSection}

以下の観点で分析し、マークダウン形式で出力してください:

## 案件概要
このスレッドは何の仕事/案件か。1-2文で簡潔に。

## 自分の役割
アカウント所有者（${mail.accountEmail}）は何を求められているか。自分が送信したメッセージがあれば、それも踏まえて。

## 現在のステータス
- 誰のアクション待ちか
- 何が未解決か
- 進行中の事項

## アクション
- [ ] 具体的にやるべきこと（担当が自分なら「→自分」）
- [ ] ...

## ⚠️ 期限
- 明示された期限（日付）
- 暗示された期限（文脈から推測）

## 判定
[不要 / 要返信 / 個別対応 / 保留 / 対応済] — 理由を1文で

## メモ
- 背景情報や注意点`;

      const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'light' });
      if (result.status === 'done' && result.markdown) {
        const now = new Date().toISOString();
        const threadCount = threadMessages?.length ?? 1;

        // Extract quickLabel from result
        let detectedLabel: QuickLabel | undefined;
        const verdictMatch = result.markdown.match(/## 判定\s*\n\s*\[?\s*(不要|要返信|個別対応|保留|対応済)/);
        if (verdictMatch) {
          const labelMap: Record<string, QuickLabel> = {
            '不要': 'unnecessary', '要返信': 'reply', '個別対応': 'action', '保留': 'hold', '対応済': 'done',
          };
          detectedLabel = labelMap[verdictMatch[1]];
        }

        if (note) {
          // Update existing note
          const updated: MailNote = {
            ...note,
            content: result.markdown,
            quickLabel: detectedLabel || note.quickLabel,
            threadMessageCount: threadCount,
            updatedAt: now,
            history: [
              ...note.history,
              { timestamp: now, type: 'ai_proposal', content: `再生成（スレッド${threadCount}通）: ${result.markdown.slice(0, 80)}` },
            ],
          };
          saveNote(updated);
        } else {
          // Create new note
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
              { timestamp: now, type: 'ai_proposal', content: `AI自動生成（スレッド${threadCount}通）: ${result.markdown.slice(0, 80)}` },
            ],
            createdAt: now,
            updatedAt: now,
          };
          saveNote(newNote);
        }
      }
    } finally {
      setAiLoading(false);
    }
  }, [note, mail, apiKey, aiLoading, threadMessages, noteId, saveNote]);

  // AI: Deep regeneration (MCP tools for thorough analysis + note save)
  const handleDeepRegenerate = useCallback(async () => {
    if (!apiKey || aiLoading) return;
    setAiLoading(true);
    try {
      const prompt = `あなたはメール分析の専門家です。以下のメールについてMCPツールを使って徹底的に調査し、ノートを作成・更新してください。

=== 対象メール ===
メールID: ${mail.id}
${mail.conversationId ? `会話ID: ${mail.conversationId}` : ''}
件名: ${mail.subject}
差出人: ${mail.from?.displayName || mail.from?.address || '不明'}
アカウント: ${mail.accountEmail}

=== 調査手順 ===
1. まず mcp__shirabe__get_note でメールID ${mail.id}${mail.conversationId ? ` (会話ID: ${mail.conversationId})` : ''} の既存ノートを確認
2. mcp__shirabe__get_mail_detail でメールID ${mail.id} の本文を取得
3. mcp__shirabe__get_mail_thread でスレッド全体を取得して文脈を把握
4. mcp__shirabe__analyze_thread でスレッドのアクション項目・緊急度を分析
5. 必要に応じて mcp__shirabe__search_mails で関連メールを検索
6. mcp__shirabe__update_note で調査結果をノートに保存:
   - mail_id: ${mail.id}
   - content: 以下のマークダウン形式
   - todos: 抽出したアクション項目
   - tags: 判定カテゴリ (urgent/reply/action/info/unnecessary/hold)
   ${mail.conversationId ? `- conversation_id: ${mail.conversationId}` : ''}

=== ノートの出力形式（Markdown） ===
## 案件概要
このスレッドの概要を1-2文で。

## 自分の役割
${mail.accountEmail} が求められていること。

## 現在のステータス
- 誰のアクション待ちか
- 未解決事項

## 判定
**【カテゴリ】** — 理由1文

## アクション
- [ ] 具体的なタスク（→自分 or →相手）

## ⚠️ 期限
- 期限があれば記載

## メモ
- 背景情報や注意点

=== 重要 ===
- 必ず最後に update_note でノートに保存すること
- 既存ノートがある場合は replace_content: true で全体を置き換え
- 最終的な分析結果をMarkdown形式で出力すること`;

      const result = await window.electronAPI.runClaudeAnalysis(prompt, { mode: 'deep' });

      // After deep analysis, MCP update_note may have written directly to the note file.
      // Reload note from disk to get the latest state.
      const reloaded = await window.electronAPI.getNote(noteId);
      if (reloaded) {
        setNote(reloaded);
      } else if (result.status === 'done' && result.markdown) {
        // Fallback: MCP didn't save, so save from result
        const now = new Date().toISOString();
        const threadCount = threadMessages?.length ?? 1;

        let detectedLabel: QuickLabel | undefined;
        const verdictMatch = result.markdown.match(/## 判定\s*\n\s*\*?\*?\s*【\s*(至急|要返信|要対応|情報|不要|保留)/);
        if (verdictMatch) {
          const labelMap: Record<string, QuickLabel> = {
            '至急': 'action', '要返信': 'reply', '要対応': 'action', '情報': 'done', '不要': 'unnecessary', '保留': 'hold',
          };
          detectedLabel = labelMap[verdictMatch[1]];
        }

        if (note) {
          const updated: MailNote = {
            ...note,
            content: result.markdown,
            quickLabel: detectedLabel || note.quickLabel,
            threadMessageCount: threadCount,
            updatedAt: now,
            history: [
              ...note.history,
              { timestamp: now, type: 'ai_proposal', content: `深層再生成（MCP）: ${result.markdown.slice(0, 80)}` },
            ],
          };
          saveNote(updated);
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
              { timestamp: now, type: 'ai_proposal', content: `深層再生成（MCP）: ${result.markdown.slice(0, 80)}` },
            ],
            createdAt: now,
            updatedAt: now,
          };
          saveNote(newNote);
        }
      }
    } finally {
      setAiLoading(false);
    }
  }, [note, mail, apiKey, aiLoading, threadMessages, noteId, saveNote]);

  // Regenerate: manual trigger uses deep analysis with MCP tools
  const handleRegenerate = handleDeepRegenerate;

  // Auto-generate: create note if none exists, or update if thread has grown
  useEffect(() => {
    if (!apiKey || aiLoading || loading) return;

    const shouldGenerate = !note;
    const shouldUpdate = note && threadMessages && threadMessages.length > 0
      && (note.threadMessageCount ?? 0) < threadMessages.length;

    if (!shouldGenerate && !shouldUpdate) return;

    const timer = setTimeout(() => {
      generateOrUpdateNote();
    }, 500);

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, loading, noteId, threadMessages?.length, apiKey]);

  // Delete note
  const handleDelete = useCallback(async () => {
    if (!note) return;
    await window.electronAPI.deleteNote(note.id);
    setNote(null);
    setEditing(false);
  }, [note]);

  if (loading) {
    return (
      <div className="px-3 py-2 text-[10px] text-surface-300 animate-pulse bg-surface-900">
        ノート読込中...
      </div>
    );
  }

  const activeLabelDef = note ? labelDef(note.quickLabel) : undefined;

  // No note yet — show create button + quick labels (or auto-generating indicator)
  if (!note) {
    if (aiLoading) {
      return (
        <div className="mx-2 my-2 px-3 py-2 rounded-lg border-2 border-accent-500/30 bg-accent-500/8 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-accent-400">&#9642; ノート</span>
            <span className="text-[10px] text-purple-400 animate-pulse">AI分析中...</span>
          </div>
        </div>
      );
    }
    return (
      <div className="mx-2 my-2 px-3 py-2 rounded-lg border-2 border-accent-500/30 bg-accent-500/8 shadow-sm">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-bold text-accent-400">&#9642; ノート</span>
          <span className="text-surface-500 text-[9px]">|</span>
          <button
            onClick={handleRegenerate}
            disabled={aiLoading || !apiKey}
            className="px-1.5 py-px text-[9px] bg-emerald-600/80 hover:bg-emerald-500 text-white rounded transition-colors disabled:opacity-40"
            title={!apiKey ? 'APIキー未設定' : 'スレッド全文から深い分析でノート生成'}
          >
            {aiLoading ? '分析中...' : '再生成'}
          </button>
          <button
            onClick={handleCreate}
            className="text-[10px] text-surface-300 hover:text-accent-400 transition-colors"
          >
            + 作成
          </button>
          <span className="text-surface-500 text-[9px]">|</span>
          {BUILTIN_TAGS.slice(0, 5).map((tag) => {
            const colors = TAG_COLOR_MAP[tag.color] ?? { bg: 'bg-surface-600', text: 'text-surface-300', border: 'border-surface-500' };
            return (
              <button
                key={tag.id}
                onClick={() => handleQuickLabel(tag.id as QuickLabel)}
                className={`px-1.5 py-px text-[9px] rounded border transition-colors ${colors.text} ${colors.bg} ${colors.border} hover:opacity-80`}
              >
                {tag.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col mx-2 my-2 rounded-lg border-2 border-accent-500/30 bg-accent-500/8 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-3 py-1 flex items-center gap-1 bg-accent-500/15 border-b border-accent-500/25 flex-shrink-0 flex-wrap">
        <span className="text-[10px] font-bold text-accent-400">&#9642; ノート概要</span>
        {activeLabelDef && (
          <span className={`px-1.5 py-px text-[9px] rounded border ${activeLabelDef.color} font-medium`}>
            {activeLabelDef.label}
          </span>
        )}
        <div className="flex-1" />
        {/* AI buttons */}
        <button
          onClick={handleRegenerate}
          disabled={aiLoading || !apiKey}
          className="px-1.5 py-px text-[9px] bg-emerald-600/80 hover:bg-emerald-500 text-white rounded transition-colors disabled:opacity-40"
          title={!apiKey ? 'APIキー未設定' : 'スレッド全文から深い分析で再生成'}
        >
          {aiLoading ? '分析中...' : '再生成'}
        </button>
        <button
          onClick={handleAiUpdate}
          disabled={aiLoading || !apiKey}
          className="px-1.5 py-px text-[9px] bg-purple-600/80 hover:bg-purple-500 text-white rounded transition-colors disabled:opacity-40"
          title={!apiKey ? 'APIキー未設定' : '既存ノートを元にAI更新'}
        >
          {aiLoading ? '分析中...' : '更新'}
        </button>
        <button
          onClick={handleAiReconsider}
          disabled={aiLoading || !apiKey}
          className="px-1.5 py-px text-[9px] bg-indigo-600/80 hover:bg-indigo-500 text-white rounded transition-colors disabled:opacity-40"
          title={!apiKey ? 'APIキー未設定' : 'メールを再分析（白紙から）'}
        >
          再検討
        </button>
        <button
          onClick={() => {
            if (editing) {
              handleSaveEdit();
            } else {
              setEditContent(note.content);
              setEditing(true);
              setTimeout(() => textareaRef.current?.focus(), 50);
            }
          }}
          className="px-1.5 py-px text-[9px] bg-surface-700 hover:bg-surface-600 text-surface-200 rounded transition-colors"
        >
          {editing ? '保存' : '編集'}
        </button>
        {editing && (
          <button
            onClick={() => setEditing(false)}
            className="px-1.5 py-px text-[9px] text-surface-400 hover:text-surface-200"
          >
            取消
          </button>
        )}
        <button
          onClick={() => setShowHistory((v) => !v)}
          className={`px-1.5 py-px text-[9px] rounded transition-colors ${
            showHistory ? 'bg-accent-500/20 text-accent-400' : 'text-surface-300 hover:text-surface-100'
          }`}
        >
          履歴
        </button>
        <button
          onClick={handleDelete}
          className="text-[9px] text-surface-400 hover:text-red-400 transition-colors"
          title="ノート削除"
        >
          &times;
        </button>
      </div>

      {/* Tags */}
      <div className="px-3 py-1 flex items-center gap-1 border-b border-surface-700 flex-shrink-0 flex-wrap">
        {resolveNoteTags(note).map(tagId => {
          const tag = BUILTIN_TAGS.find(t => t.id === tagId);
          if (!tag) return null;
          return (
            <TagBadge key={tag.id} tag={tag} onRemove={() => {
              const currentTags = resolveNoteTags(note);
              const newTags = currentTags.filter(t => t !== tagId);
              saveNote({ ...note, tags: newTags, quickLabel: undefined, updatedAt: new Date().toISOString() });
            }} />
          );
        })}
        {/* Add tag dropdown */}
        <AddTagDropdown
          currentTags={resolveNoteTags(note)}
          onAdd={(tagId) => {
            const currentTags = resolveNoteTags(note);
            if (currentTags.includes(tagId)) return;
            const newTags = [...currentTags, tagId];
            // Also set quickLabel for backward compat if it's a known label
            const qlMap: Record<string, QuickLabel> = { reply: 'reply', action: 'action', hold: 'hold', done: 'done', unnecessary: 'unnecessary' };
            saveNote({ ...note, tags: newTags, quickLabel: qlMap[tagId] ?? note.quickLabel, updatedAt: new Date().toISOString() });
          }}
        />
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-3 py-1.5" style={{ minHeight: 0, maxHeight: '240px' }}>
        {editing ? (
          <textarea
            ref={textareaRef}
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSaveEdit();
              }
            }}
            className="w-full h-full min-h-[80px] bg-surface-800 border border-surface-500 rounded text-[11px] text-surface-100 p-2 resize-none focus:outline-none focus:border-accent-500/50"
            placeholder="ノートを入力... (Ctrl+Enter で保存)"
          />
        ) : note.content ? (
          <SimpleMarkdown text={note.content} />
        ) : (
          <p className="text-[10px] text-surface-400 italic">ノート未記入（編集 or AI更新で追加）</p>
        )}
      </div>

      {/* History */}
      {showHistory && note.history.length > 0 && (
        <div className="px-3 py-1.5 border-t border-surface-700 max-h-[120px] overflow-y-auto">
          <div className="text-[9px] text-surface-300 font-medium mb-1">履歴</div>
          <div className="space-y-1">
            {[...note.history].reverse().map((entry, i) => (
              <HistoryEntry key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
