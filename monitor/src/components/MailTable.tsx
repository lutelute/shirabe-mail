import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type {
  MailItem,
  MailColumnId,
  MailColumnDef,
  JunkClassification,
  SortState,
  SortDirection,
  ThreadMessage,
  MailNote,
  MailTag,
  SenderColorMode,
} from '../types';
import { MAIL_COLUMN_OPTIONS, BUILTIN_TAGS } from '../types';
import { formatDate } from '../utils/date';
import { getSenderColor, getSenderBgStyle } from '../utils/mailColors';
import { openInEmClient } from '../utils/openInEmClient';

// ─── Tag color map (Tailwind-safe static classes) ────────
const TAG_COLOR_MAP: Record<string, { bg: string; text: string }> = {
  amber:   { bg: 'bg-amber-500/15',   text: 'text-amber-400' },
  orange:  { bg: 'bg-orange-500/15',  text: 'text-orange-400' },
  violet:  { bg: 'bg-violet-500/15',  text: 'text-violet-400' },
  emerald: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  red:     { bg: 'bg-red-500/15',     text: 'text-red-400' },
  sky:     { bg: 'bg-sky-500/15',     text: 'text-sky-400' },
  rose:    { bg: 'bg-rose-500/15',    text: 'text-rose-400' },
};

function resolveTagsForNote(note: MailNote | undefined, customTags: MailTag[] = []): MailTag[] {
  if (!note) return [];
  const allTags = [...BUILTIN_TAGS, ...customTags];
  const tagIds: string[] = [];
  if (note.tags && note.tags.length > 0) {
    tagIds.push(...note.tags);
  } else if (note.quickLabel) {
    tagIds.push(note.quickLabel);
  }
  return tagIds.map(id => allTags.find(t => t.id === id)).filter(Boolean) as MailTag[];
}

// ─── Default pixel widths for each column ───────────────
function defaultPixelWidth(def: MailColumnDef): number {
  if (def.width.includes(' ')) return 0; // flex column
  return parseInt(def.width, 10) || 60;
}

// ─── Column style helper (uses overrides when available) ─
function colStyle(def: MailColumnDef, overrideWidth?: number): React.CSSProperties {
  if (def.width.includes(' ') && overrideWidth === undefined) {
    const [grow, shrink, basis] = def.width.split(' ');
    return { flex: `${grow} ${shrink} ${basis}`, minWidth: 0 };
  }
  if (overrideWidth !== undefined && overrideWidth > 0) {
    return { width: `${overrideWidth}px`, flexShrink: 0 };
  }
  if (def.width.includes(' ')) {
    const [grow, shrink, basis] = def.width.split(' ');
    return { flex: `${grow} ${shrink} ${basis}`, minWidth: 0 };
  }
  return { width: def.width, flexShrink: 0 };
}

