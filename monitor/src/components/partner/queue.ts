import type { ButlerCase, OutboxItem, FollowUp, ButlerGroup, JournalEntry } from '../../types';
import type { QueueGroups } from './partnerUi';

// =====================================================================
// 「今日」のキュー: 案件・送信予定・返事待ち・片付け・日誌を 1 本のリストに並べる
// =====================================================================

export type Section = 'decide' | 'send' | 'act' | 'outbox' | 'followup' | 'fyi' | 'later' | 'tidied' | 'journal';
export type CaseVariant = 'decision' | 'send' | 'action' | 'fyi' | 'later';

export type QueueItem =
  | { kind: 'case'; id: string; section: Section; c: ButlerCase; variant: CaseVariant }
  | { kind: 'outbox'; id: string; section: 'outbox'; o: OutboxItem }
  | { kind: 'followup'; id: string; section: 'followup'; f: FollowUp }
  | { kind: 'group'; id: string; section: 'tidied'; g: ButlerGroup }
  | { kind: 'journal'; id: string; section: 'journal'; j: JournalEntry };

export interface QueueSection {
  section: Section;
  label: string;
  hint: string;
  count: number;
  collapsible: boolean;
  items: QueueItem[];
}

export const SECTION_META: Record<Section, { label: string; hint: string; collapsible: boolean }> = {
  decide: { label: '決める', hint: '答えると下書きができます', collapsible: false },
  send: { label: '送る', hint: '下書きは先生の文体で', collapsible: false },
  act: { label: 'やる', hint: '返信以外の作業', collapsible: false },
  outbox: { label: '送信予定', hint: '猶予の間は取り消せます', collapsible: false },
  followup: { label: '返事待ち', hint: '送ったきり返事が無いもの', collapsible: false },
  fyi: { label: '参考', hint: '読むだけでよいもの', collapsible: true },
  later: { label: '後で', hint: '', collapsible: true },
  tidied: { label: '片付けた', hint: '一斉配信・迷惑メール', collapsible: true },
  journal: { label: '日誌', hint: 'やったことの記録', collapsible: true },
};

export const SECTION_ORDER: Section[] = ['decide', 'send', 'act', 'outbox', 'followup', 'fyi', 'later', 'tidied', 'journal'];

export function buildQueue(g: QueueGroups, open: Record<Section, boolean>): QueueSection[] {
  const caseItems = (cases: ButlerCase[], section: Section, variant: CaseVariant): QueueItem[] =>
    cases.map((c) => ({ kind: 'case', id: `case:${c.id}`, section, c, variant }));
  const all: Record<Section, QueueItem[]> = {
    decide: caseItems(g.decisions, 'decide', 'decision'),
    send: caseItems(g.sendables, 'send', 'send'),
    act: caseItems(g.actions, 'act', 'action'),
    outbox: g.outboxActive.map((o) => ({ kind: 'outbox', id: `outbox:${o.id}`, section: 'outbox', o })),
    followup: g.followActive.map((f) => ({ kind: 'followup', id: `followup:${f.id}`, section: 'followup', f })),
    fyi: caseItems(g.fyi, 'fyi', 'fyi'),
    later: caseItems(g.later, 'later', 'later'),
    tidied: [...g.tidied, ...g.spamPending, ...g.noise].map((gr) => ({ kind: 'group', id: `group:${gr.id}`, section: 'tidied', g: gr })),
    journal: g.journal.slice(0, 60).map((j, i) => ({ kind: 'journal', id: `journal:${j.at}:${i}`, section: 'journal', j })),
  };
  return SECTION_ORDER.map((section) => {
    const meta = SECTION_META[section];
    const items = all[section];
    const count = section === 'tidied' ? g.tidiedCount : items.length;
    return { section, label: meta.label, hint: meta.hint, count, collapsible: meta.collapsible, items: meta.collapsible && !open[section] ? [] : items };
  }).filter((s) => s.count > 0 || !s.collapsible);
}

export function flattenQueue(sections: QueueSection[]): QueueItem[] {
  return sections.flatMap((s) => s.items);
}
