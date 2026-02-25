import { useState, useEffect, useRef, useMemo } from 'react';
import type { MailItem, ThreadMessage, SenderColorMode } from '../types';
import { isSpamFolder } from '../hooks/useMailData';
import { formatDate } from '../utils/date';
import EmptyState from './shared/EmptyState';
import NotePanel from './NotePanel';

// ─── Sender category & color ──────────────────────────────
type SenderCategory = 'university' | 'research' | 'admin' | 'other';

const CATEGORY_STYLE: Record<SenderCategory, { color: string; hex: string; badge: string; badgeBg: string; label: string }> = {
  university: { color: 'text-sky-400',    hex: '#38bdf8', badge: 'text-sky-400',    badgeBg: 'bg-sky-500/15',    label: '大学' },
  research:   { color: 'text-violet-400', hex: '#a78bfa', badge: 'text-violet-400', badgeBg: 'bg-violet-500/15', label: '研究' },
  admin:      { color: 'text-teal-400',   hex: '#2dd4bf', badge: 'text-teal-400',   badgeBg: 'bg-teal-500/15',   label: '事務' },
  other:      { color: 'text-surface-300', hex: '#94a3b8', badge: 'text-surface-400', badgeBg: 'bg-surface-700/50', label: '外部' },
};

function classifySender(from: string): SenderCategory {
  const lower = from.toLowerCase();
  // Extract email from "Name <email>" format
  const emailMatch = lower.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1] : lower;
  const domain = email.split('@')[1] || '';

  // 大学: ac.jp, edu domains
  if (/\.ac\.jp$|\.edu$|\.edu\.|u-fukui|university|大学/.test(domain) || /\.ac\.jp$|\.edu$/.test(email)) {
    // Further distinguish admin vs academic
    if (/jimu|admin|office|gakumu|soumu|kyomu|事務|総務|学務|教務|支援|庶務|人事|経理|財務/.test(lower)) {
      return 'admin';
    }
    return 'university';
  }

  // 研究: research institutes, journals, conferences, grants
  if (/research|journal|ieee|springer|elsevier|wiley|arxiv|conference|symposium|jsps|jst|nedo|科研|学会|論文|査読|review|nii\.ac|\.go\.jp/.test(lower)) {
    return 'research';
  }

  // 事務系: government, support
  if (/\.go\.jp|support|noreply|no-reply|info@|admin|notification|system/.test(lower)) {
    return 'admin';
  }

  return 'other';
}

function senderColorMap(messages: { from: string; isSentByMe: boolean }[]): Map<string, SenderCategory> {
  const map = new Map<string, SenderCategory>();
  for (const msg of messages) {
    if (msg.isSentByMe) continue;
    const key = msg.from.split('<')[0].trim().toLowerCase() || msg.from.toLowerCase();
    if (!map.has(key)) {
      map.set(key, classifySender(msg.from));
    }
  }
  return map;
}

// ─── Inline text highlighting ────────────────────────────
interface TextSegment {
  text: string;
  type: 'plain' | 'date' | 'deadline' | 'urgent' | 'action' | 'url';
}

const HIGHLIGHT_REGEX = new RegExp(
  [
    // URLs (must be first — longest match)
    '(?<url>https?:\\/\\/[^\\s<>"{}|\\\\^`\\[\\]）」】]+)',
    // Urgent keywords
    '(?<urgent>至急|緊急|URGENT|重要|IMPORTANT|【重要】|【至急】|【緊急】)',
    // Deadline phrases  "期限：1月15日" etc.
    '(?<deadline>(?:期限|締切|〆切|deadline|due\\s*date)[:：\\s]*[^\\n。、]{3,30})',
    // Dates  "1月15日" "2025/1/15" "2025-01-15"
    '(?<date>\\d{1,2}月\\d{1,2}日(?:\\s*[\\(（][月火水木金土日]\\s*[\\)）])?|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})',
    // Action/importance keywords — broad business context
    '(?<action>' + [
      // Requests & actions
      '(?:お願い|ください|下さい|していただ|ご確認|ご検討|ご対応|ご報告|ご連絡|ご返信|ご提出|ご回答|ご査収|ご承認|ご判断|ご手配|ご準備)[^\\n。、]{0,20}',
      // Decisions & changes
      '(?:決定|変更|中止|延期|承認|却下|採用|不採用|合格|不合格|採択|可決|否決)[^\\n。、]{0,15}',
      // Amounts & numbers with context
      '(?:合計|総額|見積|請求|予算|費用|金額|報酬|給与)[:：]?\\s*[\\d,]+[万円]?',
      // Meeting & schedule
      '(?:会議|打合せ|打ち合わせ|ミーティング|面談|面接|説明会|セミナー|講演|発表)(?:の|は|を|が|に)[^\\n。、]{0,20}',
      // Results & outcomes
      '(?:結果|成果|報告|完了|終了|開始|着手|納品|提出済|受領|受理)[^\\n。、]{0,15}',
      // Conditional/important context
      '(?:必ず|必須|不可|禁止|注意|厳守|遵守|徹底)[^\\n。、]{0,15}',
    ].join('|') + ')',
  ].join('|'),
  'gi',
);

