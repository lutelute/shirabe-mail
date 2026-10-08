import { useState } from 'react';

// =====================================================================
// 設定 → 相棒 → 予定の登録先(Google)
//   既定は「Claude の Google カレンダー連携」(claude.ai で認可済みのものを使う。Google Cloud の設定は不要)。
//   大学用・個人用の 2 つのカレンダーを選び、メールを受け取ったアカウントで振り分ける。
// =====================================================================

interface Props {
  via: 'claude' | 'oauth';
  onVia: (v: 'claude' | 'oauth') => void;
  targets: string[];
  onTargets: (t: string[]) => void;
  autoAdd: boolean;
  onAutoAdd: (v: boolean) => void;
  inputCls: string;
}

export default function ClaudeCalendarTargets({ via, onVia, targets, onTargets, autoAdd, onAutoAdd, inputCls }: Props) {
  const [cals, setCals] = useState<Array<{ id: string; summary: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const work = targets[0] ?? 'lute@u-fukui.ac.jp';
  const personal = targets[1] ?? 'lutebass@gmail.com';

  const load = async () => {
    setLoading(true);
    setMsg({ text: 'Claude の Google カレンダー連携からカレンダー一覧を読んでいます…(数秒)' });
    try {
      const r = await window.electronAPI.calendarListViaClaude();
      if (r.status === 'done' && r.calendars) {
        setCals(r.calendars.filter((c) => !c.id.includes('#holiday')));
        setMsg({ text: `${r.calendars.length} 個のカレンダーが見つかりました。Claude の連携は使えます。` });
      } else {
        setMsg({ text: r.error ?? '読めませんでした', err: true });
      }
    } finally {
      setLoading(false);
    }
  };

  const options = (current: string) => {
    const ids = Array.from(new Set([current, ...cals.map((c) => c.id)])).filter(Boolean);
    return ids.map((id) => <option key={id} value={id}>{cals.find((c) => c.id === id)?.summary && cals.find((c) => c.id === id)!.summary !== id ? `${cals.find((c) => c.id === id)!.summary}(${id})` : id}</option>);
  };

  const seg = (active: boolean) => `px-3 py-1.5 text-sm rounded transition-colors ${active ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30' : 'bg-surface-700 text-surface-300 hover:bg-surface-600 border border-transparent'}`;

  return (
    <div className="rounded-lg border border-surface-700/60 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-surface-200 font-medium mr-1">Google への書き込み</span>
        <button type="button" onClick={() => onVia('claude')} className={seg(via === 'claude')}>Claude の Google カレンダー連携(推奨・設定不要)</button>
        <button type="button" onClick={() => onVia('oauth')} className={seg(via === 'oauth')}>自分の OAuth クライアント</button>
      </div>
      {via === 'claude' && (
        <>
          <p className="text-xs text-surface-500 -mt-1">claude.ai で認可済みの Google カレンダー連携を、相棒が Claude Code 経由で使います。Google Cloud の設定は要りません。1 件あたり数秒です。</p>
          <div className="grid grid-cols-[88px_1fr] gap-2 items-center">
            <span className="text-xs text-surface-400">大学の予定</span>
            <select value={work} onChange={(e) => onTargets([e.target.value, personal])} className={inputCls}>{options(work)}</select>
            <span className="text-xs text-surface-400">個人の予定</span>
            <select value={personal} onChange={(e) => onTargets([work, e.target.value])} className={inputCls}>{options(personal)}</select>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading} className="px-3 py-1.5 text-xs rounded bg-surface-700 text-surface-200 hover:bg-surface-600 disabled:opacity-40">{loading ? '読んでいます…' : 'カレンダー一覧を読み込む(接続の確認)'}</button>
          </div>
          <p className="text-xs text-surface-500">大学のアドレス(lute@u-fukui.ac.jp / lute@g.u-fukui.ac.jp)宛のメールの予定は「大学の予定」へ、Gmail 宛は「個人の予定」へ入ります。予定ごとに「今日」から選び直せます。</p>
          <label className="flex items-center gap-2 text-sm text-surface-200 cursor-pointer">
            <input type="checkbox" checked={autoAdd} onChange={(e) => onAutoAdd(e.target.checked)} />
            見つけた予定(会議・行事・締切)を相棒が自動で登録する
          </label>
        </>
      )}
      {msg && <p className={`text-xs ${msg.err ? 'text-red-500' : 'text-surface-400'}`}>{msg.text}</p>}
    </div>
  );
}
