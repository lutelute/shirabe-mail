import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ButlerEffort, ButlerModel, AiEngine } from '../../types';
import { useAppContext } from '../../context/AppContext';

// =====================================================================
// モデルと考える深さ(effort)を「今日」から直接選ぶ。変更は即保存(次回の確認から効く)
// =====================================================================

export const MODEL_LABEL: Record<ButlerModel, string> = { haiku: 'Haiku 4.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5' };
const MODEL_DESC: Record<ButlerModel, string> = { haiku: '速い・粗い', sonnet: '速い', opus: '最も丁寧(推奨)' };
const EFFORTS: Array<{ value: ButlerEffort; label: string; desc: string }> = [
  { value: 'medium', label: 'medium', desc: '軽い' },
  { value: 'high', label: 'high', desc: '' },
  { value: 'xhigh', label: 'xhigh', desc: '推奨' },
  { value: 'max', label: 'max', desc: '最も深い・遅い' },
];

const CODEX_MODELS = ['gpt-6-astra', 'gpt-5.5-codex'];

export function modelSummary(s: AppSettings): string {
  if (s.aiEngine === 'codex') return `Codex ${s.codexModel || '(既定)'} · ${s.butlerEffort === 'max' ? 'xhigh' : (s.butlerEffort ?? 'xhigh')}`;
  const m = MODEL_LABEL[s.butlerModel] ?? s.butlerModel;
  const d = s.butlerDraftModel !== s.butlerModel ? ` / 下書き ${MODEL_LABEL[s.butlerDraftModel] ?? s.butlerDraftModel}` : '';
  return `${m}${d} · ${s.butlerEffort ?? 'xhigh'}`;
}

export default function ModelPicker({ onSaved }: { onSaved?: (summary: string) => void }) {
  const { settings, saveSettings } = useAppContext();
  const [open, setOpen] = useState(false);
  const [separate, setSeparate] = useState(settings.butlerDraftModel !== settings.butlerModel);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const commit = async (patch: Partial<AppSettings>) => {
    const next: AppSettings = { ...settings, ...patch };
    await saveSettings(next);
    onSaved?.(modelSummary(next));
  };

  const setModel = (m: ButlerModel) => commit(separate ? { butlerModel: m } : { butlerModel: m, butlerDraftModel: m });
  const setDraftModel = (m: ButlerModel) => commit({ butlerDraftModel: m });
  const setEffort = (e: ButlerEffort) => commit({ butlerEffort: e });
  const setEngine = (e: AiEngine) => commit({ aiEngine: e });
  const engine: AiEngine = settings.aiEngine ?? 'claude';
  const [codexModel, setCodexModel] = useState(settings.codexModel ?? '');

  const seg = (active: boolean) => `px-2.5 h-7 rounded-md text-[12px] border transition-colors ${active ? 'bg-primary-soft text-primary border-primary/40' : 'bg-card text-ink-2 border-hairline hover:bg-card-2 hover:text-ink'}`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="app-no-drag h-7 px-2.5 rounded-md border border-hairline bg-card text-[11.5px] text-ink-2 hover:text-ink hover:bg-card-2 tnum"
        title="判定・下書きに使うモデルと考える深さ。変更は次回の確認から効きます"
      >
        {modelSummary(settings)}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-40 w-[320px] rounded-lg border border-hairline bg-card shadow-card p-3 space-y-3 text-left">
          <div>
            <div className="text-[10.5px] tracking-wide text-ink-3 mb-1.5">頭脳</div>
            <div className="flex gap-1.5">
              <button onClick={() => setEngine('claude')} className={seg(engine === 'claude')}>Claude</button>
              <button onClick={() => setEngine('codex')} className={seg(engine === 'codex')} title="OpenAI Codex CLI(ChatGPT ログイン)。使えないときは自動で Claude に切り替えます">Codex</button>
            </div>
          </div>
          {engine === 'codex' ? (
            <div>
              <div className="text-[10.5px] tracking-wide text-ink-3 mb-1.5">Codex のモデル</div>
              <div className="flex gap-1.5 flex-wrap">
                {CODEX_MODELS.map((m) => (
                  <button key={m} onClick={() => { setCodexModel(m); void commit({ codexModel: m }); }} className={seg((settings.codexModel ?? '') === m)}>{m}</button>
                ))}
                <button onClick={() => { setCodexModel(''); void commit({ codexModel: '' }); }} className={seg(!settings.codexModel)} title="~/.codex/config.toml の既定">既定</button>
              </div>
              <input
                value={codexModel}
                onChange={(e) => setCodexModel(e.target.value)}
                onBlur={() => { if (codexModel !== (settings.codexModel ?? '')) void commit({ codexModel: codexModel.trim() }); }}
                placeholder="モデル名を直接入力(例 gpt-6-astra)"
                className="mt-1.5 w-full h-7 px-2 text-[12px] bg-card border border-hairline rounded-md text-ink"
              />
              <p className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">Codex が上限・エラーのときは、その回だけ Claude({MODEL_LABEL[settings.butlerModel] ?? settings.butlerModel})で続けて日誌に残します。</p>
            </div>
          ) : (
          <div>
            <div className="text-[10.5px] tracking-wide text-ink-3 mb-1.5">{separate ? '判定のモデル' : 'モデル(判定・下書き)'}</div>
            <div className="flex gap-1.5">
              {(['haiku', 'sonnet', 'opus'] as ButlerModel[]).map((m) => (
                <button key={m} onClick={() => setModel(m)} className={seg(settings.butlerModel === m)} title={MODEL_DESC[m]}>{MODEL_LABEL[m]}</button>
              ))}
            </div>
            <label className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-2 cursor-pointer">
              <input type="checkbox" checked={separate} onChange={(e) => { setSeparate(e.target.checked); if (!e.target.checked) void commit({ butlerDraftModel: settings.butlerModel }); }} className="rounded" />
              下書きだけ別のモデルにする
            </label>
            {separate && (
              <div className="mt-1.5">
                <div className="text-[10.5px] tracking-wide text-ink-3 mb-1.5">下書きのモデル</div>
                <div className="flex gap-1.5">
                  {(['haiku', 'sonnet', 'opus'] as ButlerModel[]).map((m) => (
                    <button key={m} onClick={() => setDraftModel(m)} className={seg(settings.butlerDraftModel === m)}>{MODEL_LABEL[m]}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
          <div>
            <div className="text-[10.5px] tracking-wide text-ink-3 mb-1.5">考える深さ(effort)</div>
            <div className="flex gap-1.5 flex-wrap">
              {EFFORTS.map((e) => (
                <button key={e.value} onClick={() => setEffort(e.value)} className={seg((settings.butlerEffort ?? 'xhigh') === e.value)} title={e.desc}>{e.label}{e.desc === '推奨' ? '(推奨)' : ''}</button>
              ))}
            </div>
            <p className="mt-1.5 text-[10.5px] text-ink-3 leading-snug">深いほど丁寧ですが、1 回の確認が長くなります。次回の確認から効きます。</p>
          </div>
        </div>
      )}
    </div>
  );
}
