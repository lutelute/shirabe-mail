import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AccountConfig {
  email: string;
  accountUid: string;
  mailSubdir: string;
  eventSubdir: string | null;
  taskSubdir: string | null;
  label: string;
  type: 'imap' | 'google';
}

/**
 * Path to external accounts config file.
 * Accounts are stored outside the repo to avoid committing personal info.
 */
const CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'shirabe',
  'accounts.json',
);
// Fallback: try old path if new path doesn't exist
const CONFIG_PATH_LEGACY = path.join(
  os.homedir(),
  '.config',
  'emclient-monitor',
  'accounts.json',
);

let _cachedAccounts: AccountConfig[] | null = null;

function loadAccounts(): AccountConfig[] {
  if (_cachedAccounts) return _cachedAccounts;

  const configPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_PATH_LEGACY;

  if (!fs.existsSync(configPath)) {
    console.error(
      `[accounts] Config not found: ${CONFIG_PATH}\n` +
        'Create this file with your account configuration. See README for format.',
    );
    _cachedAccounts = [];
    return _cachedAccounts;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('accounts.json must be a JSON array');
    }
    _cachedAccounts = parsed as AccountConfig[];
    return _cachedAccounts;
  } catch (err) {
    console.error(`[accounts] Failed to load ${configPath}:`, err);
    _cachedAccounts = [];
    return _cachedAccounts;
  }
}

export function getAccounts(): AccountConfig[] {
  return loadAccounts();
}

/**
 * Lazily-loaded, array-like view over the configured accounts.
 *
 * The proxy delegates to the live (cached) accounts array so that `ACCOUNTS`
 * reflects config that is only loaded on first access. It forwards `get`,
 * `has`, and `ownKeys` to the *real* array — forwarding `has`/`ownKeys` is
 * essential: the old version forwarded only `get`, so existence probes fell
 * through to the empty `[]` target. Array methods that test existence
 * (`Array.prototype.map`/`filter`/`forEach`) then saw every index as a hole and
 * produced `[null, null, …]`, silently breaking `get_accounts` and the
 * `ACCOUNTS.map(a => a.email)` "sent by me" detection in get_mail_thread /
 * analyze_thread.
 *
 * `getOwnPropertyDescriptor` is intentionally NOT trapped: forwarding the real
 * array's non-configurable `length` descriptor would violate the proxy
 * invariant against the empty target and throw. Leaving it to fall through to
 * the target is safe because `map`/`filter`/`forEach`/`Object.keys` rely on
 * `has` + `get` (now forwarded), not on the own-descriptor of each index.
 */
export const ACCOUNTS = new Proxy([] as AccountConfig[], {
  get(_target, prop, receiver) {
    return Reflect.get(loadAccounts(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(loadAccounts(), prop);
  },
  ownKeys(_target) {
    return Reflect.ownKeys(loadAccounts());
  },
});

export function findAccount(email: string): AccountConfig {
  const accounts = loadAccounts();
  const acc = accounts.find((a) => a.email === email);
  if (!acc) throw new Error(`Unknown account: ${email}`);
  return acc;
}
