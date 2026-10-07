import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '../context/AppContext';
import * as store from '../components/terminal/terminalStore';
import type { TermEntry } from '../components/terminal/terminalStore';
import { GhostButton, Icon, useToast } from '../components/partner/partnerUi';

// =====================================================================
// アプリ内ターミナル — タブ式の複数セッション。
//   「作業に移る」の [アプリ内で Claude Code] は localStorage 'shirabe_pending_pty' 経由でここに来る。
//   ⌘T 新しいシェル / ⌘W 現在のタブを閉じる
// =====================================================================

const LS_PENDING = 'shirabe_pending_pty';
const LS_ACTIVE = 'shirabe_terminal_active';

interface PendingPty { cwd?: string; command?: string[]; title?: string; caseId?: string }

export default function TerminalView() {
  const { settings } = useAppContext();
  const [, bump] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(() => { try { return localStorage.getItem(LS_ACTIVE); } catch { return null; } });
  const [booting, setBooting] = useState(true);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { toast, flash } = useToast();
  const entries = store.list();
  const active = (activeId && store.get(activeId)) || entries[0] || null;

  // ストアの変化で再描画
  useEffect(() => store.subscribe(() => bump((n) => n + 1)), []);

  // 初回: 既存セッションの取り込み → 保留中の起動要求 → 無ければシェル 1 本
  useEffect(() => {
    let alive = true;
    (async () => {
      await store.adoptExisting();
      let pending: PendingPty | null = null;
      try {
        const raw = localStorage.getItem(LS_PENDING);
        if (raw) { pending = JSON.parse(raw) as PendingPty; localStorage.removeItem(LS_PENDING); }
      } catch { /* ignore */ }
      if (pending) {
        try {
          const e = await store.create({ title: pending.title, cwd: pending.cwd, command: pending.command, caseId: pending.caseId });
          if (alive) setActiveId(e.info.id);
        } catch (err) {
          flash(`起動できませんでした: ${(err as Error).message}`);
        }
      } else if (store.list().length === 0) {
        try {
          const e = await store.create({ title: 'シェル' });
          if (alive) setActiveId(e.info.id);
        } catch (err) {
          flash(`シェルを開けませんでした: ${(err as Error).message}`);
        }
      }
      if (alive) setBooting(false);
    })();
    return () => { alive = false; };
  }, []);

  // 表示中のビューに来たら、保留中の起動要求を拾う(既にマウント済みで再訪したとき)
  useEffect(() => {
    const onFocus = async () => {
      let pending: PendingPty | null = null;
      try {
        const raw = localStorage.getItem(LS_PENDING);
        if (raw) { pending = JSON.parse(raw) as PendingPty; localStorage.removeItem(LS_PENDING); }
      } catch { /* ignore */ }
      if (!pending) return;
      try {
        const e = await store.create({ title: pending.title, cwd: pending.cwd, command: pending.command, caseId: pending.caseId });
        setActiveId(e.info.id);
      } catch (err) {
        flash(`起動できませんでした: ${(err as Error).message}`);
      }
    };
    window.addEventListener('storage', onFocus);
    return () => window.removeEventListener('storage', onFocus);
  }, [flash]);

  // テーマ追従
  useEffect(() => { store.applyTheme(); }, [settings.theme]);

  // 選択タブの DOM を付け替え、サイズを合わせる
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const e of store.list()) {
      if (e.element.parentElement !== host) host.appendChild(e.element);
      e.element.style.display = active && e.info.id === active.info.id ? 'block' : 'none';
    }
    if (active) {
      requestAnimationFrame(() => {
        try { active.fit.fit(); } catch { /* ignore */ }
        active.term.focus();
      });
      try { localStorage.setItem(LS_ACTIVE, active.info.id); } catch { /* ignore */ }
    }
  }, [active, entries.length]);

  // ホストのサイズ変化で fit
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const a = (activeId && store.get(activeId)) || store.list()[0];
      if (a) { try { a.fit.fit(); } catch { /* ignore */ } }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [activeId]);

  const newShell = useCallback(async () => {
    try {
      const e = await store.create({ title: 'シェル' });
      setActiveId(e.info.id);
    } catch (err) {
      flash(`シェルを開けませんでした: ${(err as Error).message}`);
    }
  }, [flash]);

  const closeTab = useCallback(async (id: string) => {
    const list = store.list();
    const idx = list.findIndex((e) => e.info.id === id);
    await store.destroy(id);
    const rest = store.list();
    if (activeId === id) setActiveId(rest[Math.max(0, idx - 1)]?.info.id ?? rest[0]?.info.id ?? null);
  }, [activeId]);

  const retry = useCallback(async (id: string) => {
    const e = await store.restart(id);
    if (e) setActiveId(e.info.id);
  }, []);

  // ⌘T / ⌘W
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 't') { e.preventDefault(); void newShell(); }
      if (e.key === 'w') { e.preventDefault(); if (active) void closeTab(active.info.id); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [newShell, closeTab, active]);

  return (
    <div className="h-full flex flex-col bg-paper">
      {toast && <div className="absolute top-14 right-6 z-30 px-3 py-1.5 bg-ink text-paper rounded-md text-[12px] shadow-card">{toast}</div>}
      {/* タブ列 */}
      <div className="flex items-end gap-1 px-3 pt-2 border-b border-hairline bg-paper-2 app-no-drag">
        {entries.map((e) => <Tab key={e.info.id} e={e} active={!!active && e.info.id === active.info.id} onSelect={() => setActiveId(e.info.id)} onClose={() => closeTab(e.info.id)} onRetry={() => retry(e.info.id)} />)}
        <span className="flex-1" />
        <GhostButton onClick={newShell} title="新しいシェル(⌘T)">{Icon.plus}シェル</GhostButton>
      </div>
      {/* 本体 */}
      <div className="flex-1 min-h-0 relative bg-card">
        <div ref={hostRef} className="absolute inset-0 p-2" />
        {!booting && entries.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-3 text-[12.5px]">
            <span>セッションがありません</span>
            <GhostButton onClick={newShell}>{Icon.plus}シェルを開く</GhostButton>
          </div>
        )}
      </div>
      <div className="h-7 flex items-center gap-3 px-3 border-t border-hairline bg-paper-2 text-[11px] text-ink-3 tnum">
        {active && (
          <>
            <span className="truncate" title={active.info.cwd}>{active.info.cwd}</span>
            {active.info.command && <span className="truncate text-ink-2">{active.info.command[0]}</span>}
            <span className="ml-auto">⌘T 新しいシェル · ⌘W 閉じる</span>
          </>
        )}
      </div>
    </div>
  );
}

