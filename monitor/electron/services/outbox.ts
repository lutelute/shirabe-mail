// === 遅延送信キュー(純関数) ===
//
// 「送る」を押しても即送らない。sendAt までは取り消せる。
// 不可逆な送信を「ほぼ可逆」にするための安全装置。処理(実送信)は partner-ipc が行う。

import { randomUUID } from 'crypto';
import type { OutboxItem } from '../../src/types/index';

export interface OutboxStore {
  version: 1;
  items: OutboxItem[];
}

export const EMPTY_OUTBOX: OutboxStore = { version: 1, items: [] };

export function normalizeOutbox(raw: unknown): OutboxStore {
  const r = raw as Partial<OutboxStore> | null;
  if (!r || !Array.isArray(r.items)) return { version: 1, items: [] };
  return { version: 1, items: r.items.filter((i) => i && typeof i.id === 'string') };
}

export type NewOutboxItem = Omit<OutboxItem, 'id' | 'status' | 'createdAt' | 'sendAt'> & { delayMinutes: number };

export function enqueue(store: OutboxStore, input: NewOutboxItem, now = new Date()): { store: OutboxStore; item: OutboxItem } {
  const { delayMinutes, ...rest } = input;
  const sendAt = new Date(now.getTime() + Math.max(0, delayMinutes) * 60_000).toISOString();
  const item: OutboxItem = { ...rest, id: `ob-${randomUUID()}`, status: 'scheduled', createdAt: now.toISOString(), sendAt };
  return { store: { ...store, items: [...store.items, item] }, item };
}

export function cancel(store: OutboxStore, id: string): { store: OutboxStore; item: OutboxItem | null; error?: string } {
  const item = store.items.find((i) => i.id === id);
  if (!item) return { store, item: null, error: '送信予定が見つかりません' };
  if (item.status !== 'scheduled' && item.status !== 'failed') return { store, item, error: item.status === 'sent' ? '既に送信済みです' : '送信中のため取り消せません' };
  const next = { ...item, status: 'cancelled' as const };
  return { store: { ...store, items: store.items.map((i) => (i.id === id ? next : i)) }, item: next };
}

/** 送信時刻を今にする(「今すぐ送る」。failed の再試行にも使う) */
export function expedite(store: OutboxStore, id: string, now = new Date()): { store: OutboxStore; item: OutboxItem | null; error?: string } {
  const item = store.items.find((i) => i.id === id);
  if (!item) return { store, item: null, error: '送信予定が見つかりません' };
  if (item.status !== 'scheduled' && item.status !== 'failed') return { store, item, error: '送信できる状態ではありません' };
  const next: OutboxItem = { ...item, status: 'scheduled', sendAt: now.toISOString(), error: undefined };
  return { store: { ...store, items: store.items.map((i) => (i.id === id ? next : i)) }, item: next };
}

export function update(store: OutboxStore, id: string, patch: Partial<OutboxItem>): OutboxStore {
  return { ...store, items: store.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) };
}

export function dueItems(store: OutboxStore, now = new Date()): OutboxItem[] {
  const t = now.getTime();
  return store.items.filter((i) => i.status === 'scheduled' && new Date(i.sendAt).getTime() <= t);
}

/** 終わったものは14日で消す。予定・失敗は残す */
export function prune(store: OutboxStore, now = new Date(), keepDays = 14): OutboxStore {
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return {
    ...store,
    items: store.items.filter((i) => {
      if (i.status === 'scheduled' || i.status === 'sending' || i.status === 'failed') return true;
      const t = new Date(i.sentAt ?? i.createdAt).getTime();
      return isNaN(t) || t >= cutoff;
    }),
  };
}

/** 画面に出すもの: 予定・送信中・失敗 + 直近24時間の送信済み */
export function visibleItems(store: OutboxStore, now = new Date()): OutboxItem[] {
  const cutoff = now.getTime() - 24 * 3_600_000;
  return store.items
    .filter((i) => i.status !== 'cancelled' && (i.status !== 'sent' || new Date(i.sentAt ?? i.createdAt).getTime() >= cutoff))
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}