function tokenizeText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  // Reset regex state
  HIGHLIGHT_REGEX.lastIndex = 0;

  while ((m = HIGHLIGHT_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, m.index), type: 'plain' });
    }
    const type: TextSegment['type'] = m.groups?.url ? 'url'
      : m.groups?.urgent ? 'urgent'
      : m.groups?.deadline ? 'deadline'
      : m.groups?.date ? 'date'
      : 'action';
    segments.push({ text: m[0], type });
    lastIndex = m.index + m[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), type: 'plain' });
  }
  return segments;
}

const SEGMENT_STYLES: Record<TextSegment['type'], string> = {
  plain: '',
  date: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded px-0.5',
  deadline: 'bg-red-500/15 text-red-600 dark:text-red-400 font-semibold rounded px-0.5',
  urgent: 'bg-red-500/20 text-red-700 dark:text-red-400 font-bold rounded px-0.5',
  action: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded px-0.5',
  url: 'text-blue-600 dark:text-emerald-400 underline cursor-pointer hover:opacity-80',
};

function HighlightedText({ text }: { text: string }) {
  const segments = tokenizeText(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'url') {
          return (
            <a key={i} href={seg.text.replace(/[.,;:!?]+$/, '')} target="_blank" rel="noopener noreferrer"
              className={`text-xs ${SEGMENT_STYLES.url}`}>{seg.text}</a>
          );
        }
        if (seg.type === 'plain') {
          return <span key={i}>{seg.text}</span>;
        }
        return <span key={i} className={SEGMENT_STYLES[seg.type]}>{seg.text}</span>;
      })}
    </>
  );
}

// ─── Message body renderer (with inline highlighting) ────
function MessageBody({ text }: { text: string }) {
  if (!text) return null;
  const paragraphs = text.split(/\n{2,}/);
  return (
    <div className="space-y-1.5">
      {paragraphs.map((p, i) => (
        <p key={i} className="text-xs text-surface-300 whitespace-pre-wrap leading-relaxed">
          <HighlightedText text={p} />
        </p>
      ))}
    </div>
  );
}

