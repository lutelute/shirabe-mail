// === Google カレンダー(OAuth 2.0 / デスクトップアプリ・PKCE・ループバック、複数アカウント) ===
//
// 先生の Google Cloud で作った「デスクトップアプリ」用 OAuth クライアント(Client ID / Secret)で、
// 複数の Google アカウント(例: lutebass@gmail.com と lute@g.u-fukui.ac.jp)を認可できる。
// リフレッシュトークンと Client Secret は safeStorage で暗号化して userData/google-auth.json に置く。

import * as fs from 'fs';
import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { CaseEvent } from '../../src/types/index';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

interface GoogleAccountRecord {
  email: string;
  refreshToken: string;   // 暗号化済み
  calendarId: string;     // 既定 'primary'
  connectedAt: string;
}

interface GoogleAuthStoreV2 {
  version: 2;
  clientId: string;
  clientSecret: string;   // 暗号化済み
  accounts: GoogleAccountRecord[];
}

export interface GoogleCalendarDeps {
  storePath: string;
  encrypt: (s: string) => string;
  decrypt: (s: string) => string;
  openExternal: (url: string) => Promise<void>;
  log: (m: string) => void;
}

export interface GoogleStatus {
  configured: boolean;      // Client ID がある
  connected: boolean;       // 1 つ以上のアカウントを認可済み
  accounts: Array<{ email: string; calendarId: string }>;
  clientId: string;
  // 互換(最初のアカウント)
  email: string;
  calendarId: string;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function domainOf(email: string): string {
  const i = email.lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}

/** メールの受信アカウントから、予定を入れる Google アカウントを選ぶ(純関数) */
export function chooseGoogleAccount(connected: string[], mailAccount: string, preferred?: string): string | null {
  if (connected.length === 0) return null;
  if (preferred && connected.includes(preferred)) return preferred;
  const mail = (mailAccount || '').toLowerCase();
  if (connected.includes(mail)) return mail;
  const d = domainOf(mail);
  // 大学(u-fukui.ac.jp / g.u-fukui.ac.jp)同士を寄せる
  const org = (x: string) => x.replace(/^g\./, '');
  const sameOrg = connected.find((e) => org(domainOf(e)) === org(d) || domainOf(e).endsWith(`.${org(d)}`) || org(d).endsWith(`.${org(domainOf(e))}`));
  if (sameOrg) return sameOrg;
  // 個人(gmail.com)なら gmail のアカウント
  if (d === 'gmail.com') return connected.find((e) => domainOf(e) === 'gmail.com') ?? connected[0];
  return connected[0];
}

export function createGoogleCalendar(deps: GoogleCalendarDeps) {
  const accessTokens = new Map<string, { token: string; exp: number }>();

  function load(): GoogleAuthStoreV2 | null {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.storePath, 'utf-8')) as Partial<GoogleAuthStoreV2> & { refreshToken?: string; email?: string; calendarId?: string; connectedAt?: string };
      if (!raw || !raw.clientId) return null;
      if (raw.version === 2 && Array.isArray(raw.accounts)) return raw as GoogleAuthStoreV2;
      // v1(単一アカウント)からの移行
      const accounts: GoogleAccountRecord[] = raw.refreshToken
        ? [{ email: raw.email ?? '', refreshToken: raw.refreshToken, calendarId: raw.calendarId || 'primary', connectedAt: raw.connectedAt ?? new Date().toISOString() }]
        : [];
      return { version: 2, clientId: raw.clientId, clientSecret: raw.clientSecret ?? '', accounts };
    } catch {
      return null;
    }
  }
  function save(s: GoogleAuthStoreV2): void {
    fs.writeFileSync(deps.storePath, JSON.stringify(s, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  function status(): GoogleStatus {
    const s = load();
    const accounts = (s?.accounts ?? []).filter((a) => a.refreshToken).map((a) => ({ email: a.email, calendarId: a.calendarId || 'primary' }));
    return {
      configured: !!s?.clientId,
      connected: accounts.length > 0,
      accounts,
      clientId: s?.clientId ?? '',
      email: accounts[0]?.email ?? '',
      calendarId: accounts[0]?.calendarId ?? 'primary',
    };
  }

  async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') throw new Error('Google の認可が切れました。設定 → 相棒 → Google カレンダーで、そのアカウントを認可し直してください');
      throw new Error(`トークンを取得できませんでした: ${j.error_description || j.error || res.status}`);
    }
    return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, refresh_token: j.refresh_token };
  }

  async function tokenFor(email: string): Promise<string> {
    const cached = accessTokens.get(email);
    if (cached && cached.exp > Date.now()) return cached.token;
    const s = load();
    const acc = s?.accounts.find((a) => a.email === email && a.refreshToken);
    if (!s || !acc) throw new Error(`${email} は Google カレンダーにつないでいません`);
    const t = await tokenRequest({ client_id: s.clientId, client_secret: deps.decrypt(s.clientSecret), refresh_token: deps.decrypt(acc.refreshToken), grant_type: 'refresh_token' });
    accessTokens.set(email, { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  }

  async function apiWith<T>(accessToken: string, method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Google カレンダー: ${(j as { error?: { message?: string } }).error?.message ?? res.status}`);
    return j;
  }
  const api = async <T>(email: string, method: string, url: string, body?: unknown) => apiWith<T>(await tokenFor(email), method, url, body);

  /**
   * アカウントを認可して追加(同じアカウントなら更新)。
   * clientId/secret は初回だけ必要。2 つ目以降は保存済みのクライアントを使う。
   */
  async function connect(clientIdIn?: string, clientSecretIn?: string, loginHint?: string): Promise<GoogleStatus> {
    const prev = load();
    const clientId = (clientIdIn ?? '').trim() || prev?.clientId || '';
    const clientSecret = (clientSecretIn ?? '').trim() || (prev?.clientSecret ? deps.decrypt(prev.clientSecret) : '');
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Client ID の形式が違います(…apps.googleusercontent.com)');
    if (!clientSecret) throw new Error('Client Secret が空です');

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = '';
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
          const err = url.searchParams.get('error');
          const got = url.searchParams.get('code');
          const okState = url.searchParams.get('state') === state;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>調</title><body style="font-family:-apple-system,'Hiragino Sans',sans-serif;background:#F6F3EC;color:#1F2328;padding:48px"><h2>${err ? '認可されませんでした' : '調と Google カレンダーをつなぎました'}</h2><p>${err ? `(${err})` : 'このタブを閉じて、調に戻ってください。'}</p></body>`);
          clearTimeout(timer);
          server.close();
          if (err) reject(new Error(`Google が認可を拒否しました: ${err}`));
          else if (!got || !okState) reject(new Error('認可コードを受け取れませんでした'));
          else resolve({ code: got, redirectUri });
        } catch (e) {
          reject(e as Error);
        }
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('5 分以内に認可が終わりませんでした')); }, 5 * 60_000);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        redirectUri = `http://127.0.0.1:${port}`;
        const q = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: GOOGLE_SCOPES.join(' '),
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          access_type: 'offline',
          prompt: 'select_account consent',
        });
        if (loginHint) q.set('login_hint', loginHint);
        void deps.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`);
      });
    });

    const tok = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
    if (!tok.refresh_token) throw new Error('リフレッシュトークンが返りませんでした(もう一度認可してください)');
    let email = '';
    try {
      const prim = await apiWith<{ id: string }>(tok.access_token, 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary');
      email = prim.id;
    } catch (e) {
      deps.log(`[google] primary lookup failed: ${(e as Error).message}`);
    }
    if (!email) throw new Error('認可したアカウントのカレンダーが読めませんでした');
    accessTokens.set(email, { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 });

    const base: GoogleAuthStoreV2 = prev && prev.clientId === clientId
      ? prev
      : { version: 2, clientId, clientSecret: '', accounts: [] };
    const others = base.accounts.filter((a) => a.email !== email);
    const old = base.accounts.find((a) => a.email === email);
    save({
      version: 2,
      clientId,
      clientSecret: deps.encrypt(clientSecret),
      accounts: [...others, { email, refreshToken: deps.encrypt(tok.refresh_token), calendarId: old?.calendarId || 'primary', connectedAt: new Date().toISOString() }],
    });
    return status();
  }

  function disconnect(email?: string): GoogleStatus {
    const s = load();
    if (!s) return status();
    const targets = email ? s.accounts.filter((a) => a.email === email) : s.accounts;
    for (const a of targets) {
      if (!a.refreshToken) continue;
      const rt = deps.decrypt(a.refreshToken);
      void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined);
      accessTokens.delete(a.email);
    }
    save({ ...s, accounts: email ? s.accounts.filter((a) => a.email !== email) : [] });
    return status();
  }

  async function listCalendars(email: string): Promise<Array<{ id: string; summary: string; primary: boolean; writable: boolean }>> {
    const j = await api<{ items?: Array<{ id: string; summary: string; primary?: boolean; accessRole?: string }> }>(email, 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100');
    return (j.items ?? []).map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, writable: c.accessRole === 'owner' || c.accessRole === 'writer' }));
  }

  function setCalendar(email: string, calendarId: string): GoogleStatus {
    const s = load();
    if (s) save({ ...s, accounts: s.accounts.map((a) => (a.email === email ? { ...a, calendarId: calendarId || 'primary' } : a)) });
    return status();
  }

  async function insertEvent(email: string, ev: CaseEvent & { description?: string }): Promise<{ id: string; htmlLink: string; calendarId: string; email: string }> {
    const acc = load()?.accounts.find((a) => a.email === email);
    const calendarId = acc?.calendarId || 'primary';
    const j = await api<{ id: string; htmlLink: string }>(email, 'POST', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, eventBody(ev));
    return { id: j.id, htmlLink: j.htmlLink, calendarId, email };
  }

  async function deleteEvent(email: string, calendarId: string, eventId: string): Promise<void> {
    await api<void>(email, 'DELETE', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  return { status, connect, disconnect, listCalendars, setCalendar, insertEvent, deleteEvent };
}

export type GoogleCalendar = ReturnType<typeof createGoogleCalendar>;

/** CaseEvent → Calendar API の events.insert 本文(純関数) */
export function eventBody(ev: CaseEvent & { description?: string }): Record<string, unknown> {
  const m = ev.start.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) throw new Error(`予定の日時が読めません: ${ev.start}`);
  const allDay = ev.allDay || !m[2];
  const body: Record<string, unknown> = { summary: ev.title };
  if (ev.location) body.location = ev.location;
  if (ev.description) body.description = ev.description.slice(0, 4000);
  if (allDay) {
    const endDay = (ev.end ?? '').slice(0, 10) || m[1];
    const d = new Date(`${endDay >= m[1] ? endDay : m[1]}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const ex = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    body.start = { date: m[1] };
    body.end = { date: ex };
  } else {
    const startDT = `${m[1]}T${m[2]}:00`;
    let endDT = '';
    const me = (ev.end ?? '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (me) endDT = `${me[1]}T${me[2]}:00`;
    else {
      const d = new Date(startDT);
      d.setHours(d.getHours() + 1);
      endDT = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    }
    body.start = { dateTime: startDT, timeZone: 'Asia/Tokyo' };
    body.end = { dateTime: endDT, timeZone: 'Asia/Tokyo' };
  }
  body.reminders = { useDefault: true };
  return body;
}
