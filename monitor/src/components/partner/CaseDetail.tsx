import { useEffect, useRef, useState } from 'react';
import type { ButlerCase, ButlerCaseStatus, HandoffTarget } from '../../types';
import { openInEmClient } from '../../utils/openInEmClient';
import type { CaseVariant } from './queue';
import { Chip, DeadlineChip, PrimaryButton, SubtleButton, GhostButton, Spinner, AutoTextarea, Icon, ZoneLabel, PRIORITY_META, CATEGORY_META, TIER_META, fmtDateTime, fmtTime, fmtEvent, HANDOFF_TARGET_LABEL } from './partnerUi';

// =====================================================================
// 案件の詳細パネル — 上から 6 つのゾーン(各 11px の見出しラベル、間隔 16px):
//   案件(件名・メタ・予定) → すること(藍の左罫線) → 決める(山吹の帯) → 下書き(白、編集中は藍の枠) → 作業に移る(灰の帯) → 操作(フッタ)
//   文章は detail-prose(760px)に収める。操作フッタは常に見える。
// =====================================================================

export interface CaseDetailProps {
  c: ButlerCase;
  variant: CaseVariant;
  canSend: boolean;
  busy: boolean;
  handoffBusy: boolean;
  sendDelayMinutes: number;
  editRequest?: number;          // 増えるたびに下書きエディタへフォーカス('e' キー)
  handoffRequest?: number;       // 'w' キー: 指示書を作る / ターミナルで開く
  emDraftRequest?: number;       // 'd' キー: eM Client の下書きへ
  onStatus: (c: ButlerCase, status: ButlerCaseStatus) => void;
  onRule: (address: string, tier: 'vip' | 'noise' | null) => void;
  onDraft: (c: ButlerCase, instruction?: string) => void;
  onSaveDraft: (c: ButlerCase, body: string) => Promise<void>;
  onSend: (c: ButlerCase, body?: string) => void;
  onAnswer: (c: ButlerCase, answer: string) => void;
  onDraftToEmClient: (c: ButlerCase, body?: string) => void;
  onHandoffPrepare: (c: ButlerCase, instruction?: string) => void;
  onHandoffOpen: (c: ButlerCase, target: HandoffTarget) => void;
  onHandoffCopy: (c: ButlerCase) => void;
  onCalendarCopy: (c: ButlerCase, target: 'chatgpt' | 'clipboard') => void;
  onPickFolder: (c: ButlerCase) => void;
  onAddToCalendar: (c: ButlerCase) => void;
  onAddToCalendarVia?: (c: ButlerCase, target: 'google' | 'emclient') => void;
  onRemoveFromCalendar?: (c: ButlerCase) => void;
  googleAccounts?: string[];
  onAddToCalendarAs?: (c: ButlerCase, account: string) => void;
}

const Label = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <ZoneLabel className={className}>{children}</ZoneLabel>
);

