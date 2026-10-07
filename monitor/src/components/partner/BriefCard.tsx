import type { NightlyDigest, PartnerMode } from '../../types';
import { PrimaryButton, SubtleButton, Spinner, MODE_LABEL, STAGE_LABEL, fmtDateTime, fmtTime, Icon } from './partnerUi';

// =====================================================================
// 相棒の一言 — 申し送り(左)と状態・操作(右)
// =====================================================================

interface Progress { stage: string; message: string; done?: number; total?: number }

interface Props {
  digest: NightlyDigest | null;
  loaded: boolean;
  running: boolean;
  progress: Progress | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  mode: PartnerMode;
  manual: boolean;
  onRunNow: () => void;
  onSettings: () => void;
}

export default function BriefCard({ digest, loaded, running, progress, lastRunAt, nextRunAt, mode, manual, onRunNow, onSettings }: Props) {
  const text = !loaded
    ? '読み込んでいます…'
    : !digest
      ? (running ? '相棒が最初の確認をしています…' : '相棒が最初の確認をします。受信箱の新着を読み、返信の下書きと今日の段取りを用意します。')
      : digest.brief || '新しいメールはありませんでした。';
  return (
    <section className="rounded-xl border border-hairline bg-card shadow-card">
      <div className="flex gap-6 px-6 py-5">
        <div className="flex-1 min-w-0">
          <p className="brief-text text-ink whitespace-pre-wrap">{text}</p>
          {(digest?.stats?.calendarMissing ?? 0) > 0 && (
            <p className="mt-2 text-[11.5px] text-danger">カレンダー未登録の予定が {digest?.stats?.calendarMissing}件あります。一覧の「未登録」から登録できます。</p>
          )}
          {digest?.errors && digest.errors.length > 0 && (
            <details className="mt-2">
              <summary className="text-[11.5px] text-warn cursor-pointer select-none">注意 {digest.errors.length}件</summary>
              <ul className="mt-1 text-[11.5px] text-ink-2 space-y-0.5">{digest.errors.map((e, i) => <li key={i}>・{e}</li>)}</ul>
            </details>
          )}
          {(running || progress) && (
            <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-2">
              {running && <Spinner />}
              <span>{progress ? `${STAGE_LABEL[progress.stage] ?? progress.stage}: ${progress.message}` : '確認しています…'}</span>
              {progress?.total ? (
                <span className="ml-auto flex items-center gap-2 w-44">
                  <span className="flex-1 h-1 bg-hairline rounded-full overflow-hidden">
                    <span className="block h-full bg-primary transition-all" style={{ width: `${Math.round(((progress.done ?? 0) / progress.total) * 100)}%` }} />
                  </span>
                  <span className="tnum text-ink-3">{progress.done ?? 0}/{progress.total}</span>
                </span>
              ) : null}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-2 min-w-[170px]">
          <div className="text-[11.5px] text-ink-3 text-right leading-5 tnum">
            <div>最終確認 <span className="text-ink-2">{fmtDateTime(lastRunAt) || '—'}</span></div>
            <div>次回 <span className="text-ink-2">{nextRunAt ? fmtTime(nextRunAt) : manual ? '手動' : '—'}</span></div>
          </div>
          <div className="flex items-center gap-1.5">
            <PrimaryButton onClick={onRunNow} disabled={running}>{running ? <><Spinner /> 確認中</> : <>{Icon.refresh}今すぐ確認</>}</PrimaryButton>
            <SubtleButton onClick={onSettings} title="設定 → 相棒">{MODE_LABEL[mode]}</SubtleButton>
          </div>
        </div>
      </div>
    </section>
  );
}