// ─── Section collapse toggle ─────────────────────────────
function SectionToggle({
  label,
  open,
  onToggle,
  badge,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-surface-700/30">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full px-3 py-1 text-[10px] text-surface-300 hover:text-surface-100 transition-colors"
      >
        <span className={`text-[8px] transition-transform ${open ? 'rotate-90' : ''}`}>&#9654;</span>
        <span className="font-medium">{label}</span>
        {badge}
        <span className="flex-1" />
      </button>
      {open && children}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────
interface ThreadDetailPaneProps {
  selectedMail: MailItem | null;
  threadMessages: ThreadMessage[];
  threadLoading: boolean;
  selectedThreadMsgId: number | null;
  apiKey?: string;
  senderColorMode?: SenderColorMode;
  onInvestigate?: (mail: MailItem, userMessage: string) => void;
  investigateLoading?: boolean;
  onSendToCli?: (message: string) => void;
}

export default function ThreadDetailPane({
  selectedMail,
  threadMessages,
  threadLoading,
  selectedThreadMsgId,
  apiKey = '',
  senderColorMode = 'text',
  onInvestigate,
  investigateLoading = false,
  onSendToCli,
}: ThreadDetailPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const msgRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [bodyOpen, setBodyOpen] = useState(true);
  const [showInvestigate, setShowInvestigate] = useState(false);
  const [investigateMsg, setInvestigateMsg] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [draftInstruction, setDraftInstruction] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftCopied, setDraftCopied] = useState(false);

  useEffect(() => {
    if (selectedThreadMsgId && msgRefs.current.has(selectedThreadMsgId)) {
      msgRefs.current.get(selectedThreadMsgId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [selectedThreadMsgId]);

  const senderColors = useMemo(() => senderColorMap(threadMessages), [threadMessages]);

  if (!selectedMail) {
    return <EmptyState title="メールを選択" />;
  }

  const isThread = threadMessages.length > 1;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ── */}
      <div className="px-3 py-2 border-b border-surface-700/50 flex-shrink-0">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold text-surface-100 mb-0.5 line-clamp-2">
              {selectedMail.subject || '(件名なし)'}
            </h3>
            <div className="flex items-center gap-2 text-[10px] text-surface-400">
              <span className="truncate">
                {selectedMail.from ? selectedMail.from.displayName || selectedMail.from.address : '不明'}
              </span>
              <span className="text-surface-600">|</span>
              <span className="text-surface-500 flex-shrink-0">{formatDate(selectedMail.date)}</span>
              {isThread && (
                <span className="text-accent-400 bg-accent-500/15 px-1 rounded flex-shrink-0 text-[9px]">
                  {threadMessages.length}件
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Investigate button */}
            {onInvestigate && (
              <button
                onClick={() => setShowInvestigate((v) => !v)}
                disabled={investigateLoading}
                className={`px-1.5 py-0.5 text-[9px] rounded transition-colors ${
                  showInvestigate
                    ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                    : 'bg-purple-600/80 hover:bg-purple-500 text-white'
                } disabled:opacity-40`}
                title="このメールを調査"
              >
                {investigateLoading ? (
                  <span className="flex items-center gap-0.5">
                    <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    調査中
                  </span>
                ) : '調査'}
              </button>
            )}
            {/* Open in eM Client button */}
            <button
              onClick={() => window.electronAPI.openExternalUrl('emclient://')}
              className="px-1.5 py-0.5 text-[9px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded transition-colors"
              title="eM Clientを開く"
            >
              Open
            </button>
          </div>
        </div>

        {/* Investigation input area */}
        {showInvestigate && selectedMail && (
          <div className="px-3 py-1.5 border-t border-purple-500/20 bg-purple-500/5 space-y-1.5">
            <textarea
              value={investigateMsg}
              onChange={(e) => setInvestigateMsg(e.target.value)}
              placeholder="何を調べますか？（空でもOK）"
              rows={2}
              className="w-full bg-surface-800 border border-surface-600 rounded text-[10px] text-surface-300 px-2 py-1 resize-none focus:outline-none focus:border-purple-500/50 placeholder:text-surface-600"
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  if (onInvestigate && selectedMail) {
                    onInvestigate(selectedMail, investigateMsg);
                    setShowInvestigate(false);
                    setInvestigateMsg('');
                  }
                }}
                disabled={investigateLoading}
                className="px-2 py-0.5 text-[10px] bg-purple-600 hover:bg-purple-500 text-white rounded transition-colors disabled:opacity-40"
              >
                実行
              </button>
              {onSendToCli && (
                <button
                  onClick={() => {
                    if (onSendToCli && selectedMail) {
                      const sender = selectedMail.from?.displayName || selectedMail.from?.address || '不明';
                      const prompt = `以下のメールについて調査してください。\n件名: ${selectedMail.subject}\n差出人: ${sender}\nメールID: ${selectedMail.id}\nアカウント: ${selectedMail.accountEmail}\n${investigateMsg ? `\n追加指示: ${investigateMsg}` : ''}`;
                      onSendToCli(prompt);
                      setShowInvestigate(false);
                      setInvestigateMsg('');
                    }
                  }}
                  className="px-2 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded transition-colors"
                  title="ChatPanelのCLIにプロンプトを送信"
                >
                  CLIに送る
                </button>
              )}
              <button
                onClick={() => { setShowInvestigate(false); setInvestigateMsg(''); }}
                className="px-2 py-0.5 text-[10px] text-surface-500 hover:text-surface-300 transition-colors"
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef} style={{ minHeight: 0 }}>

        {/* ── Overview Note (top priority) ── */}
        <NotePanel mail={selectedMail} apiKey={apiKey} threadMessages={threadMessages} />

        {/* ── Message body (collapsible) ── */}
        <SectionToggle
          label={isThread ? 'スレッド本文' : 'メール本文'}
          open={bodyOpen}
          onToggle={() => setBodyOpen((v) => !v)}
          badge={
            isThread ? (
              <span className="text-[9px] text-surface-500">{threadMessages.length}通</span>
            ) : undefined
          }
        >
          {threadLoading ? (
            <div className="p-3 text-xs text-surface-500 animate-pulse">スレッド読込中...</div>
          ) : isThread ? (
            <div>
              {threadMessages.map((msg) => {
                const isActive = selectedThreadMsgId === msg.id;
                const senderName = msg.from.split('<')[0].trim() || msg.from;
                const senderKey = senderName.toLowerCase();
                const category = msg.isSentByMe ? null : (senderColors.get(senderKey) ?? 'other');
                const catStyle = category ? CATEGORY_STYLE[category] : null;
                const senderColor = msg.isSentByMe ? 'text-accent-400' : (catStyle?.color ?? 'text-surface-200');

                // Background mode: use hex color for inline style
                const bgModeStyle = senderColorMode === 'background' && !msg.isSentByMe && catStyle
                  ? { backgroundColor: catStyle.hex + '15', borderLeft: `3px solid ${catStyle.hex}` }
                  : undefined;

                return (
                  <div
                    key={msg.id}
                    ref={(el) => { if (el) msgRefs.current.set(msg.id, el); }}
                    className={`px-3 py-2 border-b border-surface-700/30 transition-colors ${
                      isActive
                        ? 'ring-1 ring-inset ring-accent-500/30'
                        : ''
                    } ${msg.isSentByMe ? 'bg-surface-800/40' : ''}`}
                    style={bgModeStyle}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {senderColorMode === 'background' && !msg.isSentByMe && catStyle ? (
                        <span className="text-[11px] font-medium text-surface-100">
                          {senderName}
                        </span>
                      ) : senderColorMode === 'none' ? (
                        <span className="text-[11px] font-medium text-surface-200">
                          {msg.isSentByMe ? '自分' : senderName}
                        </span>
                      ) : (
                        <span className={`text-[11px] font-medium ${senderColor}`}>
                          {msg.isSentByMe ? '自分' : senderName}
                        </span>
                      )}
                      {catStyle && (
                        <span className={`text-[8px] px-1 py-px rounded ${catStyle.badge} ${catStyle.badgeBg}`}>
                          {catStyle.label}
                        </span>
                      )}
                      <span className="text-[10px] text-surface-600 flex-shrink-0">
                        {formatDate(msg.date)}
                      </span>
                      {msg.folderName && (
                        <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${
                          isSpamFolder(msg.folderName) ? 'bg-amber-500/20 text-amber-400' : 'bg-surface-800 text-surface-500'
                        }`}>
                          {msg.folderName}
                        </span>
                      )}
                    </div>
                    {(msg.to.length > 0 || msg.cc.length > 0) && (
                      <div className="text-[10px] text-surface-500 mb-1">
                        {msg.to.length > 0 && <span>To: {msg.to.join(', ')}</span>}
                        {msg.cc.length > 0 && <span className="ml-2">Cc: {msg.cc.join(', ')}</span>}
                      </div>
                    )}
                    <MessageBody text={msg.preview} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-3">
              {selectedMail.to && selectedMail.to.length > 0 && (
                <div className="mb-2 text-[10px] text-surface-400">
                  <span className="font-medium text-surface-300">To: </span>
                  {selectedMail.to.map((addr) => addr.displayName || addr.address).join(', ')}
                </div>
              )}
              {selectedMail.folderName && (
                <div className="mb-2">
                  <span className={`text-[9px] px-1 py-0.5 rounded ${
                    isSpamFolder(selectedMail.folderName) ? 'bg-amber-500/20 text-amber-400' : 'bg-surface-800 text-surface-400'
                  }`}>{selectedMail.folderName}</span>
                </div>
              )}
              {selectedMail.preview && <MessageBody text={selectedMail.preview} />}
            </div>
          )}
        </SectionToggle>

        {/* ── Draft / Reply compose ── */}
        <SectionToggle
          label="返信ドラフト"
          open={draftOpen}
          onToggle={() => setDraftOpen((v) => !v)}
        >
          <div className="p-2 space-y-1.5">
            <div className="text-[9px] text-surface-400">
              To: {selectedMail.from?.address || '不明'}
            </div>
            <textarea
              value={draftText}
              onChange={(e) => { setDraftText(e.target.value); setDraftCopied(false); }}
              placeholder="返信内容を入力、またはAI返信案生成ボタンで自動作成..."
              rows={5}
              className="w-full bg-surface-800 border border-surface-600 rounded text-[11px] text-surface-200 px-2 py-1.5 resize-y focus:outline-none focus:border-accent-500/50 placeholder:text-surface-500"
            />
            <input
              type="text"
              value={draftInstruction}
              onChange={(e) => setDraftInstruction(e.target.value)}
              placeholder="AIへの追加指示（任意）例: 丁寧に断る、日程調整を提案..."
              className="w-full bg-surface-800 border border-surface-600 rounded text-[10px] text-surface-300 px-2 py-1 focus:outline-none focus:border-purple-500/50 placeholder:text-surface-600"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {/* AI返信案生成 */}
              <button
                onClick={async () => {
                  setDraftLoading(true);
                  try {
                    const result = await window.electronAPI.generateReplyDraft({
                      threadMessages,
                      mail: selectedMail,
                      instruction: draftInstruction || undefined,
                    });
                    if (result.status === 'done' && result.draft) {
                      setDraftText(result.draft);
                    } else if (result.error) {
                      setDraftText(`[エラー] ${result.error}`);
                    }
                  } catch (err) {
                    setDraftText(`[エラー] ${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setDraftLoading(false);
                  }
                }}
                disabled={draftLoading}
                className="px-2 py-0.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors disabled:opacity-40"
                title="スレッド文脈からAI返信案を生成"
              >
                {draftLoading ? (
                  <span className="flex items-center gap-1">
                    <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    生成中...
                  </span>
                ) : 'AI返信案生成'}
              </button>
              {/* AI改善 */}
              {draftText.trim() && (
                <button
                  onClick={async () => {
                    setDraftLoading(true);
                    try {
                      const result = await window.electronAPI.generateReplyDraft({
                        threadMessages,
                        mail: selectedMail,
                        instruction: draftInstruction || undefined,
                        existingDraft: draftText,
                      });
                      if (result.status === 'done' && result.draft) {
                        setDraftText(result.draft);
                      } else if (result.error) {
                        setDraftText(`[エラー] ${result.error}`);
                      }
                    } catch (err) {
                      setDraftText(`[エラー] ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setDraftLoading(false);
                    }
                  }}
                  disabled={draftLoading}
                  className="px-2 py-0.5 text-[10px] bg-purple-600/80 hover:bg-purple-500 text-white rounded transition-colors disabled:opacity-40"
                  title="既存ドラフトをAIで改善"
                >
                  AI改善
                </button>
              )}
              {/* コピー */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(draftText);
                  setDraftCopied(true);
                  setTimeout(() => setDraftCopied(false), 2000);
                }}
                disabled={!draftText.trim()}
                className="px-2 py-0.5 text-[10px] bg-accent-500 hover:bg-accent-600 text-white rounded transition-colors disabled:opacity-40"
              >
                {draftCopied ? 'コピー済' : 'コピー'}
              </button>
              {/* eM Clientで送信 (コピー→起動) */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(draftText);
                  setDraftCopied(true);
                  setTimeout(() => setDraftCopied(false), 2000);
                  window.electronAPI.openExternalUrl('emclient://');
                }}
                disabled={!draftText.trim()}
                className="px-2 py-0.5 text-[10px] bg-surface-700 hover:bg-surface-600 text-surface-300 rounded transition-colors disabled:opacity-40"
              >
                eM Clientで送信
              </button>
              {/* クリア */}
              {draftText.trim() && (
                <button
                  onClick={() => { setDraftText(''); setDraftInstruction(''); }}
                  className="px-2 py-0.5 text-[10px] text-surface-500 hover:text-surface-300 transition-colors"
                >
                  クリア
                </button>
              )}
            </div>
            {/* ローディング表示 */}
            {draftLoading && (
              <div className="flex items-center gap-2 text-[10px] text-emerald-400">
                <div className="flex-1 h-1 bg-surface-700 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded animate-pulse" style={{ width: '60%' }} />
                </div>
                <span>AI分析中...</span>
              </div>
            )}
          </div>
        </SectionToggle>
      </div>
    </div>
  );
}
