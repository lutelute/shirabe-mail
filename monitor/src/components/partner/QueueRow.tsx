import type { OutboxItem } from '../../types';
import type { QueueItem } from './queue';
import { Chip, DeadlineChip, PRIORITY_META, TIER_META, fmtDateTime, fmtRemaining, nameOf, useNow, Spinner } from './partnerUi';

// =====================================================================
// キューの 1 行。左端に優先度バー、差出人(太字)・件名・要件・チップ
// =====================================================================

interface Props {
  item: QueueItem;
  selected: boolean;
  onSelect: () => void;
}

function Row({ bar, selected, onSelect, children, right }: { bar: string; selected: boolean; onSelect: () => void; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <button
      onClick={onSelect}
      data-queue-row
      aria-selected={selected}
      className={`w-full text-left flex gap-2.5 px-3 py-2.5 border-b border-hairline/70 transition-colors ${selected ? 'bg-primary-soft' : 'hover:bg-card-2'}`}
    >
      <span className={`prio-bar ${bar}`} />
      <span className="flex-1 min-w-0">{children}</span>
      {right && <span className="flex-shrink-0 self-start">{right}</span>}
    </button>
  );
}

export default function QueueRow({ item, selected, onSelect }: Props) {
  if (item.kind === 'case') {
    const { c } = item;
    const pm = PRIORITY_META[c.priority] ?? PRIORITY_META.P3;
    const tm = TIER_META[c.senderTier] ?? TIER_META.unknown;
    return (
      <Row bar={item.variant === 'fyi' || item.variant === 'later' ? 'bg-hairline' : pm.bar} selected={selected} onSelect={onSelect}
        right={<span className="text-[10.5px] text-ink-3 tnum">{fmtDateTime(c.receivedAt)}</span>}>
        <span className="flex items-baseline gap-1.5 min-w-0">
          <span className="font-semibold text-ink truncate">{c.fromName || c.fromAddress}</span>
          <Chip label={tm.label} cls={tm.cls} />
        </span>
        <span className="block text-[12.5px] text-ink-2 truncate">{c.subject || '(件名なし)'}</span>
        {c.ask && <span className="text-[12.5px] text-ink mt-0.5 line-clamp-1">{c.ask}</span>}
        <span className="flex items-center gap-1.5 mt-1 flex-wrap">
          <Chip label={pm.label} cls={pm.cls} />
          <DeadlineChip deadline={c.deadline} compact />
          {c.decision && !c.decision.answer && <Chip label="問い" cls="bg-warn-soft text-warn border-warn/30" />}
          {c.event && c.calendarStatus === 'missing' && <Chip label="未登録" cls="bg-danger-soft text-danger border-danger/30" title="予定がカレンダーに入っていません" />}
          {c.handoff && <Chip label="指示書" cls="bg-card-2 text-ink-3 border-hairline" title="作業指示書あり" />}
          {c.draft && item.variant === 'send' && <Chip label={c.draftEdited ? '下書き(手直し)' : '下書きあり'} cls="bg-ok-soft text-ok border-ok/30" />}
          {c.addressedToMe === 'cc' && <Chip label="Cc" cls="bg-card-2 text-ink-3 border-hairline" />}
          {c.status === 'scheduled' && <Chip label="送信予定" cls="bg-primary-soft text-primary border-primary/30" />}
        </span>
      </Row>
    );
  }
  if (item.kind === 'outbox') {
    const { o } = item;
    return <OutboxRow o={o} selected={selected} onSelect={onSelect} />;
  }
  if (item.kind === 'followup') {
    const { f } = item;
    const bar = f.daysWaiting >= 10 ? 'bg-danger' : f.daysWaiting >= 7 ? 'bg-warn' : 'bg-hairline-2';
    return (
      <Row bar={bar} selected={selected} onSelect={onSelect} right={<span className="text-[10.5px] text-ink-3 tnum">{f.daysWaiting}日</span>}>
        <span className="font-semibold text-ink truncate block">{nameOf(f.to) || f.toAddress}</span>
        <span className="block text-[12.5px] text-ink-2 truncate">{f.subject || '(件名なし)'}</span>
        {f.ask && <span className="text-[12.5px] text-ink mt-0.5 line-clamp-1">{f.ask}</span>}
        <span className="flex items-center gap-1.5 mt-1">
          {f.status === 'nudged' && <Chip label="催促済み" cls="bg-card-2 text-ink-3 border-hairline" />}
          {f.nudgeDraft && f.status !== 'nudged' && <Chip label="催促文あり" cls="bg-ok-soft text-ok border-ok/30" />}
        </span>
      </Row>
    );
  }
  if (item.kind === 'group') {
    const { g } = item;
    const bar = g.kind === 'spam_delete' ? 'bg-danger' : 'bg-hairline';
    return (
      <Row bar={bar} selected={selected} onSelect={onSelect} right={<span className="text-[10.5px] text-ink-3 tnum">{g.items.length}通</span>}>
        <span className="font-semibold text-ink truncate block">{g.label}</span>
        <span className="block text-[12.5px] text-ink-2 truncate">{g.kind === 'spam_delete' ? '承認するとゴミ箱へ' : g.kind === 'tidied' ? (g.undone ? '受信箱へ戻しました' : '既読にしてアーカイブ') : '受信箱に残したまま'}</span>
      </Row>
    );
  }
  const { j } = item;
  return (
    <Row bar={j.kind === 'error' ? 'bg-danger' : 'bg-hairline'} selected={selected} onSelect={onSelect} right={<span className="text-[10.5px] text-ink-3 tnum">{fmtDateTime(j.at)}</span>}>
      <span className={`text-[12.5px] ${j.kind === 'error' ? 'text-danger' : 'text-ink-2'} line-clamp-2`}>{j.text}</span>
    </Row>
  );
}

function OutboxRow({ o, selected, onSelect }: { o: OutboxItem; selected: boolean; onSelect: () => void }) {
  const now = useNow(o.status === 'scheduled');
  const remain = new Date(o.sendAt).getTime() - now;
  return (
    <Row bar={o.status === 'failed' ? 'bg-danger' : 'bg-primary'} selected={selected} onSelect={onSelect}
      right={<span className="text-[10.5px] tnum text-ink-3">{o.status === 'scheduled' ? `あと ${fmtRemaining(remain)}` : o.status === 'sending' ? <Spinner /> : '失敗'}</span>}>
      <span className="font-semibold text-ink truncate block">{o.to.map(nameOf).join(', ')}</span>
      <span className="block text-[12.5px] text-ink-2 truncate">{o.subject}</span>
      <span className="flex items-center gap-1.5 mt-1">
        {o.auto && <Chip label="相棒が用意" cls="bg-card-2 text-ink-3 border-hairline" />}
        {o.kind === 'nudge' && <Chip label="催促" cls="bg-card-2 text-ink-3 border-hairline" />}
        {o.status === 'failed' && <Chip label={o.error ?? '失敗'} cls="bg-danger-soft text-danger border-danger/30" />}
      </span>
    </Row>
  );
}
