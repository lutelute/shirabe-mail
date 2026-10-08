import { useEffect, useState } from 'react';
import type { GoogleStatus } from '../../types';

// =====================================================================
// 設定 → 相棒 → Google カレンダーと接続(OAuth、複数アカウント)
//   先生の Google Cloud で作った「デスクトップアプリ」用クライアントで、
//   lutebass@gmail.com と lute@g.u-fukui.ac.jp のように複数のアカウントを認可できる。
//   予定は受信したメールのアカウントに合わせて自動で振り分け(予定ごとに変更可)。
// =====================================================================

interface Props {
  autoAdd: boolean;
  onAutoAdd: (v: boolean) => void;
  inputCls: string;
}

type Cal = { id: string; summary: string; primary: boolean; writable: boolean };

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';
const API_URL = 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
const CONSENT_URL = 'https://console.cloud.google.com/auth/overview';
const SUGGESTED = ['lutebass@gmail.com', 'lute@g.u-fukui.ac.jp'];

export default function GoogleCalendarConnect({ autoAdd, onAutoAdd, inputCls }: Props) {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [editClient, setEditClient] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [cals, setCals] = useState<Record<string, Cal[]>>({});
  const [showHow, setShowHow] = useState(false);

  const refresh = async () => {
    const s = await window.electronAPI.googleStatus();
    setSt(s);
    if (s.clientId && !clientId) setClientId(s.clientId);
    const next: Record<string, Cal[]> = {};
    for (const a of s.accounts) {
      const r = await window.electronAPI.googleCalendars(a.email);
      if (r.status === 'done' && r.calendars) next[a.email] = r.calendars.filter((c) => c.writable);
    }
    setCals(next);
  };
  useEffect(() => { void refresh(); }, []);

  const connect = async (loginHint?: string) => {
    setBusy(loginHint ?? 'new');
    setMsg({ text: `ブラウザで Google の認可画面を開きました${loginHint ? `(${loginHint})` : ''}。許可したら自動でここに戻ります…` });
    try {
      const needClient = !st?.configured || editClient;
      const r = await window.electronAPI.googleConnect(needClient ? { clientId, clientSecret, loginHint } : { loginHint });
      if (r.status === 'done') {
        setMsg({ text: 'つなぎました' });
        setClientSecret('');
        setEditClient(false);
        await refresh();
      } else {
        setMsg({ text: r.error ?? '認可できませんでした', err: true });
      }
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (email: string) => {
    const s = await window.electronAPI.googleDisconnect(email);
    setSt(s);
    setMsg({ text: `${email} の接続を解除しました` });
    await refresh();
  };

  const pickCal = async (email: string, id: string) => { setSt(await window.electronAPI.googleSetCalendar(email, id)); };
  const open = (url: string) => { void window.electronAPI.openExternalUrl(url); };

  const connectedEmails = new Set(st?.accounts.map((a) => a.email) ?? []);
  const missingSuggested = SUGGESTED.filter((e) => !connectedEmails.has(e));
  const showClientForm = !st?.configured || editClient;

  return (
    <div className="rounded-lg border border-surface-700/60 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm text-surface-200 font-medium">Google カレンダーと接続</span>
        {st?.connected
          ? <span className="text-[11px] px-1.5 py-0.5 rounded border border-emerald-600/30 bg-emerald-500/10 text-emerald-600">{st.accounts.length} アカウント接続済み</span>
          : <span className="text-[11px] px-1.5 py-0.5 rounded border border-amber-600/30 bg-amber-500/10 text-amber-700">未接続(今は作成画面を開いて保存を押す方式)</span>}
      </div>

      {/* 接続済みアカウント */}
      {st?.accounts.map((a) => (
        <div key={a.email} className="flex items-center gap-2 rounded-md border border-surface-700/50 px-2.5 py-2">
          <span className="text-sm text-surface-200 w-[200px] truncate flex-shrink-0" title={a.email}>{a.email}</span>
          <select value={a.calendarId} onChange={(e) => void pickCal(a.email, e.target.value)} className={inputCls}>
            <option value="primary">メイン</option>
            {(cals[a.email] ?? []).filter((c) => !c.primary).map((c) => <option key={c.id} value={c.id}>{c.summary}</option>)}
          </select>
          <button type="button" onClick={() => void connect(a.email)} disabled={!!busy} className="px-2 py-1 text-xs rounded bg-surface-700 text-surface-300 hover:bg-surface-600 flex-shrink-0" title="認可し直す">認可し直す</button>
          <button type="button" onClick={() => void disconnect(a.email)} className="px-2 py-1 text-xs rounded bg-surface-700 text-surface-300 hover:bg-surface-600 flex-shrink-0">解除</button>
        </div>
      ))}

      {/* クライアント(初回 or 変更) */}
      {showClientForm && (
        <div className="grid grid-cols-2 gap-2">
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID(…apps.googleusercontent.com)" className={inputCls} spellCheck={false} />
          <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="Client Secret" type="password" className={inputCls} spellCheck={false} />
        </div>
      )}

      {/* 追加ボタン */}
      <div className="flex items-center gap-2 flex-wrap">
        {missingSuggested.map((e) => (
          <button key={e} type="button" disabled={!!busy || (showClientForm && (!clientId || !clientSecret))} onClick={() => void connect(e)} className="px-3 py-1.5 text-sm rounded bg-accent-500 text-white disabled:opacity-40">
            {busy === e ? '認可を待っています…' : `${e} を認可`}
          </button>
        ))}
        <button type="button" disabled={!!busy || (showClientForm && (!clientId || !clientSecret))} onClick={() => void connect()} className="px-3 py-1.5 text-sm rounded bg-surface-700 text-surface-200 hover:bg-surface-600 disabled:opacity-40">
          {busy === 'new' ? '認可を待っています…' : '別のアカウントを追加'}
        </button>
        {st?.configured && !editClient && <button type="button" onClick={() => setEditClient(true)} className="text-xs text-surface-400 underline">クライアントを変更</button>}
        <button type="button" onClick={() => setShowHow((v) => !v)} className="text-xs text-accent-400 underline">{showHow ? '作り方を閉じる' : 'Client ID の作り方(5 分)'}</button>
      </div>

      {st?.connected && (
        <>
          <label className="flex items-center gap-2 text-sm text-surface-200 cursor-pointer">
            <input type="checkbox" checked={autoAdd} onChange={(e) => onAutoAdd(e.target.checked)} />
            見つけた予定(会議・行事・締切)を相棒が自動で登録する
          </label>
          <p className="text-xs text-surface-500 -mt-2">どのアカウントに入れるかは、メールを受け取ったアカウントに合わせます(大学宛 → 大学の Google、Gmail 宛 → Gmail)。上の「アカウント」で固定もできます。予定ごとに「今日」から切り替え・取り消しができます。</p>
        </>
      )}

      {showHow && (
        <ol className="list-decimal pl-5 space-y-1 text-xs text-surface-400 leading-relaxed">
          <li><button type="button" className="underline text-accent-400" onClick={() => open(API_URL)}>Google Calendar API</button> を開き、プロジェクトを作って(または選んで)「有効にする」。</li>
          <li><button type="button" className="underline text-accent-400" onClick={() => open(CONSENT_URL)}>OAuth 同意画面</button> で アプリ名「調」・ユーザーの種類「外部」・サポートメールに自分。「対象」で <b>lutebass@gmail.com と lute@g.u-fukui.ac.jp の 2 つ</b>をテストユーザーに追加。</li>
          <li>公開ステータスを「本番環境に公開」にする(テストのままだと 7 日で認可が切れます。未確認アプリの警告は自分用なので「続行」で可)。</li>
          <li><button type="button" className="underline text-accent-400" onClick={() => open(CONSOLE_URL)}>認証情報</button> → 「認証情報を作成」→「OAuth クライアント ID」→ 種類「デスクトップ アプリ」→ 作成。</li>
          <li>Client ID と Client Secret を上に貼り、「lutebass@gmail.com を認可」→ 続けて「lute@g.u-fukui.ac.jp を認可」。クライアントは 1 つで両方に使えます。</li>
          <li>大学アカウントで「管理者によってブロックされています」と出たら、大学(総合情報基盤センター)の Google Workspace がサードパーティアプリを制限しています。その場合は Gmail 側だけで使うか、eM Client 経由の登録を使ってください。</li>
        </ol>
      )}
      {msg && <p className={`text-xs ${msg.err ? 'text-red-500' : 'text-surface-400'}`}>{msg.text}</p>}
    </div>
  );
}
