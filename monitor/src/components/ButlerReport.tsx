import { useState, useEffect, useCallback, useMemo } from 'react';
import type { NightlyDigest, ButlerCase, ButlerGroup, ButlerCaseStatus, ButlerPriority, SenderTier, ViewType } from '../types';
import { openInEmClient } from '../utils/openInEmClient';

// =====================================================================
// 夜間執事レポート v2 — 「朝、開いたら仕分け済み。残るのは判断だけ」
//   1. 申し送り(秘書の一言)
//   2. 今日動く(P1) / 今週中(P2) の案件カード: 要件・期限・根拠・下書き
//   3. 承認待ち(迷惑メールの一括削除)
//   4. 参考まで / 後で / 除外したノイズ(折りたたみ)
// =====================================================================

interface ButlerReportProps {
  onNavigate: (view: ViewType) => void;
}

interface Progress { stage: string; message: string; done?: number; total?: number }

// ---- 表示メタ ----
const PRIORITY_META: Record<ButlerPriority, { label: string; cls: string }> = {
  P1: { label: '今日', cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  P2: { label: '今週', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  P3: { label: 'いずれ', cls: 'bg-surface-700 text-surface-300 border-surface-600' },
  P4: { label: '参考', cls: 'bg-surface-800 text-surface-500 border-surface-700' },
};

const CATEGORY_META: Record<string, { label: string; cls: string }> = {
  reply: { label: '要返信', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  action: { label: '要対応', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  fyi: { label: '情報', cls: 'bg-sky-500/10 text-sky-400 border-sky-500/25' },
  noise: { label: '不要', cls: 'bg-surface-800 text-surface-500 border-surface-700' },
  spam: { label: '迷惑', cls: 'bg-red-500/10 text-red-400 border-red-500/25' },
  unknown: { label: '未判定', cls: 'bg-surface-800 text-surface-500 border-surface-700' },
};

const TIER_META: Record<SenderTier, { label: string; cls: string }> = {
  vip: { label: '常連', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  internal: { label: '学内', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' },
  known: { label: '面識あり', cls: 'bg-sky-500/10 text-sky-300 border-sky-500/25' },
  auto: { label: '自動送信', cls: 'bg-surface-800 text-surface-500 border-surface-700' },
  unknown: { label: '初見', cls: 'bg-surface-800 text-surface-400 border-surface-700' },
  noise: { label: '不要(学習)', cls: 'bg-surface-800 text-surface-500 border-surface-700' },
};

function fmtRunAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtReceived(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function daysLeft(deadline: string | null): number | null {
  if (!deadline) return null;
  const t = new Date(`${deadline}T00:00:00`);
  if (isNaN(t.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t.getTime() - today.getTime()) / 86_400_000);
}

function DeadlineChip({ deadline }: { deadline: string | null }) {
  if (!deadline) return null;
  const d = daysLeft(deadline);
  const [, m, day] = deadline.split('-');
  const label = `${Number(m)}/${Number(day)}`;
  let cls = 'bg-surface-800 text-surface-400 border-surface-700';
  let tail = '';
  if (d !== null) {
    if (d < 0) { cls = 'bg-red-500/20 text-red-300 border-red-500/40'; tail = `${-d}日超過`; }
    else if (d === 0) { cls = 'bg-red-500/20 text-red-300 border-red-500/40'; tail = '今日'; }
    else if (d <= 2) { cls = 'bg-red-500/15 text-red-400 border-red-500/30'; tail = `あと${d}日`; }
    else if (d <= 7) { cls = 'bg-amber-500/15 text-amber-400 border-amber-500/30'; tail = `あと${d}日`; }
    else tail = `あと${d}日`;
  }
  return (
    <span className={`text-[10px] px-1.5 py-px rounded border font-mono flex-shrink-0 ${cls}`}>
      期限 {label}{tail ? ` · ${tail}` : ''}
    </span>
  );
}

function Chip({ label, cls }: { label: string; cls: string }) {
  return <span className={`text-[10px] px-1.5 py-px rounded border flex-shrink-0 ${cls}`}>{label}</span>;
}

function Spinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-2 border-surface-600 border-t-surface-200 animate-spin" />;
}

// ---- 案件カード ----
interface CaseCardProps {
  c: ButlerCase;
  compact?: boolean;
  busy: boolean;
  onStatus: (c: ButlerCase, status: ButlerCaseStatus) => void;
  onRule: (c: ButlerCase, tier: 'vip' | 'noise' | null) => void;
  onDraft: (c: ButlerCase, instruction?: string) => void;
}

function CaseCard({ c, compact, busy, onStatus, onRule, onDraft }: CaseCardProps) {
  const [open, setOpen] = useState(!compact);
  const [showDraft, setShowDraft] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const pm = PRIORITY_META[c.priority] ?? PRIORITY_META.P3;
  const cm = CATEGORY_META[c.category] ?? CATEGORY_META.unknown;
  const tm = TIER_META[c.senderTier] ?? TIER_META.unknown;

  const openCompose = async () => {
    const subject = /^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`;
    try {
      await window.electronAPI.openMailCompose({ to: c.fromAddress, subject, body: c.draft ?? '' });
    } catch { /* toast is overkill here */ }
  };
  const copyDraft = async () => {
    if (!c.draft) return;
    try {
      await navigator.clipboard.writeText(c.draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const border = c.priority === 'P1' ? 'border-red-500/30' : c.priority === 'P2' ? 'border-amber-500/25' : 'border-surface-700/60';
  const bg = c.priority === 'P1' ? 'bg-red-500/[0.04]' : c.priority === 'P2' ? 'bg-amber-500/[0.03]' : 'bg-surface-900/60';

  return (
    <div className={`rounded-lg border ${border} ${bg} p-3 transition-colors`}>
      {/* ヘッダ行 */}
      <div className="flex items-start gap-2 min-w-0">
        <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
          <Chip label={pm.label} cls={pm.cls} />
          <Chip label={cm.label} cls={cm.cls} />
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-sm text-surface-100 text-left flex-1 min-w-0 line-clamp-2 hover:text-white"
          title={c.subject}
        >
          {c.subject || '(件名なし)'}
        </button>
        <span className="text-[10px] text-surface-500 font-mono flex-shrink-0 mt-0.5">{fmtReceived(c.receivedAt)}</span>
      </div>

      {/* 差出人・要件 */}
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-surface-500 min-w-0 flex-wrap">
        <Chip label={tm.label} cls={tm.cls} />
        <span className="line-clamp-1 max-w-[55%]">{c.from}</span>
        {c.threadCount > 1 && (
          <span className="text-surface-600">· スレッド{c.threadCount}通{c.myRepliesInThread > 0 ? `・返信${c.myRepliesInThread}` : ''}</span>
        )}
        {c.aiSource === 'fallback' && <Chip label="暫定" cls="bg-surface-800 text-surface-500 border-surface-700" />}
      </div>

      {(c.ask || c.deadline) && (
        <div className="mt-2 flex items-start gap-2">
          <span className="text-[11px] text-surface-500 flex-shrink-0 mt-0.5">要件</span>
          <p className="text-sm text-surface-200 flex-1 min-w-0 leading-snug">{c.ask || c.suggestedAction}</p>
          <DeadlineChip deadline={c.deadline} />
        </div>
      )}

      {/* 展開部 */}
      {open && (
        <div className="mt-2 space-y-1.5">
          {c.summary && <p className="text-[12px] text-surface-400 leading-relaxed">{c.summary}</p>}
          {c.reason && <p className="text-[11px] text-surface-500 italic leading-relaxed">根拠: {c.reason}</p>}
          {c.draftHint && !c.draft && <p className="text-[11px] text-surface-500 leading-relaxed">下書きの方針: {c.draftHint}</p>}
        </div>
      )}

      {/* アクション */}
      {c.status !== 'done' && c.status !== 'dismissed' && (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          {c.draft ? (
            <button
              onClick={() => setShowDraft((v) => !v)}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 transition-colors"
            >
              ✍️ 返信案を{showDraft ? '閉じる' : '見る'}
            </button>
          ) : (c.category === 'reply' || c.needsDraft) ? (
            <button
              onClick={() => onDraft(c)}
              disabled={busy}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy && <Spinner />}✍️ 返信案を作る
            </button>
          ) : null}
          <button
            onClick={() => openInEmClient({ subject: c.subject, fromAddress: c.fromAddress })}
            className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 transition-colors"
          >
            📨 eM Clientで開く
          </button>
          <button
            onClick={() => onStatus(c, 'done')}
            disabled={busy}
            className="px-2.5 py-1 rounded-md text-xs bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/25 transition-colors disabled:opacity-40"
          >
            ✓ 対応済み
          </button>
          {c.status !== 'later' && (
            <button
              onClick={() => onStatus(c, 'later')}
              disabled={busy}
              className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-400 border border-surface-700/60 transition-colors disabled:opacity-40"
            >
              ⏰ 後で
            </button>
          )}
          <div className="relative ml-auto">
            <button
              onClick={() => setMenu((v) => !v)}
              className="px-2 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-400 border border-surface-700/60 transition-colors"
              title="この送信者の扱いを教える"
            >
              ⋯
            </button>
            {menu && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-surface-900 border border-surface-700 rounded-md shadow-lg p-1 min-w-[190px]">
                <button onClick={() => { setMenu(false); onRule(c, 'vip'); }} className="block w-full text-left px-2.5 py-1.5 text-xs text-surface-200 hover:bg-surface-800 rounded">
                  ⭐ この人は常に重要
                </button>
                <button onClick={() => { setMenu(false); onRule(c, 'noise'); }} className="block w-full text-left px-2.5 py-1.5 text-xs text-surface-200 hover:bg-surface-800 rounded">
                  🚫 この人のメールは不要
                </button>
                {c.senderTier === 'vip' || c.senderTier === 'noise' ? (
                  <button onClick={() => { setMenu(false); onRule(c, null); }} className="block w-full text-left px-2.5 py-1.5 text-xs text-surface-400 hover:bg-surface-800 rounded">
                    指定を解除
                  </button>
                ) : null}
                {c.draft && (
                  <button onClick={() => { setMenu(false); onDraft(c, '別の案を'); }} className="block w-full text-left px-2.5 py-1.5 text-xs text-surface-200 hover:bg-surface-800 rounded">
                    🔁 返信案を作り直す
                  </button>
                )}
                <button onClick={() => { setMenu(false); onStatus(c, 'dismissed'); }} className="block w-full text-left px-2.5 py-1.5 text-xs text-surface-400 hover:bg-surface-800 rounded">
                  この案件を消す
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 下書き */}
      {showDraft && c.draft && (
        <div className="mt-2">
          <pre className="p-2.5 bg-surface-950 border border-surface-700/60 rounded text-[12px] leading-relaxed text-surface-200 whitespace-pre-wrap break-words max-h-80 overflow-y-auto font-sans">
            {c.draft}
          </pre>
          <div className="flex items-center gap-1.5 mt-1.5">
            <button onClick={openCompose} className="px-2.5 py-1 rounded-md text-xs font-medium bg-accent-500/20 hover:bg-accent-500/30 text-accent-400 border border-accent-500/30 transition-colors">
              📝 この下書きで作成フォームを開く
            </button>
            <button onClick={copyDraft} className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 transition-colors">
              {copied ? 'コピーしました' : 'コピー'}
            </button>
            <button onClick={() => onDraft(c, 'もう少し丁寧に')} disabled={busy} className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-400 border border-surface-700/60 transition-colors disabled:opacity-40">
              丁寧に
            </button>
            <button onClick={() => onDraft(c, 'もっと短く')} disabled={busy} className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-400 border border-surface-700/60 transition-colors disabled:opacity-40">
              短く
            </button>
            {busy && <Spinner />}
            <span className="text-[10px] text-surface-600 ml-auto">送信はしません。フォームで確認してから送ってください</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 一括承認グループ ----
function GroupCard({ g, busy, onApprove, onNavigate, onRule }: {
  g: ButlerGroup;
  busy: boolean;
  onApprove: (g: ButlerGroup, approved: boolean) => void;
  onNavigate: (view: ViewType) => void;
  onRule: (address: string, tier: 'vip' | 'noise' | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSpam = g.kind === 'spam_delete';
  const resolved = g.status === 'approved' || g.status === 'rejected';
  const noImap = g.error?.includes('IMAP');
  const addrOf = (from: string) => from.match(/<([^>]+)>/)?.[1] ?? from;

  return (
    <div className={`rounded-lg border p-3 ${isSpam ? 'border-red-500/25 bg-red-500/[0.04]' : 'border-surface-700/60 bg-surface-900/50'} ${resolved ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <span className="text-sm flex-shrink-0">{isSpam ? '🗑️' : '📭'}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-surface-100">
            {g.label} <span className="text-surface-400">— {g.items.length}通</span>
          </p>
          <p className="text-[11px] text-surface-500 mt-0.5">{g.reason}</p>
          {g.error && <p className="text-[11px] text-red-400 mt-1">{g.error}</p>}
          <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-surface-500 hover:text-surface-300 mt-1 flex items-center gap-1">
            <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
            内容を{open ? '隠す' : '見る'}
          </button>
          {open && (
            <ul className="mt-1.5 space-y-0.5 max-h-56 overflow-y-auto pr-1">
              {g.items.map((it) => (
                <li key={`${it.accountEmail}-${it.mailId}`} className="text-[11px] text-surface-400 flex items-center gap-2 min-w-0">
                  <span className="line-clamp-1 flex-1 min-w-0">{it.subject || '(件名なし)'}</span>
                  <span className="text-surface-600 line-clamp-1 max-w-[40%]">{it.from}</span>
                  {!isSpam && (
                    <button onClick={() => onRule(addrOf(it.from), 'vip')} className="text-[10px] text-surface-500 hover:text-violet-300 flex-shrink-0" title="この送信者を常に重要にする">
                      ⭐重要
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {isSpam && !resolved && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {noImap ? (
              <button onClick={() => onNavigate('settings')} className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60">
                IMAP設定へ
              </button>
            ) : (
              <button onClick={() => onApprove(g, true)} disabled={busy} className="px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 disabled:opacity-40 flex items-center gap-1.5">
                {busy && <Spinner />}すべてゴミ箱へ
              </button>
            )}
            <button onClick={() => onApprove(g, false)} disabled={busy} className="px-2.5 py-1 rounded-md text-xs bg-surface-800 hover:bg-surface-700 text-surface-300 border border-surface-700/60 disabled:opacity-40">
              残す
            </button>
          </div>
        )}
        {isSpam && resolved && (
          <span className="text-[11px] text-surface-500 flex-shrink-0">{g.status === 'approved' ? 'ゴミ箱へ移動済み' : '残しました'}</span>
        )}
      </div>
    </div>
  );
}

// ---- セクション ----
function Section({ title, icon, count, tone, children, defaultOpen = true, hint }: {
  title: string; icon: string; count: number; tone: 'red' | 'amber' | 'sky' | 'neutral' | 'emerald';
  children: React.ReactNode; defaultOpen?: boolean; hint?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneCls = {
    red: 'text-red-400 border-red-500/25 bg-red-500/[0.03]',
    amber: 'text-amber-400 border-amber-500/25 bg-amber-500/[0.03]',
    sky: 'text-sky-400 border-sky-500/20 bg-sky-500/[0.03]',
    emerald: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/[0.03]',
    neutral: 'text-surface-400 border-surface-700/60 bg-surface-900/40',
  }[tone];
  return (
    <div className={`rounded-lg border p-3 ${toneCls}`}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 text-sm font-medium">
        <span>{icon}</span>
        <span>{title}</span>
        <span className="text-[11px] font-normal opacity-80 px-1.5 py-px rounded-full border border-current/30">{count} 件</span>
        {hint && <span className="text-[11px] font-normal text-surface-500 ml-1">{hint}</span>}
        <span className={`ml-auto text-[10px] opacity-60 transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
      </button>
      {open && <div className="mt-2.5 space-y-2">{children}</div>}
    </div>
  );
}

// ================= Main =================
export default function ButlerReport({ onNavigate }: ButlerReportProps) {
  const [digest, setDigest] = useState<NightlyDigest | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.getLatestDigest()
      .then((d) => { if (mounted) { setDigest(d); setLoaded(true); } })
      .catch(() => { if (mounted) setLoaded(true); });
    const un1 = window.electronAPI.onDigestUpdated((d) => {
      setDigest(d);
      setTriggering(false);
      setProgress(null);
      setBusy(new Set());
    });
    const un2 = window.electronAPI.onButlerProgress((p) => {
      setProgress(p);
      if (p.stage === 'done' || p.stage === 'error') setTimeout(() => setProgress(null), 4000);
    });
    return () => { mounted = false; un1(); un2(); };
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try { await fn(); } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, []);

  const runNow = useCallback(async () => {
    setTriggering(true);
    setProgress({ stage: 'collect', message: '準備しています…' });
    try {
      const d = await window.electronAPI.runButlerPipeline({ force: true });
      setDigest(d);
    } catch (e) {
      flash(e instanceof Error ? e.message : '実行に失敗しました');
    } finally {
      setTriggering(false);
    }
  }, []);

  const onStatus = useCallback((c: ButlerCase, status: ButlerCaseStatus) => withBusy(c.id, async () => {
    const res = await window.electronAPI.updateButlerCase({ caseId: c.id, status });
    if (res.status === 'error') flash(res.error ?? '更新に失敗しました');
    else setDigest((prev) => prev ? { ...prev, cases: (prev.cases ?? []).map((x) => x.id === c.id ? { ...x, status } : x) } : prev);
  }), [withBusy]);

  const onRuleAddr = useCallback((address: string, tier: 'vip' | 'noise' | null) => withBusy(`rule:${address}`, async () => {
    await window.electronAPI.setButlerSenderRule({ address, tier });
    flash(tier === 'vip' ? `${address} を「常に重要」として覚えました` : tier === 'noise' ? `${address} を「不要」として覚えました` : '指定を解除しました');
  }), [withBusy]);

  const onRule = useCallback((c: ButlerCase, tier: 'vip' | 'noise' | null) => onRuleAddr(c.fromAddress, tier), [onRuleAddr]);

  const onDraft = useCallback((c: ButlerCase, instruction?: string) => withBusy(c.id, async () => {
    const res = await window.electronAPI.generateCaseDraft({ caseId: c.id, instruction });
    if (res.status === 'error') flash(res.error ?? '下書きの生成に失敗しました');
    else if (res.draft) setDigest((prev) => prev ? { ...prev, cases: (prev.cases ?? []).map((x) => x.id === c.id ? { ...x, draft: res.draft, draftStatus: 'prepared' } : x) } : prev);
  }), [withBusy]);

  const onApproveGroup = useCallback((g: ButlerGroup, approved: boolean) => withBusy(g.id, async () => {
    const res = await window.electronAPI.approveButlerGroup({ groupId: g.id, approved });
    if (res.status === 'error') flash(res.error ?? '処理に失敗しました');
    else if (approved && res.moved) flash(`${res.moved}通をゴミ箱へ移動しました`);
  }), [withBusy]);

  // ---- 派生 ----
  const view = useMemo(() => {
    const cases = digest?.cases ?? [];
    const open = cases.filter((c) => c.status === 'open');
    const p1 = open.filter((c) => c.priority === 'P1');
    const p2 = open.filter((c) => c.priority === 'P2');
    const rest = open.filter((c) => c.priority === 'P3' || c.priority === 'P4');
    const later = cases.filter((c) => c.status === 'later');
    const groups = digest?.groups ?? [];
    const spamGroups = groups.filter((g) => g.kind === 'spam_delete');
    const spamPending = spamGroups.filter((g) => g.status === 'pending' || g.status === 'failed');
    const noiseGroups = groups.filter((g) => g.kind === 'noise_list');
    const noiseCount = noiseGroups.reduce((n, g) => n + g.items.length, 0);
    const spamCount = spamGroups.reduce((n, g) => n + g.items.length, 0);
    // AI が「不要」と判断した案件(今回分)。除外に載せて、間違いなら ⭐ で教えてもらう
    const aiNoise = cases.filter((c) => c.status === 'dismissed' && (c.category === 'noise' || c.category === 'spam') && c.runAt === digest?.runAt);
    return { cases, open, p1, p2, rest, later, spamGroups, spamPending, noiseGroups, noiseCount, spamCount, aiNoise };
  }, [digest]);

  const running = triggering || digest?.running === true;
  const isV2 = digest?.version === 2;
  const nothing = !digest || (!isV2 && (digest.autoDone.length === 0 && digest.awaitingApproval.length === 0 && (digest.processedCount ?? 0) === 0));

  // ---- 未実行 / オフ ----
  if (loaded && nothing && !running) {
    return (
      <section className="mb-4 bg-surface-900 rounded-lg border border-surface-700/50 p-4">
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none mt-0.5">🌙</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-surface-200">夜間執事レポート</h2>
            <p className="text-sm text-surface-500 mt-1 leading-relaxed">
              新着メールを読んで「先生が何をすべきか」を案件ごとに判定し、返信下書きと朝の申し送りを用意します。
              Claude Code にログイン済みなら API キーは不要です。
            </p>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={runNow} disabled={running} className="px-3 py-1.5 bg-accent-500/20 hover:bg-accent-500/30 border border-accent-500/30 rounded-lg text-xs text-accent-400 transition-colors disabled:opacity-40">
                今すぐ試す
              </button>
              <button onClick={() => onNavigate('settings')} className="px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-xs text-surface-300 transition-colors">
                設定で自動実行を有効化 →
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }
  if (!loaded && !digest) return null;

  const stats = digest?.stats;

  return (
    <section className="mb-4 bg-surface-900/80 rounded-lg border border-surface-700/60 p-4 relative">
      {toast && (
        <div className="absolute top-2 right-2 z-30 px-3 py-1.5 bg-surface-800 border border-surface-600 rounded-md text-xs text-surface-200 shadow-lg">{toast}</div>
      )}

      {/* ヘッダ */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-surface-100 flex items-center gap-2">
            <span>🌙</span>夜間執事レポート
          </h2>
          <div className="flex items-center gap-2.5 mt-1 text-[11px] text-surface-500 flex-wrap">
            {digest?.runAt && <span><span className="text-surface-600">実行 </span>{fmtRunAt(digest.runAt)}</span>}
            {stats ? (
              <>
                <span><span className="text-surface-600">新着 </span>{stats.candidates}通</span>
                <span><span className="text-surface-600">案件 </span>{view.open.length}</span>
                <span><span className="text-surface-600">下書き </span>{stats.drafts}</span>
                <span><span className="text-surface-600">除外 </span>{stats.noise + stats.spam}</span>
                {stats.durationMs > 0 && <span className="text-surface-600">{Math.round(stats.durationMs / 1000)}秒</span>}
              </>
            ) : (
              <span><span className="text-surface-600">処理 </span>{digest?.processedCount ?? 0}件</span>
            )}
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={running}
          className="px-3 py-1.5 bg-surface-800 hover:bg-surface-700 border border-surface-700/50 rounded-lg text-xs text-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 flex-shrink-0"
        >
          {running && <Spinner />}
          {running ? '実行中…' : '今すぐ実行'}
        </button>
      </div>

      {/* 進行状況 */}
      {(running || progress) && (
        <div className="mb-3 px-3 py-2 bg-surface-800/60 border border-surface-700/50 rounded-lg">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-xs text-surface-300">{progress?.message ?? '夜間執事が新着メールを読んでいます…'}</span>
            {progress?.total ? <span className="text-[11px] text-surface-500 ml-auto font-mono">{progress.done ?? 0}/{progress.total}</span> : null}
          </div>
          {progress?.total ? (
            <div className="mt-1.5 h-1 bg-surface-700 rounded overflow-hidden">
              <div className="h-full bg-amber-500/70 transition-all" style={{ width: `${Math.min(100, ((progress.done ?? 0) / progress.total) * 100)}%` }} />
            </div>
          ) : null}
        </div>
      )}

      {/* 旧形式 */}
      {digest && !isV2 && !running && (
        <div className="mb-3 px-3 py-2 bg-sky-500/10 border border-sky-500/30 rounded-lg text-xs text-sky-300">
          前のバージョンのレポートです。「今すぐ実行」で、案件ごとの要件・期限・返信下書き付きの新しいレポートに切り替わります。
        </div>
      )}

      {/* 申し送り */}
      {digest?.brief && (
        <div className="mb-3 px-3.5 py-3 bg-surface-950/60 border-l-2 border-accent-500/60 rounded-r-lg">
          <p className="text-[13px] text-surface-200 leading-relaxed whitespace-pre-wrap">{digest.brief}</p>
        </div>
      )}

      {/* エラー */}
      {digest?.errors && digest.errors.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-surface-800/50 border border-surface-700/60 rounded-lg">
          <ul className="text-[11px] text-surface-400 space-y-0.5 list-disc list-inside">
            {digest.errors.slice(0, 4).map((e, i) => <li key={i} className="line-clamp-1">{e}</li>)}
            {digest.errors.length > 4 && <li>…他 {digest.errors.length - 4} 件</li>}
          </ul>
        </div>
      )}

      {isV2 && (
        <div className="space-y-3">
          {view.p1.length > 0 && (
            <Section title="今日動く" icon="🔴" count={view.p1.length} tone="red">
              {view.p1.map((c) => <CaseCard key={c.id} c={c} busy={busy.has(c.id)} onStatus={onStatus} onRule={onRule} onDraft={onDraft} />)}
            </Section>
          )}
          {view.p2.length > 0 && (
            <Section title="今週中に" icon="🟠" count={view.p2.length} tone="amber">
              {view.p2.map((c) => <CaseCard key={c.id} c={c} busy={busy.has(c.id)} onStatus={onStatus} onRule={onRule} onDraft={onDraft} />)}
            </Section>
          )}
          {view.spamPending.length > 0 && (
            <Section title="承認をお願いします" icon="🙋" count={view.spamPending.length} tone="neutral" hint="迷惑メールの一括ゴミ箱移動(承認するまで何もしません)">
              {view.spamPending.map((g) => <GroupCard key={g.id} g={g} busy={busy.has(g.id)} onApprove={onApproveGroup} onNavigate={onNavigate} onRule={onRuleAddr} />)}
            </Section>
          )}
          {view.rest.length > 0 && (
            <Section title="参考まで" icon="📎" count={view.rest.length} tone="sky" defaultOpen={view.p1.length + view.p2.length === 0} hint="読むだけでよい・急がない">
              {view.rest.map((c) => <CaseCard key={c.id} c={c} compact busy={busy.has(c.id)} onStatus={onStatus} onRule={onRule} onDraft={onDraft} />)}
            </Section>
          )}
          {view.later.length > 0 && (
            <Section title="後で" icon="⏰" count={view.later.length} tone="neutral" defaultOpen={false}>
              {view.later.map((c) => <CaseCard key={c.id} c={c} compact busy={busy.has(c.id)} onStatus={onStatus} onRule={onRule} onDraft={onDraft} />)}
            </Section>
          )}
          {(view.noiseCount > 0 || view.aiNoise.length > 0 || view.spamGroups.some((g) => g.status !== 'pending' && g.status !== 'failed')) && (
            <Section title="除外したもの" icon="📭" count={view.noiseCount + view.aiNoise.length + view.spamGroups.filter((g) => g.status === 'approved' || g.status === 'rejected').reduce((n, g) => n + g.items.length, 0)} tone="neutral" defaultOpen={false} hint="一斉配信・勧誘・処理済みの迷惑メール。間違いがあれば ⭐重要 で教えてください">
              {view.aiNoise.length > 0 && (
                <ul className="space-y-0.5 px-1">
                  {view.aiNoise.map((c) => (
                    <li key={c.id} className="text-[11px] text-surface-400 flex items-center gap-2 min-w-0">
                      <span className="line-clamp-1 flex-1 min-w-0">{c.subject || '(件名なし)'}</span>
                      <span className="text-surface-600 line-clamp-1 max-w-[35%]">{c.from}</span>
                      <button onClick={() => onRuleAddr(c.fromAddress, 'vip')} className="text-[10px] text-surface-500 hover:text-violet-300 flex-shrink-0" title="この送信者を常に重要にする">⭐重要</button>
                      <button onClick={() => onStatus(c, 'open')} className="text-[10px] text-surface-500 hover:text-surface-200 flex-shrink-0" title="案件に戻す">戻す</button>
                    </li>
                  ))}
                </ul>
              )}
              {view.noiseGroups.map((g) => <GroupCard key={g.id} g={g} busy={false} onApprove={onApproveGroup} onNavigate={onNavigate} onRule={onRuleAddr} />)}
              {view.spamGroups.filter((g) => g.status === 'approved' || g.status === 'rejected').map((g) => <GroupCard key={g.id} g={g} busy={false} onApprove={onApproveGroup} onNavigate={onNavigate} onRule={onRuleAddr} />)}
            </Section>
          )}
          {view.open.length === 0 && view.spamPending.length === 0 && !running && (
            <p className="text-sm text-surface-500 px-1 py-2">対応が必要な案件はありません。{stats ? `(新着${stats.candidates}通を確認)` : ''}</p>
          )}
        </div>
      )}
    </section>
  );
}
