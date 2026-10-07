import type { ReactNode } from 'react';
import type { OutboxItem } from '../../types';
import type { QueueItem } from './queue';
import { Chip, DeadlineChip, SECTION_TONE_META, fmtDateTime, fmtRemaining, nameOf, useNow, Spinner } from './partnerUi';
import { SECTION_META } from './queue';

// =====================================================================
// キューの 1 行(3 段): 差出人 + 時刻 / 件名 / 要件 + チップ(最大 2)
//   左端のバー: 色 = セクション(見出し帯と同じ)、太さ = 優先度(P1 太 / P2 中 / P3 細)。
//   関係(常連など)は詳細にだけ出す。
// =====================================================================

interface Props {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
}

interface RowProps {
  bar: string;
  barWidth?: 'w-p1' | 'w-p2' | 'w-p3';
  selected: boolean;
  onSelect: () => void;
  l1: ReactNode;
  l1Class?: string;
  l1Right?: ReactNode;
  l2?: ReactNode;
  l3?: ReactNode;
  l3Right?: ReactNode;
}

function Row({ bar, barWidth = 'w-p2', selected, onSelect, l1, l1Class, l1Right, l2, l3, l3Right }: RowProps) {
  return (
    <button
      onClick={onSelect}
      data-queue-row
      aria-selected={selected}
      className={`w-full text-left flex gap-2.5 px-3 py-2 border-b border-hairline/70 transition-colors ${selected ? 'bg-primary-soft' : 'hover:bg-card-2'}`}
    >
      <span className={`prio-bar ${bar} ${barWidth} ${selected ? 'is-selected' : ''}`} />
      <span className="flex-1 min-w-0 leading-[18px]">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className={`flex-1 min-w-0 truncate ${l1Class ?? 'text-[13px] font-semibold text-ink'}`}>{l1}</span>
          {l1Right && <span className="flex-shrink-0 text-[10.5px] text-ink-3 tnum">{l1Right}</span>}
        </span>
        {l2 && <span className="block text-[12.5px] text-ink-2 truncate">{l2}</span>}
        {(l3 || l3Right) && (
          <span className="flex items-center gap-2 min-w-0 mt-px">
            <span className="flex-1 min-w-0 text-[12.5px] text-ink truncate">{l3 ?? ''}</span>
            {l3Right && <span className="flex-shrink-0 inline-flex items-center gap-1">{l3Right}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

/** 行に出すチップは最大 2 つ。期限 → 未登録 → 問い → 下書き の順 */
function caseChips(item: Extract<QueueItem, { kind: 'case' }>): ReactNode[] {
  const { c, variant } = item;
  const chips: ReactNode[] = [];
  if (c.deadline) chips.push(<DeadlineChip key="dl" deadline={c.deadline} compact />);
  if (c.event && c.calendarStatus === 'missing') chips.push(<Chip key="cal" label="未登録" cls="bg-danger-soft text-danger border-danger/30" title="予定がカレンダーに入っていません" />);
  if (c.decision && !c.decision.answer) chips.push(<Chip key="q" label="問い" cls="bg-warn-soft text-warn border-warn/30" />);
  if (c.status === 'scheduled') chips.push(<Chip key="sch" label="送信予定" cls="bg-primary-soft text-primary border-primary/30" />);
  else if (c.draft && variant === 'send') chips.push(<Chip key="draft" label={c.draftEdited ? '手直し済み' : '下書きあり'} cls="bg-ok-soft text-ok border-ok/30" />);
  if (c.handoff) chips.push(<Chip key="h" label="指示書" cls="bg-card-2 text-ink-3 border-hairline" title="作業指示書あり" />);
  return chips.slice(0, 2);
}

const widthOf = (priority: string): RowProps['barWidth'] => (priority === 'P1' ? 'w-p1' : priority === 'P2' ? 'w-p2' : 'w-p3');

export default function QueueRow({ item, selected, onSelect }: Props) {
  const tone = SECTION_TONE_META[SECTION_META[item.section].tone];
  if (item.kind === 'case') {
    const { c } = item;
    const chips = caseChips(item);
    return (
      <Row
        bar={tone.bar}
        barWidth={widthOf(c.priority)}
        selected={selected}
        onSelect={onSelect}
        l1={c.fromName || c.fromAddress}
        l1Right={fmtDateTime(c.receivedAt)}
        l2={c.subject || '(件名なし)'}
        l3={c.ask || (chips.length > 0 ? '' : undefined)}
        l3Right={chips.length > 0 ? chips : undefined}
      />
    );
  }
  if (item.kind === 'outbox') return <OutboxRow o={item.o} selected={selected} onSelect={onSelect} bar={tone.bar} />;
  if (item.kind === 'followup') {
    const { f } = item;
    const bar = tone.bar;
    const width: RowProps['barWidth'] = f.daysWaiting >= 10 ? 'w-p1' : f.daysWaiting >= 7 ? 'w-p2' : 'w-p3';
    const chip = f.status === 'nudged'
      ? <Chip label="催促済み" cls="bg-card-2 text-ink-3 border-hairline" />
      : f.nudgeDraft ? <Chip label="催促文あり" cls="bg-ok-soft text-ok border-ok/30" /> : undefined;
    return (
      <Row bar={bar} barWidth={width} selected={selected} onSelect={onSelect}
        l1={nameOf(f.to) || f.toAddress} l1Right={`${f.daysWaiting}日`}
        l2={f.subject || '(件名なし)'}
        l3={f.ask || (chip ? '' : undefined)} l3Right={chip} />
    );
  }
  if (item.kind === 'group') {
    const { g } = item;
    const bar = g.kind === 'spam_delete' ? 'bg-danger' : tone.bar;
    return (
      <Row bar={bar} barWidth="w-p3" selected={selected} onSelect={onSelect}
        l1={g.label} l1Right={`${g.items.length}通`}
        l2={g.kind === 'spam_delete' ? '承認するとゴミ箱へ' : g.kind === 'tidied' ? (g.undone ? '受信箱へ戻しました' : '既読にしてアーカイブ') : '受信箱に残したまま'} />
    );
  }
  const { j } = item;
  return (
    <Row bar={j.kind === 'error' ? 'bg-danger' : tone.bar} barWidth="w-p3" selected={selected} onSelect={onSelect}
      l1={j.text} l1Class={`text-[12.5px] ${j.kind === 'error' ? 'text-danger' : 'text-ink-2'}`} l1Right={fmtDateTime(j.at)} />
  );
}

function OutboxRow({ o, selected, onSelect, bar }: { o: OutboxItem; selected: boolean; onSelect: () => void; bar: string }) {
  const now = useNow(o.status === 'scheduled');
  const remain = new Date(o.sendAt).getTime() - now;
  const chips: ReactNode[] = [];
  if (o.status === 'failed') chips.push(<Chip key="f" label="失敗" cls="bg-danger-soft text-danger border-danger/30" title={o.error} />);
  if (o.kind === 'nudge') chips.push(<Chip key="n" label="催促" cls="bg-card-2 text-ink-3 border-hairline" />);
  if (o.auto) chips.push(<Chip key="a" label="相棒が用意" cls="bg-card-2 text-ink-3 border-hairline" />);
  return (
    <Row bar={o.status === 'failed' ? 'bg-danger' : bar} barWidth={o.status === 'failed' ? 'w-p1' : 'w-p2'} selected={selected} onSelect={onSelect}
      l1={o.to.map(nameOf).join(', ')}
      l1Right={o.status === 'scheduled' ? `あと ${fmtRemaining(remain)}` : o.status === 'sending' ? <Spinner /> : '失敗'}
      l2={o.subject}
      l3={o.body.split('\n').find((l) => l.trim()) ?? ''}
      l3Right={chips.length > 0 ? chips.slice(0, 2) : undefined} />
  );
}
