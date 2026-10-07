import type { NightlyDigest, PartnerMode } from '../../types';
import { PrimaryButton, SubtleButton, Spinner, MODE_LABEL, STAGE_LABEL, fmtDateTime, fmtTime, Icon, useMediaQuery } from './partnerUi';
import Mascot from './Mascot';
import ModelPicker from './ModelPicker';
import type { MascotMode } from './Mascot';

// =====================================================================
// 相棒ゾーン — 左にしらべ(キャラクター)、中央に申し送り(最初の文だけ太字)、右に状態・操作
// =====================================================================

interface Progress { stage: string; message: string; done?: number; total?: number }

interface Props {
  digest: NightlyDigest | null;
  loaded: boolean;
  running: boolean;
  progress: Progress | null;
  mascotMode: MascotMode;
  lastRunAt: string | null;
  nextRunAt: string | null;
  mode: PartnerMode;
  manual: boolean;
  onRunNow: () => void;
  onSettings: () => void;
  onNotice?: (msg: string) => void;   // トースト
}

/** 最初の文(「。」まで)と残りに分ける */
function splitLead(text: string): [string, string] {
  const i = text.indexOf('。');
  if (i < 0) return [text, ''];
  return [text.slice(0, i + 1), text.slice(i + 1)];
}

/** 吹き出しに出す短い文 */
function mascotMessage(mode: MascotMode, progress: Progress | null, digest: NightlyDigest | null, nextRunAt: string | null): string {
  if (mode === 'working') {
    if (!progress) return '確認しています…';
    const label = STAGE_LABEL[progress.stage] ?? progress.stage;
    return progress.total ? `${label}… ${progress.done ?? 0}/${progress.total}` : `${label}…`;
  }
  if (mode === 'done') return '済みました';
  if (mode === 'error') return progress?.message || 'うまくいきませんでした';
  const n = digest?.stats?.p1 ?? 0;
  if (n > 0) return `今日動くのは ${n} 件`;
  if (nextRunAt) return `次は ${fmtTime(nextRunAt)} に見ます`;
  return '片付いています';
}

export default function BriefCard({ digest, loaded, running, progress, mascotMode, lastRunAt, nextRunAt, mode, manual, onRunNow, onSettings, onNotice }: Props) {
  const wide = useMediaQuery('(min-width: 1180px)');
  const text = !loaded
    ? '読み込んでいます…'
    : !digest
      ? (running ? '相棒が最初の確認をしています…' : '相棒が最初の確認をします。受信箱の新着を読み、返信の下書きと今日の段取りを用意します。')
      : digest.brief || '新しいメールはありませんでした。';
  // 「お疲れさまです。」のような挨拶だけの文は太字にせず、次の文を太字にする
  const [greet, after] = splitLead(text);
  const [lead, rest] = greet.length <= 12 && after ? splitLead(after) : [greet, after];
  const greeting = greet.length <= 12 && after ? greet : '';
  const bubble = mascotMessage(mascotMode, progress, digest, nextRunAt);

  const mascot = (size: number) => (
    <Mascot mode={mascotMode} stage={progress?.stage} message={bubble} done={progress?.done} total={progress?.total} size={size} bubble={false} />
  );

  return (
    <section className="rounded-xl border border-hairline bg-card shadow-card">
      <div className={`flex ${wide ? 'gap-5 px-5 py-4' : 'gap-3 px-4 py-3'}`}>
        {/* しらべ */}
        {wide ? (
          <div className="flex-shrink-0 w-[124px] flex flex-col items-center justify-center gap-1">
            {mascot(120)}
            <span className="text-[10.5px] text-ink-3 text-center leading-tight max-w-[124px] truncate" title={bubble}>{bubble}</span>
          </div>
        ) : null}
        <div className="flex-1 min-w-0">
          {!wide && (
            <div className="flex items-center gap-2 mb-1.5">
              {mascot(40)}
              <span className="text-[11px] text-ink-3 truncate">{bubble}</span>
            </div>
          )}
          <p className="brief-text text-ink whitespace-pre-wrap">
            {greeting && <span className="text-ink-2">{greeting}</span>}
            <span className="font-semibold">{lead}</span>
            {rest && <span>{rest}</span>}
          </p>
          {(digest?.stats?.calendarMissing ?? 0) > 0 && (
            <p className="mt-1.5 text-[11.5px] text-danger">カレンダー未登録の予定が {digest?.stats?.calendarMissing}件あります。上の「未登録」から順に登録できます。</p>
          )}
          {digest?.errors && digest.errors.length > 0 && (
            <details className="mt-1.5">
              <summary className="text-[11.5px] text-warn cursor-pointer select-none">注意 {digest.errors.length}件</summary>
              <ul className="mt-1 text-[11.5px] text-ink-2 space-y-0.5">{digest.errors.map((e, i) => <li key={i}>・{e}</li>)}</ul>
            </details>
          )}
          {(running || progress) && (
            <div className="mt-2.5 flex items-center gap-2 text-[12px] text-ink-2">
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
        <div className="flex-shrink-0 flex flex-col items-end justify-between gap-2 min-w-[170px]">
          <div className="text-[11.5px] text-ink-3 text-right leading-5 tnum">
            <div>最終確認 <span className="text-ink-2">{fmtDateTime(lastRunAt) || '—'}</span></div>
            <div>次回 <span className="text-ink-2">{nextRunAt ? fmtTime(nextRunAt) : manual ? '手動' : '—'}</span></div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-1.5">
              <PrimaryButton onClick={onRunNow} disabled={running}>{running ? <><Spinner /> 確認中</> : <>{Icon.refresh}今すぐ確認</>}</PrimaryButton>
              <SubtleButton onClick={onSettings} title="設定 → 相棒">{MODE_LABEL[mode]}</SubtleButton>
            </div>
            <ModelPicker onSaved={(s) => onNotice?.(`次回の確認から ${s} で判定します`)} />
          </div>
        </div>
      </div>
    </section>
  );
}
