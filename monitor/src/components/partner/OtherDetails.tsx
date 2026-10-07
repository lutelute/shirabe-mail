import { useEffect, useState } from 'react';
import type { OutboxItem, FollowUp, ButlerGroup, JournalEntry } from '../../types';
import { Chip, PrimaryButton, SubtleButton, GhostButton, Spinner, AutoTextarea, Icon, ZoneLabel, fmtRemaining, fmtDateTime, useNow, nameOf, addrOf } from './partnerUi';

// =====================================================================
// 送信予定 / 返事待ち / 片付け / 日誌 の詳細パネル
// =====================================================================

function Head({ chips, title, sub, right, zone = '案件' }: { chips?: React.ReactNode; title: string; sub?: string; right?: React.ReactNode; zone?: string }) {
  return (
    <header>
      <ZoneLabel className="mb-1.5">{zone}</ZoneLabel>
      <h2 className="text-[20px] font-semibold text-ink leading-snug">{title}</h2>
      <div className="mt-1.5 text-[12px] leading-5 text-ink-2">
        {(sub || right) && (
          <div className="flex items-center gap-x-2 flex-wrap">
            {sub && <span>{sub}</span>}
            {sub && right && <span className="text-ink-3">·</span>}
            {right && <span className="tnum text-ink-3">{right}</span>}
          </div>
        )}
        {chips && <div className="flex items-center gap-1.5 flex-wrap mt-1">{chips}</div>}
      </div>
    </header>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <ZoneLabel className="mb-1.5">{children}</ZoneLabel>;

// ---- 送信予定 ----
export function OutboxDetail({ o, busy, onSendNow, onCancel }: { o: OutboxItem; busy: boolean; onSendNow: (o: OutboxItem) => void; onCancel: (o: OutboxItem) => void }) {
  const now = useNow(o.status === 'scheduled');
  const remain = new Date(o.sendAt).getTime() - now;
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-5">
       <div className="detail-prose space-y-4">
        <Head
          chips={<>
            <Chip label={o.kind === 'nudge' ? '催促' : o.kind === 'reply' ? '返信' : '新規'} cls="bg-primary-soft text-primary border-primary/30" />
            {o.auto && <Chip label="相棒が自動で用意" cls="bg-card-2 text-ink-3 border-hairline" />}
            {o.status === 'failed' && <Chip label="失敗" cls="bg-danger-soft text-danger border-danger/30" />}
          </>}
          title={o.subject}
          sub={`宛先: ${o.to.join(', ')}${o.cc.length ? ` / Cc: ${o.cc.join(', ')}` : ''}`}
          right={o.status === 'scheduled' ? `${fmtDateTime(o.sendAt)} に送信` : ''}
          zone="送信予定"
        />
        {o.status === 'scheduled' && (
          <div className="rounded-lg border border-primary/30 bg-primary-soft px-4 py-3 flex items-center gap-3">
            <span className="text-primary">{Icon.clock}</span>
            <span className="text-[14px] text-ink tnum">あと {fmtRemaining(remain)}</span>
            <span className="text-[12px] text-ink-2">— 猶予の間は取り消せます</span>
          </div>
        )}
        {o.status === 'sending' && <div className="text-[13px] text-ink-2 flex items-center gap-2"><Spinner /> 送信しています…</div>}
        {o.status === 'failed' && <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger">送信に失敗しました: {o.error ?? '不明なエラー'}</div>}
        <section className="rounded-lg border border-hairline bg-card px-4 py-3">
          <Label>本文(署名と引用は送信時に付きます)</Label>
          <pre className="draft-text whitespace-pre-wrap font-sans text-ink">{o.body}</pre>
        </section>
       </div>
      </div>
      <footer className="flex-shrink-0 border-t border-hairline px-6 min-h-[52px] py-1.5 bg-card flex items-center gap-2 flex-wrap">
        <ZoneLabel className="mr-1 hidden wide:block">操作</ZoneLabel>
        {o.status === 'scheduled' && <PrimaryButton size="lg" onClick={() => onSendNow(o)} disabled={busy}>{Icon.send}今すぐ送る</PrimaryButton>}
        {o.status === 'failed' && <PrimaryButton size="lg" onClick={() => onSendNow(o)} disabled={busy}>{Icon.refresh}もう一度</PrimaryButton>}
        {(o.status === 'scheduled' || o.status === 'failed') && <SubtleButton danger onClick={() => onCancel(o)} disabled={busy}>{o.status === 'failed' ? 'やめる' : '取り消し'}</SubtleButton>}
        {busy && <Spinner />}
      </footer>
    </div>
  );
}

// ---- 返事待ち ----
export function FollowUpDetail({ f, busy, canSend, onAction }: { f: FollowUp; busy: boolean; canSend: boolean; onAction: (f: FollowUp, action: 'nudge' | 'snooze' | 'close' | 'draft', body?: string) => Promise<string | undefined> }) {
  const [body, setBody] = useState(f.nudgeDraft ?? '');
  const [composing, setComposing] = useState(false);
  useEffect(() => { setBody(f.nudgeDraft ?? ''); setComposing(false); }, [f.id]);
  useEffect(() => { if (f.nudgeDraft && !composing) setBody(f.nudgeDraft); }, [f.nudgeDraft, composing]);

  const prepare = async () => {
    const d = f.nudgeDraft || (await onAction(f, 'draft'));
    if (d) { setBody(d); setComposing(true); }
  };
  const waitCls = f.daysWaiting >= 10 ? 'bg-danger-soft text-danger border-danger/30' : f.daysWaiting >= 7 ? 'bg-warn-soft text-warn border-warn/30' : 'bg-card-2 text-ink-2 border-hairline';

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-5">
       <div className="detail-prose space-y-4">
        <Head
          chips={<>
            <Chip mono label={`${f.daysWaiting}日待ち`} cls={waitCls} />
            {f.status === 'nudged' && <Chip label="催促済み" cls="bg-card-2 text-ink-3 border-hairline" />}
          </>}
          title={f.subject || '(件名なし)'}
          sub={`${f.to || f.toAddress} へ ${fmtDateTime(f.sentAt)} に送信`}
          zone="返事待ち"
        />
        {(f.ask || f.summary) && (
          <section className="border-l-[3px] border-primary pl-3.5 py-0.5 space-y-1.5">
            <Label>すること</Label>
            {f.ask && <p className="text-[14px] text-ink leading-relaxed">{f.ask}</p>}
            {f.summary && <p className="text-[13px] text-ink-2 leading-relaxed">{f.summary}</p>}
          </section>
        )}
        <section className={`rounded-lg border bg-card px-4 py-3 ${composing ? 'border-primary/60' : 'border-hairline'}`}>
          <div className="flex items-center gap-2 mb-1.5">
            <Label>催促文</Label>
            {!f.nudgeDraft && !composing && <span className="text-[11px] text-ink-3 -mt-1">「催促する」で相棒が用意します</span>}
          </div>
          {(f.nudgeDraft || composing) ? (
            <AutoTextarea value={body} onChange={(v) => { setBody(v); setComposing(true); }} minRows={5} />
          ) : (
            <div className="rounded-md border border-dashed border-hairline-2 px-4 py-3 text-[12.5px] text-ink-2">まだありません。</div>
          )}
          {(f.nudgeDraft || composing) && (
            <div className="flex items-center gap-1.5 mt-2">
              <GhostButton onClick={() => onAction(f, 'draft', 'もう少し丁寧に').then((d) => { if (d) setBody(d); })} disabled={busy}>丁寧に</GhostButton>
              <GhostButton onClick={() => onAction(f, 'draft', 'もっと短く').then((d) => { if (d) setBody(d); })} disabled={busy}>短く</GhostButton>
              {busy && <Spinner className="ml-1" />}
            </div>
          )}
        </section>
       </div>
      </div>
      <footer className="flex-shrink-0 border-t border-hairline px-6 min-h-[52px] py-1.5 bg-card flex items-center gap-2 flex-wrap">
        <ZoneLabel className="mr-1 hidden wide:block">操作</ZoneLabel>
        {(f.nudgeDraft || composing) ? (
          <PrimaryButton size="lg" onClick={() => onAction(f, 'nudge', body)} disabled={busy || !body.trim()}>{Icon.send}{canSend ? 'この内容で催促する' : 'eM Client で催促する'}</PrimaryButton>
        ) : (
          <PrimaryButton size="lg" onClick={prepare} disabled={busy}>催促文を作る</PrimaryButton>
        )}
        <SubtleButton onClick={() => onAction(f, 'snooze')} disabled={busy}>まだ待つ(3日)</SubtleButton>
        <SubtleButton onClick={() => onAction(f, 'close')} disabled={busy}>閉じる</SubtleButton>
        {busy && <Spinner />}
      </footer>
    </div>
  );
}

// ---- 片付けたグループ ----
export function GroupDetail({ g, busy, onUndoTidy, onApprove, onRule }: { g: ButlerGroup; busy: boolean; onUndoTidy: (g: ButlerGroup) => void; onApprove: (g: ButlerGroup, approved: boolean) => void; onRule: (address: string, tier: 'vip' | 'noise' | null) => void }) {
  const kindLabel = g.kind === 'spam_delete' ? '迷惑メール(承認待ち)' : g.kind === 'tidied' ? '片付け済み' : '一斉配信(残したまま)';
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-6 py-5">
       <div className="detail-prose space-y-4">
        <Head
          chips={<Chip label={kindLabel} cls={g.kind === 'spam_delete' ? 'bg-danger-soft text-danger border-danger/30' : 'bg-card-2 text-ink-2 border-hairline'} />}
          zone="片付け"
          title={g.label}
          sub={`${g.reason}${g.archiveFolder ? ` — 移動先: ${g.archiveFolder}` : ''}${g.error ? ` — ${g.error}` : ''}`}
          right={`${g.items.length}通`}
        />
        <ul className="divide-y divide-hairline border border-hairline rounded-md bg-card">
          {g.items.map((it) => (
            <li key={`${it.accountEmail}-${it.mailId}`} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-ink truncate">{it.subject || '(件名なし)'}</span>
                <span className="block text-[11.5px] text-ink-3 truncate">{it.from}</span>
              </span>
              <GhostButton onClick={() => onRule(addrOf(it.from), 'vip')} title="この送信者を常に重要にする">{Icon.star}</GhostButton>
            </li>
          ))}
        </ul>
       </div>
      </div>
      <footer className="flex-shrink-0 border-t border-hairline px-6 min-h-[52px] py-1.5 bg-card flex items-center gap-2 flex-wrap">
        <ZoneLabel className="mr-1 hidden wide:block">操作</ZoneLabel>
        {g.kind === 'tidied' && !g.undone && <PrimaryButton size="lg" onClick={() => onUndoTidy(g)} disabled={busy}>{Icon.undo}受信箱へ戻す</PrimaryButton>}
        {g.kind === 'spam_delete' && (
          <>
            <SubtleButton danger size="lg" onClick={() => onApprove(g, true)} disabled={busy}>ゴミ箱へ</SubtleButton>
            <SubtleButton onClick={() => onApprove(g, false)} disabled={busy}>残す</SubtleButton>
          </>
        )}
        {busy && <Spinner />}
      </footer>
    </div>
  );
}

// ---- 日誌 ----
export function JournalDetail({ j }: { j: JournalEntry }) {
  return (
    <div className="px-6 py-5 space-y-3 detail-prose">
      <ZoneLabel>日誌</ZoneLabel>
      <div className="text-[11px] text-ink-3 tnum">{new Date(j.at).toLocaleString('ja-JP')}</div>
      <p className={`text-[14px] leading-relaxed ${j.kind === 'error' ? 'text-danger' : 'text-ink'}`}>{j.text}</p>
      {(j.caseId || j.accountEmail) && <p className="text-[11.5px] text-ink-3">{j.accountEmail}{j.caseId ? ` · ${j.caseId}` : ''}</p>}
    </div>
  );
}

export { nameOf };
