// === Google カレンダー(OAuth 2.0 / デスクトップアプリ・PKCE・ループバック) ===
//
// 先生の Google Cloud で作った「デスクトップアプリ」用 OAuth クライアント(Client ID / Secret)で認可し、
// リフレッシュトークンを safeStorage で暗号化して userData/google-auth.json に置く。
// 以後は相棒が予定を直接 Google カレンダーに入れる(取り消しは予定の削除)。

import * as fs from 'fs';
import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { CaseEvent } from '../../src/types/index';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export interface GoogleAuthStore {
  clientId: string;
  clientSecret: string;     // 暗号化済み(enc:v1:…)で保存
  refreshToken: string;     // 暗号化済みで保存
  email: string;            // 認可したアカウント(primary カレンダーの id)
  calendarId: string;       // 既定 'primary'
  connectedAt: string;
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
  connected: boolean;       // リフレッシュトークンがある
  email: string;
  calendarId: string;
  clientId: string;
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createGoogleCalendar(deps: GoogleCalendarDeps) {
  let accessToken: { token: string; exp: number } | null = null;

  function load(): GoogleAuthStore | null {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.storePath, 'utf-8')) as GoogleAuthStore;
      return raw && raw.clientId ? raw : null;
    } catch {
      return null;
    }
  }
  function save(s: GoogleAuthStore): void {
    fs.writeFileSync(deps.storePath, JSON.stringify(s, null, 2), { encoding: 'utf-8', mode: 0o600 });
  }

  function status(): GoogleStatus {
    const s = load();
    return {
      configured: !!s?.clientId,
      connected: !!s?.refreshToken,
      email: s?.email ?? '',
      calendarId: s?.calendarId || 'primary',
      clientId: s?.clientId ?? '',
    };
  }

  /** Client ID / Secret を受け取り、ブラウザで認可 → コードを受け取り → トークン交換 */
  async function connect(clientId: string, clientSecret: string, loginHint?: string): Promise<GoogleStatus> {
    clientId = clientId.trim();
    clientSecret = clientSecret.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error('Client ID の形式が違います(…apps.googleusercontent.com)');
    if (!clientSecret) throw new Error('Client Secret が空です');

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
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
      let redirectUri = '';
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
          prompt: 'consent',
        });
        if (loginHint) q.set('login_hint', loginHint);
        void deps.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`);
      });
    });

    const tok = await tokenRequest({
      code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
      grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error('リフレッシュトークンが返りませんでした(もう一度「Google で認可」を)');
    accessToken = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };

    // 認可したアカウント = primary カレンダーの id
    let email = '';
    try {
      const prim = await api<{ id: string }>('GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary');
      email = prim.id;
    } catch (e) {
      deps.log(`[google] primary lookup failed: ${(e as Error).message}`);
    }
    save({
      clientId,
      clientSecret: deps.encrypt(clientSecret),
      refreshToken: deps.encrypt(tok.refresh_token),
      email,
      calendarId: 'primary',
      connectedAt: new Date().toISOString(),
    });
    return status();
  }

  function disconnect(): void {
    const s = load();
    if (s?.refreshToken) {
      // 失効は best effort
      const rt = deps.decrypt(s.refreshToken);
      void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined);
    }
    if (s) save({ ...s, refreshToken: '', email: '' });
    accessToken = null;
  }

  async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) {
      if (j.error === 'invalid_grant') throw new Error('Google の認可が切れました。設定 → 相棒 → Google カレンダーで「Google で認可」をやり直してください');
      throw new Error(`トークンを取得できませんでした: ${j.error_description || j.error || res.status}`);
    }
    return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, refresh_token: j.refresh_token };
  }

  async function token(): Promise<string> {
    if (accessToken && accessToken.exp > Date.now()) return accessToken.token;
    const s = load();
    if (!s?.refreshToken) throw new Error('Google カレンダーとまだつないでいません');
    const t = await tokenRequest({
      client_id: s.clientId, client_secret: deps.decrypt(s.clientSecret),
      refresh_token: deps.decrypt(s.refreshToken), grant_type: 'refresh_token',
    });
    accessToken = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Google カレンダー: ${(j as { error?: { message?: string } }).error?.message ?? res.status}`);
    return j;
  }

  async function listCalendars(): Promise<Array<{ id: string; summary: string; primary: boolean; writable: boolean }>> {
    const j = await api<{ items?: Array<{ id: string; summary: string; primary?: boolean; accessRole?: string }> }>('GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100');
    return (j.items ?? []).map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary, writable: c.accessRole === 'owner' || c.accessRole === 'writer' }));
  }

  function setCalendar(calendarId: string): void {
    const s = load();
    if (s) save({ ...s, calendarId: calendarId || 'primary' });
  }

  async function insertEvent(ev: CaseEvent & { description?: string }): Promise<{ id: string; htmlLink: string; calendarId: string }> {
    const s = load();
    const calendarId = s?.calendarId || 'primary';
    const j = await api<{ id: string; htmlLink: string }>('POST', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, eventBody(ev));
    return { id: j.id, htmlLink: j.htmlLink, calendarId };
  }

  async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await api<void>('DELETE', `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
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
      const d = new Date(`${startDT}`);
      d.setHours(d.getHours() + 1);
      endDT = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    }
    body.start = { dateTime: startDT, timeZone: 'Asia/Tokyo' };
    body.end = { dateTime: endDT, timeZone: 'Asia/Tokyo' };
  }
  body.reminders = { useDefault: true };
  return body;
}
