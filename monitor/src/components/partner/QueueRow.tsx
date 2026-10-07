import type { ReactNode } from 'react';
import type { OutboxItem } from '../../types';
import type { QueueItem } from './queue';
import { Chip, DeadlineChip, PRIORITY_META, fmtDateTime, fmtRemaining, nameOf, useNow, Spinner } from './partnerUi';

// =====================================================================
// キューの 1 行(3 段): 差出人 + 時刻 / 件名 / 要件 + チップ(最大 2)
//   優先度は左端のバーで表す(チップにはしない)。関係(常連など)は詳細にだけ出す。
// =====================================================================

interface Props {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
}

interface RowProps {
  bar: string;
  selected: boolean;
  onSelect: () => void;
  l1: ReactNode;
  l1Class?: string;
  l1Right?: ReactNode;
  l2?: ReactNode;
  l3?: ReactNode;
  l3Right?: ReactNode;
}

function Row({ bar, selected, onSelect, l1, l1Class, l1Right, l2, l3, l3Right }: RowProps) {
  return (
    <button
      onClick={onSelect}
      data-queue-row
      aria-selected={selected}
      className={`w-full text-left flex gap-2.5 px-3 py-2 border-b border-hairline/70 transition-colors ${selected ? 'bg-primary-soft' : 'hover:bg-card-2'}`}
    >
      <span className={`prio-bar ${bar} ${selected ? 'is-selected' : ''}`} />
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

export default function QueueRow({ item, selected, onSelect }: Props) {
  if (item.kind === 'case') {
    const { c } = item;
    const pm = PRIORITY_META[c.priority] ?? PRIORITY_META.P3;
    const chips = caseChips(item);
    return (
      <Row
        bar={item.variant === 'fyi' || item.variant === 'later' ? 'bg-hairline' : pm.bar}
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
  if (item.kind === 'outbox') return <OutboxRow o={item.o} selected={selected} onSelect={onSelect} />;
  if (item.kind === 'followup') {
    const { f } = item;
    const bar = f.daysWaiting >= 10 ? 'bg-danger' : f.daysWaiting >= 7 ? 'bg-warn' : 'bg-hairline-2';
    const chip = f.status === 'nudged'
      ? <Chip label="催促済み" cls="bg-card-2 text-ink-3 border-hairline" />
      : f.nudgeDraft ? <Chip label="催促文あり" cls="bg-ok-soft text-ok border-ok/30" /> : undefined;
    return (
      <Row bar={bar} selected={selected} onSelect={onSelect}
        l1={nameOf(f.to) || f.toAddress} l1Right={`${f.daysWaiting}日`}
        l2={f.subject || '(件名なし)'}
        l3={f.ask || (chip ? '' : undefined)} l3Right={chip} />
    );
  }
  if (item.kind === 'group') {
    const { g } = item;
    const bar = g.kind === 'spam_delete' ? 'bg-danger' : 'bg-hairline';
    return (
      <Row bar={bar} selected={selected} onSelect={onSelect}
        l1={g.label} l1Right={`${g.items.length}通`}
        l2={g.kind === 'spam_delete' ? '承認するとゴミ箱へ' : g.kind === 'tidied' ? (g.undone ? '受信箱へ戻しました' : '既読にしてアーカイブ') : '受信箱に残したまま'} />
    );
  }
  const { j } = item;
  return (
    <Row bar={j.kind === 'error' ? 'bg-danger' : 'bg-hairline'} selected={selected} onSelect={onSelect}
      l1={j.text} l1Class={`text-[12.5px] ${j.kind === 'error' ? 'text-danger' : 'text-ink-2'}`} l1Right={fmtDateTime(j.at)} />
  );
}

function OutboxRow({ o, selected, onSelect }: { o: OutboxItem; selected: boolean; onSelect: () => void }) {
  const now = useNow(o.status === 'scheduled');
  const remain = new Date(o.sendAt).getTime() - now;
  const chips: ReactNode[] = [];
  if (o.status === 'failed') chips.push(<Chip key="f" label="失敗" cls="bg-danger-soft text-danger border-danger/30" title={o.error} />);
  if (o.kind === 'nudge') chips.push(<Chip key="n" label="催促" cls="bg-card-2 text-ink-3 border-hairline" />);
  if (o.auto) chips.push(<Chip key="a" label="相棒が用意" cls="bg-card-2 text-ink-3 border-hairline" />);
  return (
    <Row bar={o.status === 'failed' ? 'bg-danger' : 'bg-primary'} selected={selected} onSelect={onSelect}
      l1={o.to.map(nameOf).join(', ')}
      l1Right={o.status === 'scheduled' ? `あと ${fmtRemaining(remain)}` : o.status === 'sending' ? <Spinner /> : '失敗'}
      l2={o.subject}
      l3={o.body.split('\n').find((l) => l.trim()) ?? ''}
      l3Right={chips.length > 0 ? chips.slice(0, 2) : undefined} />
  );
}
