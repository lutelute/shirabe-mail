import { useEffect, useState } from 'react';
import type { GoogleStatus } from '../../types';

// =====================================================================
// 設定 → 相棒 → Google カレンダーと接続(OAuth)
//   先生の Google Cloud で作った「デスクトップアプリ」用クライアントで認可する。
//   認可後は「Google カレンダーに登録」が画面を開かずに直接入る(取り消し可)。
// =====================================================================

interface Props {
  autoAdd: boolean;
  onAutoAdd: (v: boolean) => void;
  inputCls: string;
}

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';
const API_URL = 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
const CONSENT_URL = 'https://console.cloud.google.com/auth/overview';

export default function GoogleCalendarConnect({ autoAdd, onAutoAdd, inputCls }: Props) {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [cals, setCals] = useState<Array<{ id: string; summary: string; primary: boolean; writable: boolean }>>([]);
  const [showHow, setShowHow] = useState(false);

  const refresh = async () => {
    const s = await window.electronAPI.googleStatus();
    setSt(s);
    if (s.clientId && !clientId) setClientId(s.clientId);
    if (s.connected) {
      const r = await window.electronAPI.googleCalendars();
      if (r.status === 'done' && r.calendars) setCals(r.calendars.filter((c) => c.writable));
    }
  };
  useEffect(() => { void refresh(); }, []);

  const connect = async () => {
    setBusy(true);
    setMsg({ text: 'ブラウザで Google の認可画面を開きました。許可したら自動でここに戻ります…' });
    try {
      const r = await window.electronAPI.googleConnect({ clientId, clientSecret, loginHint: 'lutebass@gmail.com' });
      if (r.status === 'done') {
        setMsg({ text: `つなぎました: ${r.google?.email ?? ''}` });
        setClientSecret('');
        await refresh();
      } else {
        setMsg({ text: r.error ?? '認可できませんでした', err: true });
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const s = await window.electronAPI.googleDisconnect();
    setSt(s);
    setCals([]);
    setMsg({ text: '接続を解除しました' });
  };

  const pickCal = async (id: string) => {
    const s = await window.electronAPI.googleSetCalendar(id);
    setSt(s);
  };

  const open = (url: string) => { void window.electronAPI.openExternalUrl(url); };

  return (
    <div className="rounded-lg border border-surface-700/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-surface-200 font-medium">Google カレンダーと接続</span>
        {st?.connected
          ? <span className="text-[11px] px-1.5 py-0.5 rounded border border-emerald-600/30 bg-emerald-500/10 text-emerald-600">接続済み: {st.email || '(アカウント)'}</span>
          : <span className="text-[11px] px-1.5 py-0.5 rounded border border-amber-600/30 bg-amber-500/10 text-amber-700">未接続(今は作成画面を開いて保存を押す方式)</span>}
      </div>

      {st?.connected ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-surface-400 flex-shrink-0">登録するカレンダー</span>
            <select value={st.calendarId} onChange={(e) => void pickCal(e.target.value)} className={inputCls}>
              <option value="primary">メイン({st.email})</option>
              {cals.filter((c) => !c.primary).map((c) => <option key={c.id} value={c.id}>{c.summary}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-surface-200 cursor-pointer">
            <input type="checkbox" checked={autoAdd} onChange={(e) => onAutoAdd(e.target.checked)} />
            見つけた予定(会議・行事・締切)を相棒が自動で登録する
          </label>
          <p className="text-xs text-surface-500 -mt-2">オフのときは「Google カレンダーに登録」を押した分だけ入ります。登録した予定は「今日」から取り消せます。</p>
          <button type="button" onClick={() => void disconnect()} className="px-3 py-1.5 text-xs rounded bg-surface-700 text-surface-300 hover:bg-surface-600">接続を解除</button>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID(…apps.googleusercontent.com)" className={inputCls} spellCheck={false} />
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client Secret" type="password" className={inputCls} spellCheck={false} />
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={busy || !clientId || !clientSecret} onClick={() => void connect()} className="px-3 py-1.5 text-sm rounded bg-accent-500 text-white disabled:opacity-40">{busy ? '認可を待っています…' : 'Google で認可'}</button>
            <button type="button" onClick={() => setShowHow((v) => !v)} className="text-xs text-accent-400 underline">{showHow ? '作り方を閉じる' : 'Client ID の作り方(5 分)'}</button>
          </div>
          {showHow && (
            <ol className="list-decimal pl-5 space-y-1 text-xs text-surface-400 leading-relaxed">
              <li><button type="button" className="underline text-accent-400" onClick={() => open(API_URL)}>Google Calendar API</button> を開き、プロジェクトを作って(または選んで)「有効にする」。</li>
              <li><button type="button" className="underline text-accent-400" onClick={() => open(CONSENT_URL)}>OAuth 同意画面</button> で アプリ名「調」・ユーザーの種類「外部」・サポートメールに自分のアドレス。「対象」で自分(lutebass@gmail.com)をテストユーザーに追加。</li>
              <li>公開ステータスを「本番環境に公開」にする(テストのままだと 7 日で認可が切れます。未確認アプリの警告は自分用なので「続行」で可)。</li>
              <li><button type="button" className="underline text-accent-400" onClick={() => open(CONSOLE_URL)}>認証情報</button> → 「認証情報を作成」→「OAuth クライアント ID」→ 種類「デスクトップ アプリ」→ 作成。</li>
              <li>表示された Client ID と Client Secret を上に貼って「Google で認可」。ブラウザで lutebass@gmail.com を選んで許可すれば完了です。</li>
            </ol>
          )}
        </>
      )}
      {msg && <p className={`text-xs ${msg.err ? 'text-red-500' : 'text-surface-400'}`}>{msg.text}</p>}
    </div>
  );
}
