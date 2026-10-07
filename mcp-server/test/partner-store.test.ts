import { describe, it, expect } from 'vitest';
import { summarizeToday, enqueueOutbox, cancelOutbox, replySubject } from '../src/partner/store.js';
import type { NightlyDigest, ButlerCase, OutboxStore, FollowUp } from '../src/partner/store.js';

const mk = (p: Partial<ButlerCase>): ButlerCase => ({
  id: p.id ?? 'a::conv-1', accountEmail: 'a', mailId: 1, subject: 's', from: 'x', fromAddress: 'x@y', fromName: 'X', receivedAt: '', senderTier: 'vip',
  category: 'reply', priority: 'P2', ask: 'ask', summary: 'sum', deadline: null, suggestedAction: '', reason: '', needsDraft: true, status: 'open', runAt: '', ...p,
});

describe('summarizeToday', () => {
  it('splits open cases into decisions / sendable / actions / fyi and counts outbox + followups', () => {
    const digest: NightlyDigest = { runAt: 't', brief: 'b', errors: [], cases: [
      mk({ id: 'd', decision: { question: 'q', options: ['a', 'b'] } }),
      mk({ id: 's', draft: 'hi', priority: 'P1' }),
      mk({ id: 'act', category: 'action' }),
      mk({ id: 'f', category: 'fyi' }),
      mk({ id: 'done', status: 'done' }),
      mk({ id: 'later', status: 'later' }),
    ] };
    const outbox: OutboxStore = { version: 1, items: [{ id: 'o1', kind: 'reply', accountEmail: 'a', to: [], cc: [], subject: '', body: '', label: 'L', sendAt: 't', status: 'scheduled', createdAt: 't' }] };
    const fus: FollowUp[] = [{ id: 'f1', accountEmail: 'a', conversationId: 'c', mailId: 1, subject: 's', to: 'T', toAddress: 't@x', sentAt: '', daysWaiting: 5, ask: '', summary: '', status: 'open', updatedAt: '' }, { id: 'f2', accountEmail: 'a', conversationId: 'c2', mailId: 2, subject: 's', to: 'T', toAddress: 't@x', sentAt: '', daysWaiting: 5, ask: '', summary: '', status: 'closed', updatedAt: '' }];
    const t = summarizeToday(digest, outbox, fus);
    expect(t.counts).toEqual({ decisions: 1, sendable: 1, actions: 1, fyi: 1, outbox: 1, followUps: 1, later: 1 });
    expect(t.sendable[0].id).toBe('s');
    expect(t.sendable[0].hasDraft).toBe(true);
    expect(t.decisions[0].options).toEqual(['a', 'b']);
  });
});

describe('outbox', () => {
  it('enqueue sets sendAt by delay and cancel only while scheduled', () => {
    const now = new Date('2026-10-07T00:00:00Z');
    const r = enqueueOutbox({ version: 1, items: [] }, { kind: 'reply', accountEmail: 'a', to: ['b'], cc: [], subject: 'Re: s', body: 'x', label: 'L' }, 5, now);
    expect(r.item.sendAt).toBe('2026-10-07T00:05:00.000Z');
    expect(r.item.status).toBe('scheduled');
    const c = cancelOutbox(r.store, r.item.id);
    expect(c.item?.status).toBe('cancelled');
    expect(cancelOutbox(c.store, r.item.id).error).toBeTruthy();
  });
  it('replySubject', () => {
    expect(replySubject('件名')).toBe('Re: 件名');
    expect(replySubject('Re: 件名')).toBe('Re: 件名');
  });
});