// ─── Column resize hook ─────────────────────────────────
function useColWidths(colDefs: MailColumnDef[]) {
  const [widths, setWidths] = useState<Map<MailColumnId, number>>(new Map());
  const drag = useRef<{ colId: MailColumnId; startX: number; startW: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - drag.current.startX;
      const newW = Math.max(20, drag.current.startW + dx);
      setWidths((prev) => new Map(prev).set(drag.current!.colId, newW));
    };
    const up = () => {
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const onResizeDown = useCallback((colId: MailColumnId, e: React.MouseEvent) => {
    e.stopPropagation();
    const def = colDefs.find((d) => d.id === colId);
    const currentW = widths.get(colId) ?? (def ? defaultPixelWidth(def) : 60);
    drag.current = { colId, startX: e.clientX, startW: currentW };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [colDefs, widths]);

  const getWidth = useCallback((colId: MailColumnId): number | undefined => {
    return widths.get(colId);
  }, [widths]);

  return { getWidth, onResizeDown };
}

// ─── Column config popover ──────────────────────────────
function MailColumnConfigPopover({
  columns,
  onChange,
  onClose,
}: {
  columns: MailColumnId[];
  onChange: (cols: MailColumnId[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<MailColumnId[]>([...columns]);

  const toggle = (id: MailColumnId) =>
    setDraft((p) => (p.includes(id) ? p.filter((c) => c !== id) : [...p, id]));

  const move = (idx: number, dir: -1 | 1) => {
    const t = idx + dir;
    if (t < 0 || t >= draft.length) return;
    setDraft((p) => {
      const n = [...p];
      [n[idx], n[t]] = [n[t], n[idx]];
      return n;
    });
  };

  return (
    <div className="absolute right-0 top-full mt-1 z-20 bg-surface-800 border border-surface-600 rounded shadow-xl p-2 w-52">
      <div className="text-[10px] text-surface-400 mb-1 font-medium uppercase tracking-wide">カラム設定</div>
      {MAIL_COLUMN_OPTIONS.map((col) => {
        const on = draft.includes(col.id);
        const idx = draft.indexOf(col.id);
        return (
          <div key={col.id} className="flex items-center gap-1 py-0.5">
            <input type="checkbox" checked={on} onChange={() => toggle(col.id)}
              className="w-3 h-3 rounded-sm border-surface-600 bg-surface-700 text-blue-500 focus:ring-0" />
            <span className="text-xs text-surface-300 flex-1">{col.label || col.id}</span>
            {on && (
              <div className="flex gap-px">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="text-[10px] text-surface-400 hover:text-white disabled:opacity-20 px-0.5">&uarr;</button>
                <button onClick={() => move(idx, 1)} disabled={idx === draft.length - 1}
                  className="text-[10px] text-surface-400 hover:text-white disabled:opacity-20 px-0.5">&darr;</button>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex justify-end gap-1 mt-1.5 pt-1 border-t border-surface-700">
        <button onClick={onClose} className="px-2 py-0.5 text-[10px] text-surface-400 hover:text-white">戻る</button>
        <button onClick={() => { onChange(draft); onClose(); }}
          className="px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-500">適用</button>
      </div>
    </div>
  );
}

// ─── Sortable header ────────────────────────────────────
function SortableHeader({
  def,
  sort,
  onSort,
}: {
  def: MailColumnDef;
  sort: SortState | null;
  onSort: (col: MailColumnId) => void;
}) {
  const isActive = sort?.column === def.id;
  return (
    <div
      className={`truncate px-0.5 flex-1 ${def.sortable ? 'cursor-pointer hover:text-surface-200' : ''} ${
        isActive ? 'text-accent-400' : ''
      }`}
      onClick={() => def.sortable && onSort(def.id)}
    >
      {def.label}
      {isActive && (
        <span className="ml-0.5 text-[8px]">
          {sort?.direction === 'asc' ? '\u25B2' : '\u25BC'}
        </span>
      )}
    </div>
  );
}

// ─── Cell content renderer ──────────────────────────────
function MailCellContent({
  colId,
  mail,
  isChecked,
  onCheck,
  junk,
  tags,
  senderColorMode,
}: {
  colId: MailColumnId;
  mail: MailItem;
  isChecked: boolean;
  onCheck: (id: number) => void;
  junk: JunkClassification | null;
  tags: MailTag[];
  senderColorMode: SenderColorMode;
}) {
  switch (colId) {
    case 'checkbox':
      return (
        <div className="flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => onCheck(mail.id)}
            className="w-3 h-3 rounded-sm border-surface-600 bg-surface-700 text-accent-500 focus:ring-0"
          />
        </div>
      );
    case 'unread':
      return (
        <div className="flex items-center justify-center">
          {!mail.isRead && <span className="w-1.5 h-1.5 rounded-full bg-accent-400" />}
        </div>
      );
    case 'from': {
      const senderColor = getSenderColor(mail.from?.address);
      const displayName = mail.from ? mail.from.displayName || mail.from.address.split('@')[0] : '';
      if (senderColorMode === 'background') {
        const bgStyle = getSenderBgStyle(mail.from?.address);
        return (
          <span className="text-[11px] truncate text-surface-200 px-1 py-px rounded-sm border-l-2"
            style={{ backgroundColor: bgStyle.backgroundColor, borderLeftColor: bgStyle.borderLeftColor }}>
            {displayName}
          </span>
        );
      }
      if (senderColorMode === 'none') {
        return <span className="text-[11px] truncate text-surface-400">{displayName}</span>;
      }
      // text mode (default)
      return (
        <span className="text-[11px] truncate font-medium" style={{ color: senderColor }}>
          {displayName}
        </span>
      );
    }
    case 'subject':
      return (
        <span className="flex items-center gap-1 min-w-0">
          <span className={`text-[11px] truncate ${mail.isRead ? 'text-surface-300' : 'text-surface-100 font-medium'}`}>
            {mail.subject || '(件名なし)'}
          </span>
          {(mail.threadCount ?? 0) > 1 && (
            <span className="text-[9px] text-accent-400 bg-accent-500/15 px-1 rounded flex-shrink-0">
              [{mail.threadCount}]
            </span>
          )}
          {mail.isFlagged && <span className="text-amber-400 text-[10px] flex-shrink-0">&#9733;</span>}
          {mail.folderName && (
            <span className="text-[8px] text-surface-500 bg-surface-700/60 px-1 py-px rounded flex-shrink-0 border border-surface-600/40">
              {mail.folderName}
            </span>
          )}
          {tags.map(tag => {
            const colors = TAG_COLOR_MAP[tag.color] ?? { bg: 'bg-surface-600', text: 'text-surface-300' };
            return (
              <span key={tag.id} className={`text-[8px] px-1 py-px rounded-sm ${colors.bg} ${colors.text} flex-shrink-0`}>
                {tag.label}
              </span>
            );
          })}
        </span>
      );
    case 'importance':
      return mail.importance > 1 ? (
        <span className="text-[10px] text-red-400 font-bold">!</span>
      ) : <span />;
    case 'attachment':
      return (mail.flags & 256) !== 0 ? (
        <span className="text-[10px] text-surface-500">&#128206;</span>
      ) : <span />;
    case 'date':
      return <span className="text-[10px] text-surface-500 whitespace-nowrap">{formatDate(mail.date)}</span>;
    case 'junkVerdict':
      return junk ? (
        <span className={`inline-block w-2 h-2 rounded-full ${junk.isJunk ? 'bg-orange-500' : 'bg-green-500'}`} />
      ) : <span />;
    default:
      return null;
  }
}

// ─── Thread sub-rows (eM Client style: indented, tree connector) ──
function ThreadSubRows({
  messages,
  loading,
  selectedMsgId,
  onSelectMsg,
}: {
  messages: ThreadMessage[];
  loading: boolean;
  selectedMsgId: number | null;
  onSelectMsg: (id: number) => void;
}) {
  if (loading) {
    return <div className="pl-6 py-1 text-[10px] text-surface-400 animate-pulse">読み込み中...</div>;
  }
  if (messages.length === 0) return null;

  return (
    <div>
      {messages.map((m, idx) => {
        const isActive = selectedMsgId === m.id;
        const isLast = idx === messages.length - 1;
        const senderName = m.isSentByMe ? '自分' : (m.from.split('<')[0].trim() || m.from);
        const senderColor = m.isSentByMe ? 'var(--accent-400, #60a5fa)' : getSenderColor(m.from);

        return (
          <div
            key={m.id}
            onClick={(e) => { e.stopPropagation(); onSelectMsg(m.id); }}
            className={`flex items-center h-[22px] cursor-pointer transition-colors border-b border-surface-700/20 ${
              isActive ? 'bg-accent-500/10' : 'hover:bg-surface-700/30'
            }`}
          >
            {/* Tree connector */}
            <div className="w-5 flex-shrink-0 flex items-center justify-center relative h-full">
              <div className={`absolute left-2.5 top-0 w-px bg-surface-600/60 ${isLast ? 'h-1/2' : 'h-full'}`} />
              <div className="absolute left-2.5 top-1/2 w-2 h-px bg-surface-600/60" />
            </div>
            {/* Sender */}
            <span className="text-[10px] truncate w-[100px] flex-shrink-0 px-0.5" style={{ color: senderColor }}>
              {senderName}
            </span>
            {/* Preview */}
            <span className="text-[10px] text-surface-300 truncate flex-1 min-w-0 px-0.5">
              {m.preview}
            </span>
            {/* Folder badge */}
            {m.folderName && (
              <span className="text-[8px] text-surface-400 bg-surface-700/50 px-1 rounded flex-shrink-0 mx-0.5">
                {m.folderName}
              </span>
            )}
            {/* Date */}
            <span className="text-[10px] text-surface-500 flex-shrink-0 px-1 w-[70px] text-right">
              {formatDate(m.date)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sort comparator ────────────────────────────────────
function sortMails(mails: MailItem[], sort: SortState | null, junkMap: Map<number, JunkClassification>): MailItem[] {
  if (!sort) return mails;
  const { column, direction } = sort;
  const dir = direction === 'asc' ? 1 : -1;

  return [...mails].sort((a, b) => {
    switch (column) {
      case 'from': {
        const fa = (a.from?.displayName || a.from?.address || '').toLowerCase();
        const fb = (b.from?.displayName || b.from?.address || '').toLowerCase();
        return fa.localeCompare(fb) * dir;
      }
      case 'subject':
        return a.subject.toLowerCase().localeCompare(b.subject.toLowerCase()) * dir;
      case 'date':
        return (new Date(a.date).getTime() - new Date(b.date).getTime()) * dir;
      case 'importance':
        return (a.importance - b.importance) * dir;
      case 'junkVerdict': {
        const ja = junkMap.get(a.id)?.isJunk ? 1 : 0;
        const jb = junkMap.get(b.id)?.isJunk ? 1 : 0;
        return (ja - jb) * dir;
      }
      default:
        return 0;
    }
  });
}

// ─── Hover preview tooltip ───────────────────────────────
function HoverPreview({
  mail,
  x,
  y,
}: {
  mail: MailItem;
  x: number;
  y: number;
}) {
  // Position below cursor, clamp to viewport
  const top = Math.min(y + 16, window.innerHeight - 140);
  const left = Math.min(x + 8, window.innerWidth - 340);

  return (
    <div
      className="fixed z-50 w-80 max-h-32 overflow-hidden bg-surface-800 border border-surface-600 rounded-md shadow-xl p-2 pointer-events-none"
      style={{ top, left }}
    >
      <p className="text-[10px] font-medium text-surface-200 mb-0.5 truncate">
        {mail.subject || '(件名なし)'}
      </p>
      <p className="text-[10px] text-surface-400 line-clamp-5 whitespace-pre-wrap leading-relaxed">
        {mail.preview || '(本文なし)'}
      </p>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
export interface MailTableProps {
  mails: MailItem[];
  columns: MailColumnId[];
  selectedMail: MailItem | null;
  expandedThreadId: number | null;
  threadMessages: ThreadMessage[];
  threadLoading: boolean;
  selectedThreadMsgId: number | null;
  checkedIds: Set<number>;
  junkMap: Map<number, JunkClassification>;
  noteMap?: Map<string, MailNote>;
  senderColorMode?: SenderColorMode;
  customTags?: MailTag[];
  onSelectMail: (mail: MailItem) => void;
  onToggleThread: (mailId: number) => void;
  onSelectThreadMsg: (id: number) => void;
  onCheck: (id: number) => void;
  onCheckAll: (ids: number[]) => void;
  onColumnsChange: (cols: MailColumnId[]) => void;
}

export default function MailTable({
  mails,
  columns,
  selectedMail,
  expandedThreadId,
  threadMessages,
  threadLoading,
  selectedThreadMsgId,
  checkedIds,
  junkMap,
  noteMap,
  senderColorMode = 'text',
  customTags = [],
  onSelectMail,
  onToggleThread,
  onSelectThreadMsg,
  onCheck,
  onCheckAll,
  onColumnsChange,
}: MailTableProps) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [showColConfig, setShowColConfig] = useState(false);
  const [hover, setHover] = useState<{ mail: MailItem; x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const colDefs = useMemo(() => {
    const map = new Map(MAIL_COLUMN_OPTIONS.map((c) => [c.id, c]));
    return columns.map((id) => map.get(id)!).filter(Boolean);
  }, [columns]);

  const { getWidth, onResizeDown } = useColWidths(colDefs);

  const handleSort = useCallback((col: MailColumnId) => {
    setSort((prev) => {
      if (prev?.column === col) {
        return { column: col, direction: (prev.direction === 'asc' ? 'desc' : 'asc') as SortDirection };
      }
      return { column: col, direction: col === 'date' ? 'desc' : 'asc' };
    });
  }, []);

  const sortedMails = useMemo(() => sortMails(mails, sort, junkMap), [mails, sort, junkMap]);

  const handleRowClick = useCallback((mail: MailItem) => {
    setHover(null);
    onSelectMail(mail);
    if ((mail.threadCount ?? 0) > 1) {
      onToggleThread(mail.id);
    }
  }, [onSelectMail, onToggleThread]);

  const handleRowEnter = useCallback((mail: MailItem, e: React.MouseEvent) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      setHover({ mail, x: e.clientX, y: e.clientY });
    }, 400);
  }, []);

  const handleRowMove = useCallback((mail: MailItem, e: React.MouseEvent) => {
    if (hover?.mail.id === mail.id) {
      setHover({ mail, x: e.clientX, y: e.clientY });
    }
  }, [hover]);

  const handleRowLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHover(null);
  }, []);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Column header */}
      <div className="flex items-center px-2 py-0.5 border-b border-surface-600 bg-surface-850 text-[10px] text-surface-500 uppercase tracking-wider select-none relative flex-shrink-0">
        {colDefs.map((def, i) => (
          <div key={def.id} className="flex items-center" style={colStyle(def, getWidth(def.id))}>
            {def.id === 'checkbox' ? (
              <div className="flex items-center justify-center flex-1" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={sortedMails.length > 0 && sortedMails.every((m) => checkedIds.has(m.id))}
                  onChange={() => {
                    const allChecked = sortedMails.length > 0 && sortedMails.every((m) => checkedIds.has(m.id));
                    onCheckAll(allChecked ? [] : sortedMails.map((m) => m.id));
                  }}
                  className="w-3 h-3 rounded-sm border-surface-600 bg-surface-700 text-accent-500 focus:ring-0"
                />
              </div>
            ) : (
              <SortableHeader def={def} sort={sort} onSort={handleSort} />
            )}
            {/* Resize handle between columns (not on the last or flex columns) */}
            {i < colDefs.length - 1 && !def.width.includes(' ') && (
              <div
                className="w-[3px] h-full cursor-col-resize flex-shrink-0 hover:bg-accent-500/40 transition-colors self-stretch"
                onMouseDown={(e) => onResizeDown(def.id, e)}
              />
            )}
          </div>
        ))}
        <button
          onClick={() => setShowColConfig((v) => !v)}
          className="ml-auto flex-shrink-0 text-surface-500 hover:text-surface-200"
          title="カラム設定"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        </button>
        {showColConfig && (
          <MailColumnConfigPopover
            columns={columns}
            onChange={onColumnsChange}
            onClose={() => setShowColConfig(false)}
          />
        )}
      </div>

      {/* Mail rows */}
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {sortedMails.map((mail) => {
          const isSelected = selectedMail?.id === mail.id;
          const isExpanded = expandedThreadId === mail.id;
          const junk = junkMap.get(mail.id) ?? null;
          const senderColor = getSenderColor(mail.from?.address);
          const noteKey = mail.conversationId ? `conv-${mail.conversationId}` : `mail-${mail.id}`;
          const note = noteMap?.get(noteKey);
          const tags = resolveTagsForNote(note, customTags);

          return (
            <div key={`${mail.accountEmail}-${mail.id}`}>
              <div
                onClick={() => handleRowClick(mail)}
                onDoubleClick={() => {
                  openInEmClient({
                    subject: mail.subject,
                    fromAddress: mail.from?.address,
                  });
                }}
                onMouseEnter={(e) => handleRowEnter(mail, e)}
                onMouseMove={(e) => handleRowMove(mail, e)}
                onMouseLeave={handleRowLeave}
                className={`flex items-center gap-px px-2 border-b border-surface-700/40 cursor-pointer transition-colors h-[22px] border-l-[3px] ${
                  isSelected ? 'bg-accent-500/8' : 'hover:bg-surface-800/60'
                }`}
                style={{
                  borderLeftColor: isSelected
                    ? 'var(--accent-400, #60a5fa)'
                    : senderColorMode === 'none' ? 'transparent' : senderColor + '80',
                }}
              >
                {colDefs.map((def) => (
                  <div key={def.id} style={colStyle(def, getWidth(def.id))} className="truncate px-0.5 flex items-center">
                    <MailCellContent
                      colId={def.id}
                      mail={mail}
                      isChecked={checkedIds.has(mail.id)}
                      onCheck={onCheck}
                      junk={junk}
                      tags={tags}
                      senderColorMode={senderColorMode}
                    />
                  </div>
                ))}
                {isExpanded && <span className="text-[9px] text-accent-400 flex-shrink-0 ml-auto">&#9660;</span>}
              </div>
              {/* Thread sub-rows */}
              {isExpanded && (
                <ThreadSubRows
                  messages={threadMessages}
                  loading={threadLoading}
                  selectedMsgId={selectedThreadMsgId}
                  onSelectMsg={onSelectThreadMsg}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Hover preview tooltip */}
      {hover && !selectedMail && (
        <HoverPreview mail={hover.mail} x={hover.x} y={hover.y} />
      )}
    </div>
  );
}
