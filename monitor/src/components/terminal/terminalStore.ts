// =====================================================================
// アプリ内ターミナルのセッション置き場(モジュール単位 — ビューを離れてもバッファを失わない)
//   - xterm インスタンスはここで保持し、TerminalView がマウントされるたびに DOM へ付け直す
//   - PTY のデータ購読は 1 本だけ(onPtyData / onPtyExit)。id でセッションに振り分ける
// =====================================================================
import { Terminal } from '@xterm/xterm';
import { isComposingKey } from '../../utils/ime';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtySession } from '../../types';

/** 日本語変換の確定 Enter をシェルへ送らない(xterm に渡す前に捨てる) */
function imeGuard(term: Terminal): void {
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && ev.key === 'Enter' && isComposingKey(ev)) return false;
    return true;
  });
}

export interface TermEntry {
  info: PtySession;
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;      // xterm を open した入れ物(タブ切替で display を切る)
  exitCode?: number;
}

type Listener = () => void;
const entries = new Map<string, TermEntry>();
const order: string[] = [];
const listeners = new Set<Listener>();
let subscribed = false;
let unsubs: Array<() => void> = [];

function css(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** いまのテーマ(paper / dark)に合わせた xterm の配色 */
export function currentTheme() {
  const paper = document.body.classList.contains('theme-paper');
  return {
    background: css('--card', paper ? '#FFFFFF' : '#1E2126'),
    foreground: css('--ink', paper ? '#1F2328' : '#E8E6E1'),
    cursor: css('--primary', paper ? '#2F5D8A' : '#7FB0E0'),
    cursorAccent: css('--card', paper ? '#FFFFFF' : '#1E2126'),
    selectionBackground: paper ? 'rgba(47,93,138,0.18)' : 'rgba(127,176,224,0.25)',
    black: paper ? '#1F2328' : '#15171B',
    red: paper ? '#B4432D' : '#E07A5F',
    green: paper ? '#3E7D4B' : '#7CB98A',
    yellow: paper ? '#9A6B12' : '#D6A443',
    blue: paper ? '#2F5D8A' : '#7FB0E0',
    magenta: paper ? '#7A4E8C' : '#C9A6E0',
    cyan: paper ? '#2B7A86' : '#86C7CF',
    white: paper ? '#5F6670' : '#E8E6E1',
    brightBlack: paper ? '#8A8F98' : '#6B7078',
    brightRed: paper ? '#C8502E' : '#F0937B',
    brightGreen: paper ? '#4F9A5E' : '#98D0A4',
    brightYellow: paper ? '#B7791F' : '#E8C06A',
    brightBlue: paper ? '#3F78AE' : '#A3C8EC',
    brightMagenta: paper ? '#9A6DB0' : '#DDBFEE',
    brightCyan: paper ? '#3A98A6' : '#A6DCE3',
    brightWhite: paper ? '#1F2328' : '#FFFFFF',
  };
}

function notify(): void { for (const l of listeners) l(); }

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  unsubs.push(window.electronAPI.onPtyData((id, data) => {
    entries.get(id)?.term.write(data);
  }));
  unsubs.push(window.electronAPI.onPtyExit((id, code) => {
    const e = entries.get(id);
    if (!e) return;
    e.info = { ...e.info, alive: false, exitCode: code };
    e.exitCode = code;
    e.term.write(`\r\n\x1b[2m(終了 code ${code})\x1b[0m\r\n`);
    notify();
  }));
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function list(): TermEntry[] {
  return order.map((id) => entries.get(id)).filter((e): e is TermEntry => !!e);
}

export function get(id: string): TermEntry | undefined { return entries.get(id); }

/** 新しいセッション(PTY + xterm)を作る */
export async function create(params: { title?: string; cwd?: string; command?: string[]; caseId?: string }): Promise<TermEntry> {
  ensureSubscribed();
  const element = document.createElement('div');
  element.className = 'h-full w-full';
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 12.5,
    lineHeight: 1.2,
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    theme: currentTheme(),
    allowTransparency: false,
    scrollback: 20000,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // いったん画面外で open して寸法を測れる状態にしておく(TerminalView が付け直す)
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:600px;';
  holder.appendChild(element);
  document.body.appendChild(holder);
  term.open(element);
  try { fit.fit(); } catch { /* 初回は未確定でもよい */ }
  const dims = fit.proposeDimensions();
  const info = await window.electronAPI.ptyCreate({ ...params, cols: dims?.cols ?? 120, rows: dims?.rows ?? 30 });
  holder.removeChild(element);
  holder.remove();
  const entry: TermEntry = { info, term, fit, element };
  imeGuard(term);
  term.onData((data) => { void window.electronAPI.ptyWrite(info.id, data); });
  term.onResize(({ cols, rows }) => { void window.electronAPI.ptyResize(info.id, cols, rows); });
  entries.set(info.id, entry);
  order.push(info.id);
  notify();
  return entry;
}

/** 終了したセッションを同じ cwd / command で作り直す(タブは同じ位置に) */
export async function restart(id: string): Promise<TermEntry | null> {
  const old = entries.get(id);
  if (!old) return null;
  const idx = order.indexOf(id);
  const entry = await create({ title: old.info.title, cwd: old.info.cwd, command: old.info.command, caseId: old.info.caseId });
  // 新しいものを旧位置へ
  const newIdx = order.indexOf(entry.info.id);
  if (newIdx >= 0) order.splice(newIdx, 1);
  order.splice(idx >= 0 ? idx : order.length, 0, entry.info.id);
  await destroy(id);
  return entry;
}

export async function destroy(id: string): Promise<void> {
  const e = entries.get(id);
  if (!e) return;
  try { await window.electronAPI.ptyDestroy(id); } catch { /* already gone */ }
  try { e.term.dispose(); } catch { /* ignore */ }
  e.element.remove();
  entries.delete(id);
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  notify();
}

/** main 側に残っているセッション(再起動後など)を取り込む。xterm は空のバッファで作る */
export async function adoptExisting(): Promise<void> {
  ensureSubscribed();
  let sessions: PtySession[] = [];
  try { sessions = await window.electronAPI.ptyList(); } catch { return; }
  for (const s of sessions) {
    if (entries.has(s.id)) continue;
    const element = document.createElement('div');
    element.className = 'h-full w-full';
    const term = new Terminal({ cursorBlink: true, fontSize: 12.5, lineHeight: 1.2, fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace', theme: currentTheme(), scrollback: 20000, macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:600px;';
    holder.appendChild(element);
    document.body.appendChild(holder);
    term.open(element);
    holder.removeChild(element);
    holder.remove();
    imeGuard(term);
    term.onData((data) => { void window.electronAPI.ptyWrite(s.id, data); });
    term.onResize(({ cols, rows }) => { void window.electronAPI.ptyResize(s.id, cols, rows); });
    if (!s.alive) term.write(`\x1b[2m(終了 code ${s.exitCode ?? '?'})\x1b[0m\r\n`);
    entries.set(s.id, { info: s, term, fit, element, exitCode: s.exitCode });
    order.push(s.id);
  }
  notify();
}

/** テーマが変わったら配色を差し替える */
export function applyTheme(): void {
  const theme = currentTheme();
  for (const e of entries.values()) e.term.options.theme = theme;
}

/** 選択中(無ければ生きている最初)のセッションへ文字列を送る(メール画面の「CLI へ送る」用) */
export async function writeToActive(data: string): Promise<boolean> {
  let id: string | null = null;
  try { id = localStorage.getItem('shirabe_terminal_active'); } catch { /* ignore */ }
  let e = (id && entries.get(id)) || null;
  if (!e || !e.info.alive) e = list().find((x) => x.info.alive) ?? null;
  if (!e) {
    try { e = await create({ title: 'シェル' }); } catch { return false; }
  }
  await window.electronAPI.ptyWrite(e.info.id, data);
  return true;
}

export function teardownSubscriptions(): void {
  for (const u of unsubs) u();
  unsubs = [];
  subscribed = false;
}
