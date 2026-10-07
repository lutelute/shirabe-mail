// === eM Client のアカウント設定から接続先を自動検出する ===
//
// 先生に IMAP/SMTP のホストやポートを打たせない。eM Client が既に知っていることは
// accounts.dat(SQLite, 読み取り専用)から取る。パスワードは暗号化されていて取れないので、
// 先生が入れるのはパスワード(Gmail はアプリパスワード)だけ。

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AccountEndpoints } from '../../src/types/index';

const ACCOUNTS_DB = path.join(os.homedir(), 'Library', 'Application Support', 'eM Client', 'accounts.dat');

interface RawConfig {
  key: string;
  type: string;                 // 'ImapAccountConfiguration' など
  v: Record<string, unknown>;   // TypeValue
}

function readRawConfigs(dbPath = ACCOUNTS_DB): RawConfig[] {
  if (!fs.existsSync(dbPath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT key, value FROM AccountsJson').all() as Array<{ key: string; value: string | Buffer }>;
    const out: RawConfig[] = [];
    for (const r of rows) {
      try {
        const text = typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf-8');
        const j = JSON.parse(text) as { Type?: string; TypeValue?: Record<string, unknown> };
        const type = String(j.Type ?? '').split(',')[0].split('.').pop() ?? '';
        if (!type || !j.TypeValue) continue;
        out.push({ key: r.key, type, v: j.TypeValue });
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** "Name" <addr> / Name <addr> / addr を分解 */
export function parseEmailAddress(raw: string): { name: string; address: string } {
  const s = (raw || '').trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: '', address: s.toLowerCase() };
}

function sslToSecure(ssl: string, port: number): boolean {
  // eM Client: UseTlsOnSpecialPort = 暗黙TLS(993/465) / UseTlsAlways,UseTlsIfAvailable = STARTTLS / None
  if (/OnSpecialPort/i.test(ssl)) return true;
  if (/Always|IfAvailable/i.test(ssl)) return false;
  return port === 993 || port === 465;
}

/**
 * アカウント(メールアドレス)ごとに IMAP/SMTP の接続先・表示名を返す。
 * `wanted` を渡すとそのアドレスだけ。
 */
export function discoverAccountEndpoints(wanted?: string[], dbPath = ACCOUNTS_DB): AccountEndpoints[] {
  const configs = readRawConfigs(dbPath);
  const mailAccounts = configs.filter((c) => c.type === 'MailAccountConfiguration');
  const want = new Set((wanted ?? []).map((w) => w.toLowerCase()));
  const out: AccountEndpoints[] = [];

  for (const acc of mailAccounts) {
    const email = parseEmailAddress(str(acc.v.EmailAddress)).address || str(acc.v.AccountName).toLowerCase();
    if (!email) continue;
    if (want.size > 0 && !want.has(email)) continue;
    const cred = (acc.v.Credentials ?? {}) as Record<string, unknown>;
    const auth: AccountEndpoints['auth'] = /oauth/i.test(str(cred.Type)) ? 'oauth' : 'password';
    const provider: AccountEndpoints['provider'] = /gmail|google/i.test(str(acc.v.ProviderName)) || /gmail\.com$|g\.u-fukui\.ac\.jp$/i.test(email) ? 'gmail' : 'generic';
    const accountUser = str(cred.Username) || email;

    const sub = configs.filter((c) => str(c.v.BindingConfigurationUID) === acc.key);
    const imapCfg = sub.find((c) => c.type === 'ImapAccountConfiguration');
    const smtpCfg = sub.find((c) => c.type === 'SmtpAccountConfiguration');

    const toEndpoint = (c: RawConfig | undefined, defPort: number) => {
      if (!c) return null;
      const host = str(c.v.Host);
      if (!host) return null;
      const port = Number(c.v.Port) || defPort;
      const subCred = (c.v.Credentials ?? {}) as Record<string, unknown>;
      const user = str(subCred.Username) || (provider === 'gmail' ? email : accountUser);
      return { host, port, secure: sslToSecure(str(c.v.SSL), port), user };
    };

    out.push({
      accountEmail: email,
      displayName: parseEmailAddress(str(acc.v.EmailAddress)).name,
      provider,
      auth,
      imap: toEndpoint(imapCfg, 993) ?? (provider === 'gmail' ? { host: 'imap.gmail.com', port: 993, secure: true, user: email } : null),
      smtp: toEndpoint(smtpCfg, 465) ?? (provider === 'gmail' ? { host: 'smtp.gmail.com', port: 465, secure: true, user: email } : null),
      signature: '',
    });
  }
  return out;
}
