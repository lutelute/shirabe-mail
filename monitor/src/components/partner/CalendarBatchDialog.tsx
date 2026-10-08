import { useMemo, useState } from 'react';
import type { ButlerCase } from '../../types';
import { fmtEvent, PrimaryButton, GhostButton, Spinner } from './partnerUi';

// =====================================================================
// カレンダー未登録の予定を一覧から選んで、まとめて Google カレンダーに登録する
//   既定のチェック: 会議・行事で今日以降のもの。締切・その他は見えるがチェックなし
// =====================================================================

interface Props {
  cases: ButlerCase[];             // event があり calendarStatus === 'missing'
  targets: string[];               // 登録先の候補(カレンダー id)
  onClose: () => void;
  onDone: (msg: string) => void;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const KIND_LABEL: Record<string, string> = { meeting: '会議', event: '行事', deadline: '締切', other: 'その他' };

export default function CalendarBatchDialog({ cases, targets, onClose, onDone }: Props) {
  const sorted = useMemo(() => [...cases].sort((a, b) => (a.event?.start ?? '').localeCompare(b.event?.start ?? '')), [cases]);
  const t0 = today();
  const [checked, setChecked] = useState<Set<string>>(() => new Set(sorted.filter((c) => c.event && (c.event.kind === 'meeting' || c.event.kind === 'event') && c.event.start.slice(0, 10) >= t0).map((c) => c.id)));
  const [account, setAccount] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = checked.size === sorted.length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const items = sorted.filter((c) => checked.has(c.id)).map((c) => ({ caseId: c.id, account: account[c.id] || undefined }));
      const r = await window.electronAPI.partnerAddManyToCalendar({ items });
      if (r.status === 'error' && r.done === 0) { setError(r.error ?? '登録できませんでした'); return; }
      onDone(`Google カレンダーに ${r.done} 件登録しました${r.failed.length ? `(${r.failed.length} 件は失敗。もう一度お試しください)` : ''}`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 app-no-drag" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="w-[760px] max-w-[92vw] max-h-[80vh] flex flex-col rounded-xl border border-hairline bg-card shadow-card">
        <div className="px-5 py-4 border-b border-hairline flex items-center gap-3">
          <h2 className="text-[15px] font-semibold text-ink">カレンダー未登録の予定</h2>
          <span className="text-[12px] text-ink-3">{sorted.length} 件 · 選んだものをまとめて登録します</span>
          <span className="flex-1" />
          <GhostButton onClick={() => setChecked(allOn ? new Set() : new Set(sorted.map((c) => c.id)))}>{allOn ? 'すべて外す' : 'すべて選ぶ'}</GhostButton>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sorted.map((c) => {
            const ev = c.event!;
            const past = ev.start.slice(0, 10) < t0;
            return (
              <label key={c.id} className={`flex items-center gap-3 px-5 py-2.5 border-b border-hairline/70 cursor-pointer hover:bg-card-2 ${past ? 'opacity-55' : ''}`}>
                <input type="checkbox" checked={checked.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} />
                <span className="w-[150px] flex-shrink-0 text-[12px] text-ink-2 tnum">{fmtEvent(ev)}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-ink truncate">{ev.title}<span className="ml-1.5 text-[10.5px] text-ink-3">{KIND_LABEL[ev.kind] ?? ev.kind}{past ? '・過去' : ''}</span></span>
                  <span className="block text-[11px] text-ink-3 truncate">{c.fromName || c.fromAddress}「{c.subject}」</span>
                </span>
                {targets.length > 1 && (
                  <select
                    value={account[c.id] ?? ''}
                    onChange={(e) => setAccount((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    onClick={(e) => e.preventDefault()}
                    disabled={busy}
                    className="h-7 px-1.5 text-[11.5px] bg-card border border-hairline rounded-md text-ink-2 max-w-[190px]"
                    title="登録先(自動 = メールを受け取ったアカウントに合わせる)"
                  >
                    <option value="">自動</option>
                    {targets.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}
              </label>
            );
          })}
        </div>
        <div className="px-5 py-3 border-t border-hairline flex items-center gap-2">
          {error && <span className="text-[12px] text-danger truncate">{error}</span>}
          <span className="flex-1" />
          <GhostButton onClick={onClose} disabled={busy}>閉じる</GhostButton>
          <PrimaryButton onClick={() => void submit()} disabled={busy || checked.size === 0}>
            {busy ? <><Spinner /> 登録しています…(数十秒)</> : `選んだ ${checked.size} 件を登録`}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