export default function CaseDetail(p: CaseDetailProps) {
  const { c, variant, canSend, busy, handoffBusy } = p;
  const [body, setBody] = useState(c.draft ?? '');
  const [dirty, setDirty] = useState(false);
  const [other, setOther] = useState('');
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  // 案件が変わった / 外から下書きが差し替わったら追従(手直し中は保持)
  useEffect(() => { setBody(c.draft ?? ''); setDirty(false); setOther(''); }, [c.id]);
  useEffect(() => { if (!dirty) setBody(c.draft ?? ''); }, [c.draft, dirty]);
  useEffect(() => { if (p.editRequest) editorRef.current?.focus(); }, [p.editRequest]);

  // 'w': 指示書が無ければ作る、あってフォルダが決まっていればターミナルで開く
  useEffect(() => {
    if (!p.handoffRequest || handoffBusy) return;
    if (c.handoff?.folder) p.onHandoffOpen(c, 'app');
    else p.onHandoffPrepare(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.handoffRequest]);

  // 'd': 今の本文で eM Client の下書きへ
  useEffect(() => {
    if (!p.emDraftRequest || busy) return;
    if (body.trim()) p.onDraftToEmClient(c, dirty ? body : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.emDraftRequest]);

  const pm = PRIORITY_META[c.priority] ?? PRIORITY_META.P3;
  const cm = CATEGORY_META[c.category] ?? CATEGORY_META.unknown;
  const tm = TIER_META[c.senderTier] ?? TIER_META.unknown;

  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(body); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };
  const save = async () => { await p.onSaveDraft(c, body); setDirty(false); };
  const send = () => p.onSend(c, dirty ? body : undefined);
  const toEmClient = () => p.onDraftToEmClient(c, dirty ? body : undefined);
  const sendLabel = !canSend ? 'eM Client で送る' : p.sendDelayMinutes > 0 ? `送る · ${p.sendDelayMinutes}分後に送信` : '送る';
  const showDraft = variant === 'send' || (variant === 'decision' && !!c.decision?.answer) || (!!c.draft && variant !== 'fyi');
  const needsDecision = variant === 'decision' && c.decision && !c.decision.answer;
  const showHandoff = variant !== 'fyi' && variant !== 'later';

  const handoffSection = showHandoff && (
    <HandoffSection c={c} busy={handoffBusy} onPrepare={p.onHandoffPrepare} onOpen={p.onHandoffOpen} onPick={p.onPickFolder} onCopy={p.onHandoffCopy} />
  );

  const draftSection = showDraft && (
    <section className={`rounded-lg border bg-card px-4 py-3 transition-colors ${dirty ? 'border-primary/60' : 'border-hairline'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Label>下書き</Label>
        {c.decision?.answer && <Chip label={`決定: ${c.decision.answer}`} cls="bg-ok-soft text-ok border-ok/30" />}
        {c.draftEdited && !dirty && <Chip label="手直し済み" cls="bg-card-2 text-ink-3 border-hairline" />}
        {dirty && <Chip label="未保存" cls="bg-warn-soft text-warn border-warn/30" />}
      </div>
      {c.draft || dirty ? (
        <>
          <AutoTextarea value={body} onChange={(v) => { setBody(v); setDirty(true); }} minRows={6} inputRef={(el) => { editorRef.current = el; }} className={dirty ? 'border-primary/40' : ''} />
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <GhostButton onClick={() => p.onDraft(c, 'もう少し丁寧に')} disabled={busy}>丁寧に</GhostButton>
            <GhostButton onClick={() => p.onDraft(c, 'もっと短く')} disabled={busy}>短く</GhostButton>
            <GhostButton onClick={() => p.onDraft(c, '別の案を')} disabled={busy}>別案</GhostButton>
            <GhostButton onClick={copyDraft}>{copied ? 'コピーしました' : 'コピー'}</GhostButton>
            {dirty && <GhostButton onClick={save} disabled={busy}>保存</GhostButton>}
            {dirty && <GhostButton onClick={() => { setBody(c.draft ?? ''); setDirty(false); }}>元に戻す</GhostButton>}
            <span className="flex-1" />
            <SubtleButton size="sm" onClick={toEmClient} disabled={busy || !body.trim()} title="eM Client の「下書き」に入れます。開いて送ってください(d)">{Icon.draft}eM Client の下書きへ</SubtleButton>
            {busy && <Spinner className="ml-1" />}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-dashed border-hairline-2 px-4 py-2.5 flex items-center gap-3">
          <span className="text-[12.5px] text-ink-2">{c.draftStatus === 'failed' ? '下書きの用意に失敗しました。' : '下書きはまだありません。'}</span>
          <SubtleButton size="sm" onClick={() => p.onDraft(c)} disabled={busy}>下書きを作る</SubtleButton>
          {busy && <Spinner />}
        </div>
      )}
    </section>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="detail-prose space-y-4">
          {/* ゾーン 1: 案件(件名・メタ・予定) */}
          <header>
            <Label className="mb-1.5">案件</Label>
            <h2 className="text-[20px] font-semibold text-ink leading-snug">{c.subject || '(件名なし)'}</h2>
            <div className="mt-1.5 text-[12px] leading-5 text-ink-2">
              <div className="flex items-center gap-x-2 flex-wrap">
                <span className="text-ink">{c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress}</span>
                <span className="text-ink-3">·</span>
                <span className="tnum text-ink-3">{fmtDateTime(c.receivedAt)}</span>
                <span className="text-ink-3">·</span>
                <span className="text-ink-3">スレッド {c.threadCount}通</span>
                {c.isRead && <><span className="text-ink-3">·</span><span className="text-ink-3" title="eM Client で既に開いています">既読</span></>}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                <Chip label={pm.label} cls={pm.cls} />
                <Chip label={cm.label} cls={cm.cls} />
                <Chip label={tm.label} cls={tm.cls} title={c.senderStats ? `受信${c.senderStats.received} / 返信${c.senderStats.replied} / 送信${c.senderStats.sentTo}` : undefined} />
                <DeadlineChip deadline={c.deadline} />
                {c.addressedToMe === 'cc' && <Chip label="Cc" cls="bg-card-2 text-ink-3 border-hairline" />}
                {c.addressedToMe === 'list' && <Chip label="ML" cls="bg-card-2 text-ink-3 border-hairline" />}
              </div>
              {c.event && <EventRow c={c} busy={busy} onAdd={p.onAddToCalendar} onAddVia={p.onAddToCalendarVia} onCopy={p.onCalendarCopy} onRemove={p.onRemoveFromCalendar} googleAccounts={p.googleAccounts} onAddAs={p.onAddToCalendarAs} />}
            </div>
          </header>

          {/* ゾーン 2: すること(藍の左罫線) */}
          {(c.ask || c.summary || c.reason) && (
            <section className="border-l-[3px] border-primary pl-3.5 py-0.5 space-y-1.5">
              <Label>すること</Label>
              {c.ask && <p className="text-[14px] text-ink leading-relaxed">{c.ask}</p>}
              {c.summary && <p className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">{c.summary}</p>}
              {c.reason && <p className="text-[12px] text-ink-3">根拠: {c.reason}</p>}
            </section>
          )}

          {/* ゾーン 3: 決める(山吹の帯) */}
          {needsDecision && c.decision && (
            <section className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3">
              <Label className="!text-warn mb-1">決める</Label>
              <p className="text-[15px] font-semibold text-ink mb-2">{c.decision.question}</p>
              <div className="flex flex-wrap gap-1.5">
                {c.decision.options.map((opt, i) => (
                  <button
                    key={opt}
                    disabled={busy}
                    onClick={() => p.onAnswer(c, opt)}
                    className="app-no-drag h-8 px-3 rounded-md text-[13px] bg-card text-ink border border-hairline-2 hover:border-primary hover:text-primary transition-colors disabled:opacity-40"
                  >
                    <span className="text-ink-3 tnum mr-1.5">{i + 1}</span>{opt}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <input
                  value={other}
                  onChange={(e) => setOther(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) { p.onAnswer(c, other.trim()); setOther(''); } }}
                  placeholder="その他(自由に書く)"
                  className="app-no-drag flex-1 h-8 px-3 text-[13px] bg-card border border-hairline rounded-md focus:border-primary/60 text-ink"
                />
                <SubtleButton onClick={() => { if (other.trim()) { p.onAnswer(c, other.trim()); setOther(''); } }} disabled={busy || !other.trim()}>決める</SubtleButton>
                {busy && <span className="text-[11.5px] text-ink-2 flex items-center gap-1.5"><Spinner /> 下書きを用意しています…</span>}
              </div>
            </section>
          )}

          {/* 作業に移る / 下書き — やること(action)は作業を先に、返信は下書きを先に */}
          {variant === 'action' ? (<>{handoffSection}{draftSection}</>) : (<>{draftSection}{handoffSection}</>)}
        </div>
      </div>

      {/* 操作(常に見える) */}
      <footer className="flex-shrink-0 border-t border-hairline px-6 min-h-[52px] py-1.5 bg-card flex items-center gap-2 flex-wrap">
        <Label className="mr-1 hidden wide:block">操作</Label>
        {showDraft && (c.draft || dirty) && (
          <PrimaryButton size="lg" onClick={send} disabled={busy || !body.trim()} title={canSend ? '送信までの猶予の間は取り消せます' : 'eM Client の作成画面を開きます'}>
            {Icon.send}{sendLabel}
          </PrimaryButton>
        )}
        {variant === 'action' && <PrimaryButton size="lg" onClick={() => p.onStatus(c, 'done')} disabled={busy}>{Icon.check}済み</PrimaryButton>}
        {variant === 'fyi' && <PrimaryButton size="lg" onClick={() => p.onStatus(c, 'done')} disabled={busy}>{Icon.check}読んだ</PrimaryButton>}
        {variant === 'later' && <PrimaryButton size="lg" onClick={() => p.onStatus(c, 'open')} disabled={busy}>{Icon.undo}戻す</PrimaryButton>}
        {(variant === 'send' || variant === 'decision') && (
          <SubtleButton onClick={() => p.onStatus(c, 'done')} disabled={busy} title="自分で返した・済んだ">済み</SubtleButton>
        )}
        {variant !== 'later' && <SubtleButton onClick={() => p.onStatus(c, 'later')} disabled={busy}>後で</SubtleButton>}
        {variant !== 'later' && <SubtleButton onClick={() => p.onStatus(c, 'dismissed')} disabled={busy}>しない</SubtleButton>}
        <span className="flex-1" />
        <GhostButton onClick={() => openInEmClient({ subject: c.subject, fromAddress: c.fromAddress })} title="eM Client で開く">{Icon.external}eM Client</GhostButton>
        <GhostButton onClick={() => p.onRule(c.fromAddress, 'vip')} title="この人は常に重要">{Icon.star}常に重要</GhostButton>
        <GhostButton onClick={() => p.onRule(c.fromAddress, 'noise')} title="この人のメールは不要">{Icon.ban}不要</GhostButton>
      </footer>
    </div>
  );
}

// ---------- 予定(カレンダー) ----------

function EventRow({ c, busy, onAdd, onAddVia, onCopy, onRemove, googleAccounts, onAddAs }: { c: ButlerCase; busy: boolean; onAdd: (c: ButlerCase) => void; onAddVia?: (c: ButlerCase, target: 'google' | 'emclient') => void; onCopy: (c: ButlerCase, target: 'chatgpt' | 'clipboard') => void; onRemove?: (c: ButlerCase) => void; googleAccounts?: string[]; onAddAs?: (c: ButlerCase, account: string) => void }) {
  const ev = c.event!;
  const status = c.calendarStatus ?? 'unknown';
  const multi = (googleAccounts?.length ?? 0) > 1;
  return (
    <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[12px]">
      <span className="text-ink-3">{Icon.calendar}</span>
      <span className="text-ink">
        <span className="tnum">{fmtEvent(ev)}</span> {ev.title}{ev.location ? <span className="text-ink-2"> @{ev.location}</span> : null}
      </span>
      {status === 'missing' && <Chip label="カレンダー未登録" cls="bg-danger-soft text-danger border-danger/30" />}
      {status === 'registered' && <Chip label={`登録済み${c.calendarMatch ? `: ${c.calendarMatch}` : ''}${c.calendarEventAccount ? `(${c.calendarEventAccount})` : ''}`} cls="bg-ok-soft text-ok border-ok/30" />}
      {status === 'registered' && c.calendarEventId && (
        <>
          {c.calendarEventLink && <GhostButton onClick={() => void window.electronAPI.openExternalUrl(c.calendarEventLink!)} title="Google カレンダーで開く">開く</GhostButton>}
          {onRemove && <GhostButton onClick={() => onRemove(c)} disabled={busy} title="相棒が入れた予定を Google カレンダーから消す">取り消す</GhostButton>}
        </>
      )}
      {status === 'unknown' && <Chip label="カレンダー未確認" cls="bg-card-2 text-ink-3 border-hairline" />}
      {status === 'missing' && (
        <>
          <PrimaryButton size="sm" onClick={() => onAdd(c)} disabled={busy} title="Google カレンダーに登録します(受け取ったアカウントに合わせて自動で振り分け)">{Icon.calendar}Google カレンダーに登録</PrimaryButton>
          {multi && onAddAs && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) onAddAs(c, e.target.value); }}
              disabled={busy}
              className="app-no-drag h-7 px-1.5 text-[11.5px] bg-card border border-hairline rounded-md text-ink-2"
              title="入れるアカウントを選んで登録"
            >
              <option value="">アカウントを選んで登録…</option>
              {googleAccounts!.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          )}
          <GhostButton onClick={() => onAddVia?.(c, 'emclient')} disabled={busy} title="ICS を作って eM Client の登録ダイアログを開きます">eM Client</GhostButton>
          <GhostButton onClick={() => onCopy(c, 'chatgpt')} disabled={busy} title="予定の文面をコピーして ChatGPT を開きます(貼り付けて登録を頼む)">ChatGPT</GhostButton>
        </>
      )}
    </div>
  );
}

// ---------- 作業に移る ----------

function HandoffSection({ c, busy, onPrepare, onOpen, onPick, onCopy }: {
  c: ButlerCase;
  busy: boolean;
  onPrepare: (c: ButlerCase, instruction?: string) => void;
  onOpen: (c: ButlerCase, target: HandoffTarget) => void;
  onPick: (c: ButlerCase) => void;
  onCopy: (c: ButlerCase) => void;
}) {
  const h = c.handoff ?? null;
  const [showAll, setShowAll] = useState(false);
  const [extra, setExtra] = useState('');
  useEffect(() => { setShowAll(false); setExtra(''); }, [c.id]);

  // 未準備: 1 行のバー
  if (!h) {
    return (
      <section className="rounded-lg border border-hairline bg-paper-2 px-4 h-11 flex items-center gap-3">
        <Label>作業に移る</Label>
        <span className="flex-1 min-w-0 text-[12.5px] text-ink-2 truncate">該当フォルダを探して作業指示書を用意します。ターミナルの Claude Code や FinderAI に渡せます。</span>
        <PrimaryButton size="sm" onClick={() => onPrepare(c)} disabled={busy} title="w">{busy ? <><Spinner /> 用意しています…</> : <>{Icon.terminal}作業指示書を作る</>}</PrimaryButton>
      </section>
    );
  }

  const lines = h.instructions.split('\n');
  const preview = showAll ? h.instructions : lines.slice(0, 6).join('\n');
  const truncated = lines.length > 6;
  const canOpen = !!h.folder && h.folderExists;

  return (
    <section className="rounded-lg border border-hairline bg-paper-2 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Label>作業に移る</Label>
        <span className="text-[13.5px] font-semibold text-ink">{h.title}</span>
        {busy && <Spinner />}
        <span className="ml-auto text-[11px] text-ink-3 tnum truncate">
          {h.status === 'taken' && h.takenAt
            ? `${fmtTime(h.takenAt)} に受け取り済み(${h.takenBy?.startsWith('cli:') ? 'shirabe-task @ ' + h.takenBy.slice(4).split('/').slice(-2).join('/') : h.takenBy === 'clipboard' ? 'コピー' : h.takenBy && HANDOFF_TARGET_LABEL[h.takenBy as HandoffTarget] ? HANDOFF_TARGET_LABEL[h.takenBy as HandoffTarget] : h.takenBy ?? ''})`
            : h.status === 'done'
              ? '作業は完了しています'
              : '受け渡し待ち: どこで Claude を開いても起動時に案内が出ます(shirabe-task take)'}
        </span>
      </div>

      {/* フォルダ */}
      <div className="rounded-md border border-hairline bg-card px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-ink-3 flex-shrink-0">{Icon.folder}</span>
          {h.folder ? (
            <span className="font-mono text-[11.5px] text-ink truncate" title={h.folder}>{h.folder}</span>
          ) : (
            <span className="text-[12.5px] text-danger">フォルダを選んでください</span>
          )}
          {h.folder && !h.folderExists && <Chip label="見つかりません" cls="bg-danger-soft text-danger border-danger/30" />}
          <span className="flex-1" />
          <GhostButton onClick={() => onPick(c)} disabled={busy} title="別のフォルダを選ぶ">変更</GhostButton>
        </div>
        {h.folderReason && <p className="mt-1 text-[11px] text-ink-3">{h.folderReason}</p>}
      </div>

      {h.deliverable && (
        <p className="text-[12.5px] text-ink-2"><span className="text-ink-3">成果物: </span>{h.deliverable}</p>
      )}

      {/* 指示書 */}
      <div>
        <Label className="mb-1">作業指示書</Label>
        <pre className="whitespace-pre-wrap font-sans text-[12.5px] text-ink leading-relaxed rounded-md border border-hairline bg-card px-3 py-2.5 max-h-[420px] overflow-y-auto">{preview}{!showAll && truncated ? '\n…' : ''}</pre>
        <div className="flex items-center gap-2 mt-1.5">
          {truncated && <GhostButton onClick={() => setShowAll((v) => !v)}>{showAll ? '先頭だけ表示' : 'すべて表示'}</GhostButton>}
          <span className="text-[10.5px] text-ink-3 font-mono truncate" title={h.docPath}>{h.docPath}</span>
        </div>
      </div>

      {/* 開く */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <PrimaryButton onClick={() => onOpen(c, 'app')} disabled={busy || !canOpen} title={canOpen ? 'アプリ内のターミナルでこのフォルダに Claude Code を起動し、指示書を渡します(w)' : 'フォルダを選んでください'}>{Icon.terminal}アプリ内で Claude Code</PrimaryButton>
        <SubtleButton onClick={() => onOpen(c, 'terminal')} disabled={busy || !canOpen} title={canOpen ? 'Terminal.app でこのフォルダに Claude Code を起動し、指示書を渡します' : 'フォルダを選んでください'}>ターミナルで Claude Code</SubtleButton>
        <SubtleButton onClick={() => onOpen(c, 'finderai')} disabled={busy || !canOpen} title={canOpen ? 'FinderAI でこのフォルダを開き、Claude セッションへ指示を送ります' : 'フォルダを選んでください'}>FinderAI で開く</SubtleButton>
        <GhostButton onClick={() => onOpen(c, 'folder')} disabled={busy || !canOpen} title="Finder で表示">{Icon.folder}フォルダを表示</GhostButton>
        <SubtleButton onClick={() => onCopy(c)} disabled={busy} title="指示書ごとクリップボードへ。場所を移してから開いた Claude や ChatGPT に貼り付けられます">指示をコピー</SubtleButton>
        <span className="flex-1" />
        <input
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { onPrepare(c, extra.trim() || undefined); setExtra(''); } }}
          placeholder="追加の指示(任意)"
          className="app-no-drag h-8 w-48 px-2.5 text-[12px] bg-card border border-hairline rounded-md focus:border-primary/60 text-ink"
        />
        <GhostButton onClick={() => { onPrepare(c, extra.trim() || undefined); setExtra(''); }} disabled={busy}>作り直す</GhostButton>
      </div>
    </section>
  );
}