function Tab({ e, active, onSelect, onClose, onRetry }: { e: TermEntry; active: boolean; onSelect: () => void; onClose: () => void; onRetry: () => void }) {
  const dead = !e.info.alive;
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`group flex items-center gap-1.5 h-8 pl-3 pr-1.5 rounded-t-md border border-b-0 text-[12px] cursor-default select-none max-w-[220px] ${
        active ? 'bg-card border-hairline text-ink' : 'bg-transparent border-transparent text-ink-2 hover:bg-card-2'
      }`}
      title={e.info.cwd}
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dead ? 'bg-ink-3' : 'bg-ok'}`} />
      <span className="truncate">{e.info.title}</span>
      {dead && <span className="text-[10.5px] text-ink-3 flex-shrink-0">(終了{typeof e.exitCode === 'number' ? ` ${e.exitCode}` : ''})</span>}
      {dead && (
        <button onClick={(ev) => { ev.stopPropagation(); onRetry(); }} className="text-[10.5px] px-1 rounded text-primary hover:bg-primary-soft" title="同じ場所・同じコマンドで作り直す">もう一度</button>
      )}
      <button onClick={(ev) => { ev.stopPropagation(); onClose(); }} className="w-5 h-5 rounded flex items-center justify-center text-ink-3 hover:text-ink hover:bg-card-2 opacity-0 group-hover:opacity-100 aria-selected:opacity-100" aria-label="閉じる" title="閉じる(⌘W)">×</button>
    </div>
  );
}
