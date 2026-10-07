// === 相棒の日誌(JSONL、日ごと) ===
// 何をしたかを全部残す。信頼は「あとから確かめられる」ことから生まれる。

import * as fs from 'fs';
import * as path from 'path';
import type { JournalEntry, JournalKind } from '../../src/types/index';

function dayFile(dir: string, d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(dir, `${y}-${m}-${day}.jsonl`);
}

export function appendJournal(dir: string, entry: Omit<JournalEntry, 'at'> & { at?: string }): JournalEntry {
  const full: JournalEntry = { at: entry.at ?? new Date().toISOString(), ...entry } as JournalEntry;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(dayFile(dir, new Date(full.at)), `${JSON.stringify(full)}\n`, 'utf-8');
  } catch {
    /* 日誌の失敗で本処理を止めない */
  }
  return full;
}

/** 直近 N 件(新しい順)。今日と昨日までのファイルを読む */
export function readRecentJournal(dir: string, limit = 80, days = 2): JournalEntry[] {
  const out: JournalEntry[] = [];
  const now = new Date();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const f = dayFile(dir, d);
    if (!fs.existsSync(f)) continue;
    try {
      const lines = fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean);
      for (const l of lines) {
        try { out.push(JSON.parse(l) as JournalEntry); } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}

export const JOURNAL_LABEL: Record<JournalKind, string> = {
  run: '確認', sent: '送信', scheduled: '送信予定', cancelled: '取消', archived: '片付け', read: '既読',
  quarantined: '隔離', tagged: 'タグ', decided: '決定', nudged: '催促', tidy_undone: '戻した', closed: '完了', error: 'エラー',
};
