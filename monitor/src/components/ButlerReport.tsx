import { useState, useEffect, useCallback } from 'react';
import type { NightlyDigest, ButlerEntry, ButlerActionKind, ViewType } from '../types';
import { openInEmClient } from '../utils/openInEmClient';

interface ButlerReportProps {
  onNavigate: (view: ViewType) => void;
}

// ---- Action-kind presentation ----
interface KindMeta {
  label: string;       // group heading label
  icon: string;        // emoji shown in heading
  bg: string;
  text: string;
  border: string;
}

// Auto-done (reversible) kinds — calm green/sky tones meaning "already done"
const AUTO_KIND_META: Record<Extract<ButlerActionKind, 'tagged' | 'quarantined' | 'draft_prepared'>, KindMeta> = {
  tagged:         { label: 'タグ付け',   icon: '🏷️', bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/25' },
  quarantined:    { label: '隔離',       icon: '🗂️', bg: 'bg-sky-500/10',     text: 'text-sky-400',     border: 'border-sky-500/25' },
  draft_prepared: { label: '下書き準備', icon: '✍️', bg: 'bg-teal-500/10',    text: 'text-teal-400',    border: 'border-teal-500/25' },
};

const AUTO_KIND_ORDER: Array<keyof typeof AUTO_KIND_META> = ['tagged', 'quarantined', 'draft_prepared'];

function formatRunAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCost(usd: number): string {
  if (!usd || usd <= 0) return '$0.00';
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

// ---- Draft preview (expandable) ----
function DraftBlock({ draft }: { draft: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-surface-400 hover:text-surface-200 transition-colors flex items-center gap-1"
      >
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        下書きを{open ? '隠す' : '見る'}
      </button>
      {open && (
        <pre className="mt-1.5 p-2.5 bg-surface-950 border border-surface-700/60 rounded text-[11px] leading-relaxed text-surface-300 whitespace-pre-wrap break-words max-h-72 overflow-y-auto font-sans">
          {draft}
        </pre>
      )}
    </div>
  );
}

// ---- One auto-done entry (report only) ----
function AutoEntryRow({ entry }: { entry: ButlerEntry }) {
  return (
    <li className="text-sm flex flex-col gap-0.5 py-1 px-2 rounded hover:bg-surface-800/30 transition-colors">
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-surface-200 line-clamp-1 flex-1 min-w-0">{entry.subject || '(件名なし)'}</span>
        {entry.tags && entry.tags.length > 0 && (
          <span className="flex gap-1 flex-shrink-0">
            {entry.tags.slice(0, 3).map((t) => (
              <span key={t} className="text-[9px] px-1 py-px rounded bg-surface-700/70 text-surface-300 border border-surface-600/50">
                {t}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-surface-500 min-w-0">
        <span className="line-clamp-1 flex-shrink-0 max-w-[40%]">{entry.from}</span>
        {entry.detail && (
          <>
            <span className="text-surface-600">·</span>
            <span className="line-clamp-1 italic">{entry.detail}</span>
          </>
        )}
      </div>
    </li>
  );
}

// ---- Auto-done section (grouped by kind) ----
function AutoDoneSection({ entries }: { entries: ButlerEntry[] }) {
  const groups = AUTO_KIND_ORDER
    .map((kind) => ({ kind, meta: AUTO_KIND_META[kind], items: entries.filter((e) => e.kind === kind) }))
    .filter((g) => g.items.length > 0);

  // Anything that came through as reversible but with an unexpected kind
  const knownKinds = new Set<ButlerActionKind>(AUTO_KIND_ORDER);
  const other = entries.filter((e) => !knownKinds.has(e.kind));

  if (entries.length === 0) return null;

  return (
    <div className="bg-emerald-500/[0.04] rounded-lg border border-emerald-500/20 p-3">
      <h3 className="text-sm font-medium text-emerald-400 mb-2 flex items-center gap-2">
        <span>✅</span>
        自動でやっておきました
        <span className="text-[11px] font-normal text-emerald-500/70 ml-auto px-1.5 py-px rounded-full bg-emerald-500/10 border border-emerald-500/20">
          完了 {entries.length} 件
        </span>
      </h3>

      {/* Per-kind summary chips */}
      <div className="flex flex-wrap gap-1.5 mb-2.5">
        {groups.map((g) => (
          <span
            key={g.kind}
            className={`text-[11px] px-2 py-0.5 rounded-full border ${g.meta.bg} ${g.meta.text} ${g.meta.border}`}
          >
            {g.meta.icon} {g.meta.label} {g.items.length}件
          </span>
        ))}
      </div>

      <div className="space-y-2.5">
        {groups.map((g) => (
          <div key={g.kind}>
            <h4 className={`text-[11px] font-medium mb-0.5 ${g.meta.text}`}>
              {g.meta.icon} {g.meta.label}
            </h4>
            <ul className="space-y-0.5">
              {g.items.map((entry, i) => (
                <AutoEntryRow key={`${entry.mailId}-${i}`} entry={entry} />
              ))}
            </ul>
          </div>
        ))}
        {other.length > 0 && (
          <div>
            <h4 className="text-[11px] font-medium mb-0.5 text-surface-400">その他</h4>
            <ul className="space-y-0.5">
              {other.map((entry, i) => (
                <AutoEntryRow key={`other-${entry.mailId}-${i}`} entry={entry} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- One approval card (irreversible) ----
function ApprovalCard({
  entry,
  onApprove,
  busy,
  resolved,
}: {
  entry: ButlerEntry;
  onApprove: (entry: ButlerEntry, approved: boolean) => void;
  busy: boolean;
  resolved: { approved: boolean } | null;
}) {
  const isDelete = entry.kind === 'await_delete';

  // Resolved state — show a quiet confirmation instead of buttons
  if (resolved) {
    return (
      <div className="rounded-lg border border-surface-700/50 bg-surface-900/60 p-3 opacity-70">
        <div className="flex items-start gap-2">
          <span className="text-xs flex-shrink-0 mt-0.5">{resolved.approved ? '✅' : '↩️'}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-surface-400 line-clamp-1 line-through">{entry.subject || '(件名なし)'}</p>
            <p className="text-[11px] text-surface-500 mt-0.5">
              {resolved.approved
                ? (isDelete ? 'ゴミ箱へ移動しました' : '送信を承認しました')
                : (isDelete ? '残しました' : '下書きのままにしました')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3">
      {/* Kind badge + subject */}
      <div className="flex items-start gap-2">
        <span
          className={`text-[10px] px-1.5 py-px rounded border flex-shrink-0 mt-0.5 ${
            isDelete
              ? 'bg-red-500/15 text-red-400 border-red-500/30'
              : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
          }`}
        >
          {isDelete ? '削除候補' : '送信候補'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-surface-100 line-clamp-2">{entry.subject || '(件名なし)'}</p>
          <p className="text-[11px] text-surface-500 mt-0.5 line-clamp-1">{entry.from}</p>
        </div>
        {typeof entry.confidence === 'number' && (
          <span className="text-[10px] text-surface-500 flex-shrink-0 font-mono mt-0.5">
            {Math.round(entry.confidence * 100)}%
          </span>
        )}
      </div>

      {/* Reasoning */}
      {entry.detail && (
        <p className="text-[12px] text-surface-400 mt-2 leading-relaxed">{entry.detail}</p>
      )}

      {/* Draft (for await_send) */}
      {entry.draft && <DraftBlock draft={entry.draft} />}

      {/* Action buttons */}
      <div className="flex items-center gap-2 mt-3">
        {isDelete ? (
          <>
            <button
              onClick={() => onApprove(entry, true)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              🗑️ ゴミ箱へ
            </button>
            <button
              onClick={() => onApprove(entry, false)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              残す
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => {
                onApprove(entry, true);
                openInEmClient({ subject: entry.subject, fromAddress: entry.from });
              }}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              📨 eM Clientで開く
            </button>
            <button
              onClick={() => onApprove(entry, false)}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下書きのまま
            </button>
          </>
        )}
        {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-surface-600 border-t-amber-400 animate-spin" />}
      </div>
    </div>
  );
}

// ---- Approval section ----
function ApprovalSection({
  entries,
  onApprove,
  busyKeys,
  resolvedMap,
}: {
  entries: ButlerEntry[];
  onApprove: (entry: ButlerEntry, approved: boolean) => void;
  busyKeys: Set<string>;
  resolvedMap: Map<string, { approved: boolean }>;
}) {
  if (entries.length === 0) return null;
  const pendingCount = entries.filter((e) => !resolvedMap.has(entryKey(e))).length;
  return (
    <div className="bg-amber-500/[0.05] rounded-lg border border-amber-500/30 p-3">
      <h3 className="text-sm font-medium text-amber-400 mb-2.5 flex items-center gap-2">
        <span>🙋</span>
        承認をお願いします
        <span className="text-[11px] font-normal text-amber-400/80 ml-auto px-1.5 py-px rounded-full bg-amber-500/15 border border-amber-500/30">
          要承認 {pendingCount} 件
        </span>
      </h3>
      <div className="grid grid-cols-1 gap-2.5">
        {entries.map((entry, i) => {
          const key = entryKey(entry);
          return (
            <ApprovalCard
              key={`${key}-${i}`}
              entry={entry}
              onApprove={onApprove}
              busy={busyKeys.has(key)}
              resolved={resolvedMap.get(key) ?? null}
            />
          );
        })}
      </div>
    </div>
  );
}

function entryKey(e: ButlerEntry): string {
  return `${e.accountEmail}::${e.mailId}::${e.kind}`;
}

// ================= Main component =================
export default function ButlerReport({ onNavigate }: ButlerReportProps) {
  const [digest, setDigest] = useState<NightlyDigest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [resolvedMap, setResolvedMap] = useState<Map<string, { approved: boolean }>>(new Map());

  // Initial load + subscribe to live updates
  useEffect(() => {
    let mounted = true;
    window.electronAPI
      .getLatestDigest()
      .then((d) => {
        if (mounted) {
          setDigest(d);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (mounted) setLoaded(true);
      });

    const unsubscribe = window.electronAPI.onDigestUpdated((d) => {
      setDigest(d);
      // A fresh digest supersedes prior local approval state
      setResolvedMap(new Map());
      setBusyKeys(new Set());
      setTriggering(false);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const runNow = useCallback(async () => {
    setTriggering(true);
    try {
      const d = await window.electronAPI.runButlerPipeline({ force: true });
      setDigest(d);
    } catch {
      // Errors surface via the digest.errors channel; keep UI resilient.
    } finally {
      setTriggering(false);
    }
  }, []);

  const handleApprove = useCallback(async (entry: ButlerEntry, approved: boolean) => {
    const key = entryKey(entry);
    const kind: 'delete' | 'send' = entry.kind === 'await_delete' ? 'delete' : 'send';
    setBusyKeys((prev) => new Set(prev).add(key));
    try {
      const res = await window.electronAPI.approveButlerItem({
        mailId: entry.mailId,
        accountEmail: entry.accountEmail,
        kind,
        approved,
      });
      if (res.status !== 'error') {
        setResolvedMap((prev) => new Map(prev).set(key, { approved }));
      }
    } catch {
      // leave card actionable on failure
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const running = triggering || digest?.running === true;
  const autoDone = digest?.autoDone ?? [];
  const awaiting = digest?.awaitingApproval ?? [];
  const isEmpty = !digest || (autoDone.length === 0 && awaiting.length === 0 && (digest.processedCount ?? 0) === 0);

  // ---- Off / unconfigured state ----
  // Show the "off" guidance only once we've actually checked (avoids a flash),
  // and only when there's truly nothing to report.
  if (loaded && isEmpty && !running) {
    return (
      <section className="mb-4 bg-surface-900 rounded-lg border border-surface-700/50 p-4">
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none mt-0.5">🌙</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-surface-200">夜間執事レポート</h2>
            <p className="text-sm text-surface-500 mt-1 leading-relaxed">
              夜間執事はまだオフです。設定で有効化すると、夜のうちにメールを仕分けます。
            </p>
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={() => onNavigate('settings')}
                className="px-3 py-1.5 bg-accent-500/20 hover:bg-accent-500/30 border border-accent-500/30 rounded-lg text-xs text-accent-400 transition-colors"
              >
                設定で有効化 →
              </button>
              <button
                onClick={runNow}
                disabled={running}
                className="px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-xs text-surface-300 transition-colors disabled:opacity-40"
              >
                今すぐ試す
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  // While the very first check is still pending and nothing is running, render nothing
  // (the rest of the dashboard loads normally underneath).
  if (!loaded && !digest) return null;

  return (
    <section className="mb-4 bg-surface-900/80 rounded-lg border border-surface-700/60 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-surface-100 flex items-center gap-2">
            <span>🌙</span>
            夜間執事レポート
          </h2>
          <div className="flex items-center gap-2.5 mt-1 text-[11px] text-surface-500 flex-wrap">
            {digest?.runAt && (
              <span className="flex items-center gap-1">
                <span className="text-surface-600">実行</span>
                {formatRunAt(digest.runAt)}
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="text-surface-600">処理</span>
              {digest?.processedCount ?? 0} 件
            </span>
            <span className="flex items-center gap-1">
              <span className="text-surface-600">コスト</span>
              {formatCost(digest?.costUsd ?? 0)}
            </span>
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-xs text-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 flex-shrink-0"
        >
          {running && <span className="w-3 h-3 rounded-full border-2 border-surface-600 border-t-surface-300 animate-spin" />}
          {running ? '実行中…' : '今すぐ実行'}
        </button>
      </div>

      {/* Running banner */}
      {running && (
        <div className="mb-3 px-3 py-2 bg-surface-800/60 border border-surface-700/50 rounded-lg flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-xs text-surface-400">夜間執事が新着メールを仕分け中です…</span>
        </div>
      )}

      {/* Errors (if any) */}
      {digest?.errors && digest.errors.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-[11px] font-medium text-red-400 mb-0.5">一部の処理でエラーが発生しました</p>
          <ul className="text-[11px] text-red-400/80 space-y-0.5 list-disc list-inside">
            {digest.errors.slice(0, 4).map((e, i) => (
              <li key={i} className="line-clamp-1">{e}</li>
            ))}
            {digest.errors.length > 4 && <li>…他 {digest.errors.length - 4} 件</li>}
          </ul>
        </div>
      )}

      {/* Body */}
      <div className="space-y-3">
        <ApprovalSection
          entries={awaiting}
          onApprove={handleApprove}
          busyKeys={busyKeys}
          resolvedMap={resolvedMap}
        />
        <AutoDoneSection entries={autoDone} />

        {/* Nothing actionable but pipeline did run */}
        {autoDone.length === 0 && awaiting.length === 0 && !running && (
          <p className="text-sm text-surface-500 px-1 py-2">
            今回は対応が必要な項目はありませんでした。{(digest?.processedCount ?? 0) > 0 ? `（${digest!.processedCount}件を確認）` : ''}
          </p>
        )}
      </div>
    </section>
  );
}
