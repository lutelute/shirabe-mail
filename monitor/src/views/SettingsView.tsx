import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import GoogleCalendarConnect from '../components/settings/GoogleCalendarConnect';
import type {
  AppSettings, AccountImapConfig, ImapCredentials, SenderColorMode, ButlerModel, ButlerEffort, CalendarTarget,
  PartnerMode, AccountSmtpConfig, SmtpCredentials, AccountEndpoints,
} from '../types';

function getDefaultImapForAccount(email: string): Partial<ImapCredentials> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain.includes('gmail') || domain.includes('google')) {
    return { host: 'imap.gmail.com', port: 993, secure: true };
  }
  return { host: '', port: 993, secure: true };
}

function getDefaultSmtpForAccount(email: string): Partial<SmtpCredentials> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain.includes('gmail') || domain.includes('google')) {
    return { host: 'smtp.gmail.com', port: 587, secure: false };
  }
  return { host: '', port: 465, secure: true };
}

const MODE_CARDS: Array<{ value: PartnerMode; title: string; desc: string }> = [
  { value: 'observe', title: '見るだけ', desc: '新着を読んで判断と申し送りだけ。メールボックスには触りません。' },
  { value: 'assist', title: '下書き・整理まで(推奨)', desc: '返信の下書き、一斉配信の片付け、迷惑メールの隔離まで。送信は「送る」の1タップ(猶予あり・取り消せます)。' },
  { value: 'delegate', title: '定型返信は任せる', desc: '常連・学内・面識ありへのお礼・確認・了解・日程確定だけ自動で送信予定に載せます。送信前に猶予があり取り消せます。決める必要があるものは必ず聞きます。' },
];

const INTERVAL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: '手動のみ' },
  { value: 15, label: '15分' },
  { value: 30, label: '30分' },
  { value: 60, label: '1時間' },
  { value: 180, label: '3時間' },
];

const DELAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'すぐ' },
  { value: 2, label: '2分' },
  { value: 5, label: '5分' },
  { value: 10, label: '10分' },
  { value: 30, label: '30分' },
];

const inputCls = 'w-full h-8 px-3 text-[13px] bg-card border border-hairline rounded-md focus:border-primary/60 text-ink disabled:cursor-not-allowed';
const smallInputCls = 'w-full h-7 px-2 text-xs bg-card border border-hairline rounded-md focus:border-primary/60 text-ink';

export default function SettingsView() {
  const { settings, accounts, saveSettings, updateState, startDownloadAndInstall, checkForUpdates } = useAppContext();
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // 相棒: 接続
  const [endpoints, setEndpoints] = useState<Record<string, AccountEndpoints>>({});
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);
  const [sameAsImap, setSameAsImap] = useState<Record<string, boolean>>({});
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [showPassword, setShowPassword] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // 相棒: 教える
  const [profile, setProfile] = useState<{ content: string; path: string; sources: string[] } | null>(null);
  const [profileDraft, setProfileDraft] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    window.electronAPI.getAppVersion().then((v: string) => setAppVersion(v));
    window.electronAPI.partnerGetProfile()
      .then((p) => { setProfile(p); setProfileDraft(p.content); })
      .catch(() => setProfile({ content: '', path: '', sources: [] }));
  }, []);

  // SMTP のパスワードが空なら「IMAP と同じ」を既定で ON
  useEffect(() => {
    setSameAsImap((prev) => {
      const next = { ...prev };
      for (const a of accounts) {
        if (next[a.email] === undefined) {
          const smtp = settings.smtpConfigs?.find((c) => c.accountEmail === a.email);
          next[a.email] = !smtp?.credentials?.password;
        }
      }
      return next;
    });
  }, [accounts, settings.smtpConfigs]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const toggleAccount = (email: string) => {
    setDraft((prev) => {
      const selected = prev.selectedAccounts.includes(email)
        ? prev.selectedAccounts.filter((e) => e !== email)
        : [...prev.selectedAccounts, email];
      return { ...prev, selectedAccounts: selected };
    });
    setSaved(false);
  };

  // 相棒の対象アカウント。空配列 = 選択中の全アカウントが対象。
  const toggleButlerAccount = (email: string) => {
    setDraft((prev) => {
      const current = prev.butlerAccounts.length > 0 ? prev.butlerAccounts : [...prev.selectedAccounts];
      const next = current.includes(email)
        ? current.filter((e) => e !== email)
        : [...current, email];
      const allSelected =
        prev.selectedAccounts.length > 0 && prev.selectedAccounts.every((e) => next.includes(e));
      return { ...prev, butlerAccounts: allSelected ? [] : next };
    });
    setSaved(false);
  };

  // ---- IMAP / SMTP 設定の更新 ----
  const getImap = (email: string): AccountImapConfig | undefined => draft.imapConfigs.find((c) => c.accountEmail === email);
  const getSmtp = (email: string): AccountSmtpConfig | undefined => (draft.smtpConfigs ?? []).find((c) => c.accountEmail === email);

  const setImap = useCallback((email: string, creds: Partial<ImapCredentials>, extra?: Partial<Omit<AccountImapConfig, 'credentials'>>) => {
    setDraft((prev) => {
      const configs = [...prev.imapConfigs];
      const idx = configs.findIndex((c) => c.accountEmail === email);
      const d = getDefaultImapForAccount(email);
      const base: ImapCredentials = idx >= 0 && configs[idx].credentials
        ? configs[idx].credentials!
        : { host: d.host ?? '', port: d.port ?? 993, user: email, password: '', secure: d.secure ?? true };
      const merged: AccountImapConfig = {
        accountEmail: email,
        trashFolderPath: idx >= 0 ? configs[idx].trashFolderPath : 'Trash',
        ...(idx >= 0 ? configs[idx] : {}),
        ...extra,
        credentials: { ...base, ...creds },
      };
      if (idx >= 0) configs[idx] = merged; else configs.push(merged);
      // 「IMAP と同じ」なら SMTP のパスワードも追従
      let smtpConfigs = prev.smtpConfigs ?? [];
      if (creds.password !== undefined && sameAsImap[email]) {
        smtpConfigs = smtpConfigs.map((s) => s.accountEmail === email && s.credentials ? { ...s, credentials: { ...s.credentials, password: creds.password! } } : s);
      }
      return { ...prev, imapConfigs: configs, smtpConfigs };
    });
    setSaved(false);
  }, [sameAsImap]);

  const setSmtp = useCallback((email: string, creds: Partial<SmtpCredentials>, extra?: Partial<Omit<AccountSmtpConfig, 'credentials'>>) => {
    setDraft((prev) => {
      const configs = [...(prev.smtpConfigs ?? [])];
      const idx = configs.findIndex((c) => c.accountEmail === email);
      const d = getDefaultSmtpForAccount(email);
      const base: SmtpCredentials = idx >= 0 && configs[idx].credentials
        ? configs[idx].credentials!
        : { host: d.host ?? '', port: d.port ?? 465, user: email, password: '', secure: d.secure ?? true };
      const merged: AccountSmtpConfig = {
        accountEmail: email,
        displayName: idx >= 0 ? configs[idx].displayName : '',
        signature: idx >= 0 ? configs[idx].signature : '',
        ...(idx >= 0 ? configs[idx] : {}),
        ...extra,
        credentials: { ...base, ...creds },
      };
      if (idx >= 0) configs[idx] = merged; else configs.push(merged);
      return { ...prev, smtpConfigs: configs };
    });
    setSaved(false);
  }, []);

  const discover = async () => {
    setDiscovering(true);
    setDiscoverMsg(null);
    try {
      const eps = await window.electronAPI.partnerDiscoverAccounts();
      const map: Record<string, AccountEndpoints> = {};
      for (const ep of eps) map[ep.accountEmail] = ep;
      setEndpoints(map);
      setDraft((prev) => {
        const imapConfigs = [...prev.imapConfigs];
        const smtpConfigs = [...(prev.smtpConfigs ?? [])];
        for (const ep of eps) {
          if (ep.imap) {
            const idx = imapConfigs.findIndex((c) => c.accountEmail === ep.accountEmail);
            const old = idx >= 0 ? imapConfigs[idx] : undefined;
            const merged: AccountImapConfig = {
              accountEmail: ep.accountEmail,
              trashFolderPath: ep.trashFolder || old?.trashFolderPath || 'Trash',
              credentials: {
                host: ep.imap.host, port: ep.imap.port, secure: ep.imap.secure,
                user: ep.imap.user || ep.accountEmail,
                password: old?.credentials?.password ?? '',
              },
            };
            if (idx >= 0) imapConfigs[idx] = merged; else imapConfigs.push(merged);
          }
          if (ep.smtp) {
            const idx = smtpConfigs.findIndex((c) => c.accountEmail === ep.accountEmail);
            const old = idx >= 0 ? smtpConfigs[idx] : undefined;
            const merged: AccountSmtpConfig = {
              accountEmail: ep.accountEmail,
              displayName: ep.displayName || old?.displayName || '',
              signature: old?.signature || ep.signature || '',
              credentials: {
                host: ep.smtp.host, port: ep.smtp.port, secure: ep.smtp.secure,
                user: ep.smtp.user || ep.accountEmail,
                password: old?.credentials?.password ?? '',
              },
            };
            if (idx >= 0) smtpConfigs[idx] = merged; else smtpConfigs.push(merged);
          }
        }
        return { ...prev, imapConfigs, smtpConfigs };
      });
      setSaved(false);
      setDiscoverMsg(eps.length > 0 ? `${eps.length}件のアカウントの接続先を取り込みました。パスワードを入れて「保存」してください。` : 'eM Client のアカウント設定が見つかりませんでした。');
    } catch (e) {
      setDiscoverMsg(`検出に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDiscovering(false);
    }
  };

  const testConn = async (email: string, kind: 'imap' | 'smtp') => {
    const key = `${email}:${kind}`;
    let credentials: ImapCredentials | SmtpCredentials | null | undefined;
    if (kind === 'imap') credentials = getImap(email)?.credentials;
    else {
      const s = getSmtp(email)?.credentials;
      credentials = s ? { ...s, password: sameAsImap[email] ? (getImap(email)?.credentials?.password ?? s.password) : s.password } : s;
    }
    if (!credentials?.host || !credentials?.password) {
      setTestResults((prev) => ({ ...prev, [key]: { success: false, error: 'ホストとパスワードを入力してください' } }));
      return;
    }
    setTestingKey(key);
    try {
      const res = await window.electronAPI.partnerTestConnection({ kind, credentials });
      setTestResults((prev) => ({ ...prev, [key]: res }));
      if (kind === 'imap' && res.success) {
        try {
          const folders = await window.electronAPI.listImapFolders(credentials as ImapCredentials);
          const trash = folders.find((f) => /trash|ゴミ箱|deleted/i.test(f));
          const cur = getImap(email)?.trashFolderPath;
          if (trash && (!cur || cur === 'Trash')) setImap(email, {}, { trashFolderPath: trash });
        } catch { /* optional */ }
      }
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [key]: { success: false, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setTestingKey(null);
    }
  };

  const handleSave = async () => {
    // 「IMAP と同じパスワード」を反映してから保存
    const smtpConfigs = (draft.smtpConfigs ?? []).map((s) => {
      if (!sameAsImap[s.accountEmail] || !s.credentials) return s;
      const imapPw = draft.imapConfigs.find((c) => c.accountEmail === s.accountEmail)?.credentials?.password ?? '';
      return imapPw ? { ...s, credentials: { ...s.credentials, password: imapPw } } : s;
    });
    const next = { ...draft, smtpConfigs };
    setDraft(next);
    await saveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveProfile = async () => {
    setProfileSaving(true);
    try {
      await window.electronAPI.partnerSaveProfile(profileDraft);
      setProfile((p) => p ? { ...p, content: profileDraft } : p);
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } finally {
      setProfileSaving(false);
    }
  };

  // Toggle switch component for consistency
  const Toggle = ({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 disabled:opacity-40 ${
        value ? 'bg-primary' : 'bg-hairline-2'
      }`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
        value ? 'translate-x-5' : ''
      }`} />
    </button>
  );

  // Section header component
  const SectionHeader = ({ title }: { title: string }) => (
    <div className="flex items-center gap-3 mb-4">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <div className="flex-1 h-px bg-hairline" />
    </div>
  );

  const ChoiceRow = <T extends string | number>({ value, options, onChange, disabled }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; disabled?: boolean }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`h-8 px-3 text-[13px] rounded-md border transition-colors disabled:opacity-40 ${
            value === opt.value
              ? 'bg-primary-soft text-primary border-primary/40'
              : 'bg-card text-ink-2 hover:text-ink border-hairline'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );

  const partnerOff = !draft.butlerEnabled;

  const TOC: Array<{ id: string; label: string; sub?: boolean }> = [
    { id: 's-partner', label: '相棒' },
    { id: 's-connect', label: '接続', sub: true },
    { id: 's-teach', label: '相棒に教える', sub: true },
    { id: 's-general', label: '一般' },
    { id: 's-accounts', label: 'アカウント' },
    { id: 's-ai', label: 'AI' },
    { id: 's-mail', label: 'メール表示' },
    { id: 's-filter', label: 'フィルタ' },
    { id: 's-update', label: '更新' },
  ];
  const jump = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="h-full flex bg-paper">
      <aside className="w-44 flex-shrink-0 border-r border-hairline px-3 py-5">
        <div className="text-[11px] text-ink-3 tracking-wide px-2 mb-2">設定</div>
        {TOC.map((t) => (
          <button key={t.id} onClick={() => jump(t.id)} className={`w-full text-left h-8 rounded-md text-[12.5px] text-ink-2 hover:text-ink hover:bg-card-2 ${t.sub ? 'pl-6' : 'px-2'}`}>{t.label}</button>
        ))}
        <div className="mt-4 px-2 text-[10.5px] text-ink-3">v{appVersion}</div>
      </aside>
    <div className="h-full flex-1 flex flex-col min-w-0">
      <div className="px-6 py-3 border-b border-hairline flex items-center">
        <h2 className="text-[15px] font-semibold text-ink">設定</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8 max-w-3xl">
        {/* ─── 相棒 ─── */}
        <section id="s-partner">
          <SectionHeader title="相棒" />
          <div className="space-y-5">
            <div className="p-3 bg-accent-500/10 border border-accent-500/30 rounded text-xs text-surface-300 leading-relaxed">
              新着メールを読み、「何をすべきか・期限・優先度」を判断して、返信の下書きと今日の段取りを用意します。
              <span className="text-accent-400 font-medium"> 送信は必ず猶予を挟み、その間は取り消せます。削除はゴミ箱への移動のみで、必ず確認を求めます。</span>
              <br />AI は Claude Code CLI 経由で動くため、Claude Code にログイン済みなら API キーは不要です。
            </div>

            {partnerOff && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-300">
                相棒は止まっています。下の「相棒を止める」を OFF にすると再開します。
              </div>
            )}

            {/* 権限レベル */}
            <div className={partnerOff ? 'opacity-50 pointer-events-none' : ''}>
              <label className="block text-sm text-surface-200 mb-2">権限レベル</label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {MODE_CARDS.map((m) => {
                  const active = (draft.partnerMode ?? 'assist') === m.value;
                  return (
                    <button
                      key={m.value}
                      onClick={() => update('partnerMode', m.value)}
                      className={`text-left p-3.5 rounded-lg border-2 transition-colors ${
                        active
                          ? 'bg-primary-soft border-primary'
                          : 'bg-card border-hairline hover:border-hairline-2'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-3 h-3 rounded-full border-2 ${active ? 'bg-primary border-primary' : 'border-hairline-2'}`} />
                        <span className={`text-[13.5px] font-semibold ${active ? 'text-primary' : 'text-ink'}`}>{m.title}</span>
                      </div>
                      <p className="text-[12px] text-ink-2 mt-1 ml-5 leading-relaxed">{m.desc}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={`space-y-4 ${partnerOff ? 'opacity-50 pointer-events-none' : ''}`}>
              {/* モデルと考える深さ(「今日」の画面からも変えられる) */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-surface-200 mb-1">判定に使うモデル</label>
                  <select value={draft.butlerModel} onChange={(e) => update('butlerModel', e.target.value as ButlerModel)} className={inputCls}>
                    <option value="haiku">Haiku(速い・粗い)</option>
                    <option value="sonnet">Sonnet(速い)</option>
                    <option value="opus">Opus 5.5(推奨・最も丁寧)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-surface-200 mb-1">下書きに使うモデル</label>
                  <select value={draft.butlerDraftModel} onChange={(e) => update('butlerDraftModel', e.target.value as ButlerModel)} className={inputCls}>
                    <option value="haiku">Haiku</option>
                    <option value="sonnet">Sonnet(速い)</option>
                    <option value="opus">Opus 5.5(推奨・最も自然)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">考える深さ(effort)</label>
                <div className="flex flex-wrap gap-2">
                  {([
                    { value: 'medium' as ButlerEffort, label: 'medium' },
                    { value: 'high' as ButlerEffort, label: 'high' },
                    { value: 'xhigh' as ButlerEffort, label: 'xhigh(推奨)' },
                    { value: 'max' as ButlerEffort, label: 'max(最も深い・遅い)' },
                  ]).map((opt) => (
                    <button key={opt.value} type="button" onClick={() => update('butlerEffort', opt.value)} className={`px-3 py-1.5 text-sm rounded transition-colors ${draft.butlerEffort === opt.value ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30' : 'bg-surface-700 text-surface-300 hover:bg-surface-600 border border-transparent'}`}>{opt.label}</button>
                  ))}
                </div>
                <p className="text-xs text-surface-500 mt-1">Claude CLI の --effort。判定・下書き・申し送り・作業指示書のすべてに効きます。深いほど丁寧ですが 1 回の確認が長くなります。</p>
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">予定の登録先</label>
                <div className="flex flex-wrap gap-2">
                  {([
                    { value: 'google' as CalendarTarget, label: 'Google カレンダー(推奨)' },
                    { value: 'emclient' as CalendarTarget, label: 'eM Client' },
                  ]).map((opt) => (
                    <button key={opt.value} type="button" onClick={() => update('calendarTarget', opt.value)} className={`px-3 py-1.5 text-sm rounded transition-colors ${(draft.calendarTarget ?? 'google') === opt.value ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30' : 'bg-surface-700 text-surface-300 hover:bg-surface-600 border border-transparent'}`}>{opt.label}</button>
                  ))}
                </div>
                {(draft.calendarTarget ?? 'google') === 'google' && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-xs text-surface-400 flex-shrink-0">アカウント</span>
                    <select value={draft.calendarGoogleAccount ?? ''} onChange={(e) => update('calendarGoogleAccount', e.target.value)} className={inputCls}>
                      <option value="">自動(予定が入っているアカウント)</option>
                      {accounts.filter((a) => a.type === 'google').map((a) => (
                        <option key={a.email} value={a.email}>{a.email}</option>
                      ))}
                    </select>
                  </div>
                )}
                <p className="text-xs text-surface-500 mt-1">「カレンダーに登録」で、件名・日時・場所を埋めた Google カレンダーの作成画面を開きます(保存を押すだけ)。下で Google と接続すると、画面を開かずに直接入ります。eM Client は ICS で登録ダイアログを開きます。</p>
              </div>
              {(draft.calendarTarget ?? 'google') === 'google' && (
                <GoogleCalendarConnect autoAdd={!!draft.calendarAutoAdd} onAutoAdd={(v) => update('calendarAutoAdd', v)} inputCls={inputCls} />
              )}
              <div>
                <label className="block text-sm text-surface-200 mb-2">自動で確認する間隔</label>
                <ChoiceRow value={draft.partnerIntervalMinutes ?? 30} options={INTERVAL_OPTIONS} onChange={(v) => update('partnerIntervalMinutes', v)} />
                <p className="text-xs text-surface-500 mt-1">起動時とスリープからの復帰時にも確認します。</p>
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-2">送信までの猶予</label>
                <ChoiceRow value={draft.partnerSendDelayMinutes ?? 5} options={DELAY_OPTIONS} onChange={(v) => update('partnerSendDelayMinutes', v)} />
                <p className="text-xs text-surface-500 mt-1">「送る」を押してから実際に送るまでの時間。この間は「今日」画面の送信予定から取り消せます。</p>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-surface-200">一斉配信を片付ける</label>
                  <p className="text-xs text-surface-500">宣伝・CFP・自動通知を既読にしてアーカイブへ(戻せます。IMAP 設定が必要)</p>
                </div>
                <Toggle value={draft.partnerAutoTidy ?? true} onChange={(v) => update('partnerAutoTidy', v)} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-surface-200">急ぎの新着を通知</label>
                  <p className="text-xs text-surface-500">今日動くべき案件が見つかったら macOS の通知を出します</p>
                </div>
                <Toggle value={draft.partnerNotify ?? true} onChange={(v) => update('partnerNotify', v)} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm text-surface-200">ログイン時に起動</label>
                  <p className="text-xs text-surface-500">Mac にログインしたら自動で起動し、裏で確認を続けます</p>
                </div>
                <Toggle value={draft.partnerLaunchAtLogin ?? false} onChange={(v) => update('partnerLaunchAtLogin', v)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-surface-200 mb-1">返事待ちとみなす日数</label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={draft.partnerFollowUpDays ?? 4}
                    onChange={(e) => update('partnerFollowUpDays', Math.max(1, Number(e.target.value)))}
                    className={inputCls}
                  />
                  <p className="text-xs text-surface-500 mt-1">送ったきり返事が無いものを「返事待ち」に出します</p>
                </div>
              </div>
            </div>

            {/* アカウントの接続 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span id="s-connect" className="block" /><label className="text-sm text-surface-200">アカウントの接続</label>
                  <p className="text-xs text-surface-500">送信(SMTP)と片付け(IMAP)に使います。接続先は eM Client から取り込めるので、入れるのはパスワードだけです。</p>
                </div>
                <button
                  onClick={discover}
                  disabled={discovering}
                  className="px-3 py-1.5 text-sm bg-surface-700 hover:bg-surface-600 text-surface-200 rounded transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {discovering ? '検出中…' : 'eM Client から検出'}
                </button>
              </div>
              {discoverMsg && <p className="text-xs text-surface-400 mb-2">{discoverMsg}</p>}

              {accounts.length === 0 && <p className="text-xs text-surface-500">アカウントが登録されていません(~/.config/shirabe/accounts.json)。</p>}

              {accounts.map((account) => {
                const email = account.email;
                const imap = getImap(email);
                const smtp = getSmtp(email);
                const ic = imap?.credentials;
                const sc = smtp?.credentials;
                const ep = endpoints[email];
                const isOAuth = ep ? ep.auth === 'oauth' : account.type === 'google';
                const same = sameAsImap[email] ?? true;
                const imapKey = `${email}:imap`;
                const smtpKey = `${email}:smtp`;
                const rImap = testResults[imapKey];
                const rSmtp = testResults[smtpKey];
                const imapOk = !!ic?.host && !!ic?.password;
                const smtpOk = !!sc?.host && (same ? !!ic?.password : !!sc?.password);
                return (
                  <div key={email} className="mb-3 p-3 bg-surface-800 rounded border border-surface-700">
                    <div className="flex items-center justify-between mb-2">
                      <div className="min-w-0">
                        <span className="text-sm font-medium text-surface-200">{email}</span>
                        <span className="text-xs text-surface-500 ml-2">{account.label}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className={`px-1.5 py-px rounded border ${imapOk ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' : 'bg-surface-900 text-surface-500 border-surface-700'}`}>片付け {imapOk ? '可' : '未設定'}</span>
                        <span className={`px-1.5 py-px rounded border ${smtpOk ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' : 'bg-surface-900 text-surface-500 border-surface-700'}`}>送信 {smtpOk ? '可' : '未設定'}</span>
                      </div>
                    </div>

                    {isOAuth && (
                      <div className="mb-2 p-2 rounded bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200 leading-relaxed">
                        Google アカウントは、Google の 2 段階認証を有効にしたうえで「アプリパスワード」を発行し、それをパスワード欄に入れてください。
                        <button
                          onClick={() => window.electronAPI.openExternalUrl('https://myaccount.google.com/apppasswords')}
                          className="ml-1 text-accent-400 underline"
                        >
                          アプリパスワードを発行する
                        </button>
                      </div>
                    )}

                    <div className="mb-2">
                      <label className="block text-xs text-surface-400 mb-0.5">差出人の表示名</label>
                      <input
                        type="text"
                        value={smtp?.displayName ?? ''}
                        onChange={(e) => setSmtp(email, {}, { displayName: e.target.value })}
                        className={smallInputCls}
                        placeholder="例: SHIGENOBU Ryuto"
                      />
                    </div>

                    {/* IMAP */}
                    <div className="rounded border border-surface-700/70 p-2 mb-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium text-surface-300">IMAP(受信箱の片付け・隔離)</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => testConn(email, 'imap')}
                            disabled={testingKey !== null || !imapOk}
                            className="px-2 py-0.5 text-xs bg-surface-700 hover:bg-surface-600 text-surface-200 rounded disabled:opacity-50"
                          >
                            {testingKey === imapKey ? 'テスト中…' : 'IMAP テスト'}
                          </button>
                          {rImap && <span className={`text-xs ${rImap.success ? 'text-green-400' : 'text-red-400'}`}>{rImap.success ? '接続成功' : `失敗: ${rImap.error ?? ''}`}</span>}
                        </div>
                      </div>
                      <div className="grid grid-cols-6 gap-2">
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ホスト</label>
                          <input type="text" value={ic?.host ?? getDefaultImapForAccount(email).host ?? ''} onChange={(e) => setImap(email, { host: e.target.value })} className={smallInputCls} placeholder="imap.example.com" />
                        </div>
                        <div className="col-span-1">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ポート</label>
                          <input type="number" value={ic?.port ?? 993} onChange={(e) => setImap(email, { port: Number(e.target.value) })} className={smallInputCls} />
                        </div>
                        <div className="col-span-2 flex items-end">
                          <label className="flex items-center gap-1.5 text-[11px] text-surface-400 pb-1.5">
                            <input type="checkbox" checked={ic?.secure ?? true} onChange={(e) => setImap(email, { secure: e.target.checked })} className="accent-accent-500" />
                            SSL/TLS
                          </label>
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ユーザー</label>
                          <input type="text" value={ic?.user ?? email} onChange={(e) => setImap(email, { user: e.target.value })} className={smallInputCls} />
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-0.5">パスワード</label>
                          <div className="flex gap-1">
                            <input
                              type={showPassword[imapKey] ? 'text' : 'password'}
                              value={ic?.password ?? ''}
                              onChange={(e) => setImap(email, { password: e.target.value })}
                              className={smallInputCls}
                              placeholder={isOAuth ? 'アプリパスワード' : 'パスワード'}
                            />
                            <button onClick={() => setShowPassword((p) => ({ ...p, [imapKey]: !p[imapKey] }))} className="px-1.5 text-[10px] text-surface-500 hover:text-surface-300" title="表示/非表示">{showPassword[imapKey] ? '隠す' : '表示'}</button>
                          </div>
                        </div>
                        <div className="col-span-6">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ゴミ箱フォルダ</label>
                          <input type="text" value={imap?.trashFolderPath ?? 'Trash'} onChange={(e) => setImap(email, {}, { trashFolderPath: e.target.value })} className={smallInputCls} placeholder="Trash" />
                        </div>
                      </div>
                    </div>

                    {/* SMTP */}
                    <div className="rounded border border-surface-700/70 p-2 mb-2">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium text-surface-300">SMTP(送信)</span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => testConn(email, 'smtp')}
                            disabled={testingKey !== null || !smtpOk}
                            className="px-2 py-0.5 text-xs bg-surface-700 hover:bg-surface-600 text-surface-200 rounded disabled:opacity-50"
                          >
                            {testingKey === smtpKey ? 'テスト中…' : 'SMTP テスト'}
                          </button>
                          {rSmtp && <span className={`text-xs ${rSmtp.success ? 'text-green-400' : 'text-red-400'}`}>{rSmtp.success ? '接続成功' : `失敗: ${rSmtp.error ?? ''}`}</span>}
                        </div>
                      </div>
                      <div className="grid grid-cols-6 gap-2">
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ホスト</label>
                          <input type="text" value={sc?.host ?? getDefaultSmtpForAccount(email).host ?? ''} onChange={(e) => setSmtp(email, { host: e.target.value })} className={smallInputCls} placeholder="smtp.example.com" />
                        </div>
                        <div className="col-span-1">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ポート</label>
                          <input type="number" value={sc?.port ?? getDefaultSmtpForAccount(email).port ?? 465} onChange={(e) => setSmtp(email, { port: Number(e.target.value) })} className={smallInputCls} />
                        </div>
                        <div className="col-span-2 flex items-end">
                          <label className="flex items-center gap-1.5 text-[11px] text-surface-400 pb-1.5" title="ON = SSL/TLS(465)、OFF = STARTTLS(587)">
                            <input type="checkbox" checked={sc?.secure ?? (getDefaultSmtpForAccount(email).secure ?? true)} onChange={(e) => setSmtp(email, { secure: e.target.checked })} className="accent-accent-500" />
                            SSL/TLS
                          </label>
                        </div>
                        <div className="col-span-3">
                          <label className="block text-[10px] text-surface-500 mb-0.5">ユーザー</label>
                          <input type="text" value={sc?.user ?? email} onChange={(e) => setSmtp(email, { user: e.target.value })} className={smallInputCls} />
                        </div>
                        <div className="col-span-3">
                          <label className="flex items-center gap-1.5 text-[10px] text-surface-500 mb-0.5">
                            <input
                              type="checkbox"
                              checked={same}
                              onChange={(e) => {
                                const v = e.target.checked;
                                setSameAsImap((p) => ({ ...p, [email]: v }));
                                if (v && ic?.password) setSmtp(email, { password: ic.password });
                              }}
                              className="accent-accent-500"
                            />
                            IMAP と同じパスワード
                          </label>
                          {!same && (
                            <div className="flex gap-1">
                              <input
                                type={showPassword[smtpKey] ? 'text' : 'password'}
                                value={sc?.password ?? ''}
                                onChange={(e) => setSmtp(email, { password: e.target.value })}
                                className={smallInputCls}
                                placeholder={isOAuth ? 'アプリパスワード' : 'パスワード'}
                              />
                              <button onClick={() => setShowPassword((p) => ({ ...p, [smtpKey]: !p[smtpKey] }))} className="px-1.5 text-[10px] text-surface-500 hover:text-surface-300">{showPassword[smtpKey] ? '隠す' : '表示'}</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs text-surface-400 mb-0.5">署名(送信時に本文の末尾へ付けます)</label>
                      <textarea
                        value={smtp?.signature ?? ''}
                        onChange={(e) => setSmtp(email, {}, { signature: e.target.value })}
                        rows={4}
                        className={`${smallInputCls} font-mono leading-relaxed`}
                        placeholder={'============================================\n福井大学 …\n============================================'}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 詳細 */}
            <div className="rounded-lg border border-surface-700/60">
              <button onClick={() => setAdvancedOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-300 hover:text-surface-100">
                <span className={`text-[10px] transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>▶</span>
                詳細(上限・対象アカウント)
              </button>
              {advancedOpen && (
                <div className="px-3 pb-3 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-sm text-surface-200 mb-1">初回に遡る日数</label>
                      <input type="number" min={1} max={90} value={draft.butlerInitialDays} onChange={(e) => update('butlerInitialDays', Math.max(1, Number(e.target.value)))} className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-surface-200 mb-1">1回の判定上限(案件)</label>
                      <input type="number" min={5} step={5} value={draft.butlerMaxCasesPerRun} onChange={(e) => update('butlerMaxCasesPerRun', Math.max(5, Number(e.target.value)))} className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-sm text-surface-200 mb-1">1回の下書き上限(通)</label>
                      <input type="number" min={0} value={draft.butlerMaxDraftsPerRun} onChange={(e) => update('butlerMaxDraftsPerRun', Math.max(0, Number(e.target.value)))} className={inputCls} />
                    </div>
                  </div>
                  <p className="text-xs text-surface-500 -mt-2">2回目以降は前回の確認以降の新着だけを読みます。上限を超えた案件は次回に回します。</p>
                  <div>
                    <label className="block text-sm text-surface-200 mb-1">対象アカウント</label>
                    <p className="text-xs text-surface-500 mb-2">相棒に任せるアカウント。仕事用だけ選べば、プライベートは手動のままになります。全部チェック＝選択中の全アカウント。</p>
                    <div className="space-y-1.5">
                      {accounts.filter((a) => draft.selectedAccounts.includes(a.email)).map((account) => (
                        <label key={account.email} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={draft.butlerAccounts.length === 0 || draft.butlerAccounts.includes(account.email)}
                            onChange={() => toggleButlerAccount(account.email)}
                            className="accent-accent-500"
                          />
                          <span className="text-surface-300">{account.email}</span>
                        </label>
                      ))}
                      {accounts.filter((a) => draft.selectedAccounts.includes(a.email)).length === 0 && (
                        <p className="text-xs text-surface-500">先に「アカウント」セクションで対象を選択してください。</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm text-surface-200 mb-1">迷惑メールの隔離先フォルダ</label>
                      <input type="text" value={draft.butlerQuarantineFolder} onChange={(e) => update('butlerQuarantineFolder', e.target.value)} className={inputCls} placeholder="隔離" />
                      <p className="text-xs text-surface-500 mt-1">移動なので元に戻せます</p>
                    </div>
                    <div>
                      <label className="block text-sm text-surface-200 mb-1">1回あたりの処理上限(件 / アカウント)</label>
                      <input type="number" min={1} step={10} value={draft.butlerMaxPerAccount} onChange={(e) => update('butlerMaxPerAccount', Math.max(1, Number(e.target.value)))} className={inputCls} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-surface-700/50">
                    <div>
                      <label className="text-sm text-surface-200">相棒を止める</label>
                      <p className="text-xs text-surface-500">自動確認・片付け・下書きをすべて止めます(手動の「今すぐ確認」はできます)</p>
                    </div>
                    <Toggle value={!draft.butlerEnabled} onChange={(v) => update('butlerEnabled', !v)} />
                  </div>
                </div>
              )}
            </div>

            {/* 相棒に教える */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span id="s-teach" className="block" /><label className="text-sm text-surface-200">相棒に教える</label>
                <div className="flex items-center gap-2">
                  {profileSaved && <span className="text-xs text-green-400">保存しました</span>}
                  <button
                    onClick={saveProfile}
                    disabled={profileSaving || !profile || profileDraft === profile.content}
                    className="px-3 py-1 text-xs bg-surface-700 hover:bg-surface-600 text-surface-200 rounded transition-colors disabled:opacity-50"
                  >
                    {profileSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-surface-500 mb-2">人物像・判断ルール・よくある相手。ここに書いたことは毎回の判定に使われます。</p>
              <textarea
                value={profileDraft}
                onChange={(e) => setProfileDraft(e.target.value)}
                rows={10}
                className={`${inputCls} font-mono text-xs leading-relaxed`}
                placeholder={'## 人物像と判断スタイル\n- 即対応する相手: …\n- 辞退する傾向: …\n- 定型文: …'}
              />
              <p className="text-[11px] text-surface-500 mt-1">
                参照中: {profile?.sources?.length ? profile.sources.join(', ') : '(既定の人物像のみ)'}
                {profile?.path && <span className="text-surface-600"> — {profile.path}</span>}
              </p>
            </div>
          </div>
        </section>

        {/* ─── General ─── */}
        <section id="s-general">
          <SectionHeader title="一般" />
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-surface-200 mb-2">テーマ</label>
              <div className="flex gap-2">
                {([
                  { value: 'paper' as const, label: 'Paper' },
                  { value: 'dark' as const, label: 'Dark' },
                ]).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => update('theme', opt.value)}
                    className={`px-3 py-1.5 text-sm rounded transition-colors ${
                      draft.theme === opt.value
                        ? 'bg-accent-500/20 text-accent-400 border border-accent-500/30'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600 border border-transparent'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-surface-200 mb-1">更新間隔 (分)</label>
                <input
                  type="number"
                  min={0}
                  value={draft.refreshIntervalMinutes}
                  onChange={(e) => update('refreshIntervalMinutes', Number(e.target.value))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">メール取得日数</label>
                <input
                  type="number"
                  min={1}
                  value={draft.mailDaysBack}
                  onChange={(e) => update('mailDaysBack', Number(e.target.value))}
                  className={inputCls}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-surface-200 mb-1">Google Calendar</label>
              <input
                type="text"
                value={draft.googleCalendarUrl}
                onChange={(e) => update('googleCalendarUrl', e.target.value)}
                className={inputCls}
                placeholder="メールアドレス or embed URL"
              />
              <p className="text-xs text-surface-500 mt-1">
                Googleアカウントのメールアドレスを入力（自動でembed URLに変換されます）
              </p>
            </div>
          </div>
        </section>

        {/* ─── Accounts ─── */}
        {accounts.length > 0 && (
          <section id="s-accounts">
            <SectionHeader title="アカウント" />
            <div className="space-y-1.5">
              {accounts.map((account) => (
                <label key={account.email} className="flex items-center gap-2 text-sm cursor-pointer py-1 hover:bg-surface-800/50 -mx-1 px-1 rounded transition-colors">
                  <input
                    type="checkbox"
                    checked={draft.selectedAccounts.includes(account.email)}
                    onChange={() => toggleAccount(account.email)}
                    className="rounded border-surface-600 bg-surface-700 text-accent-500 focus:ring-accent-500 focus:ring-offset-0"
                  />
                  <span className="text-surface-200">{account.email}</span>
                  <span className="text-xs text-surface-500">({account.label})</span>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* ─── AI / Agent ─── */}
        <section id="s-ai">
          <SectionHeader title="AI / エージェント" />
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm text-surface-200">AI抽出</label>
                <p className="text-xs text-surface-500">メール分析にAIを使用</p>
              </div>
              <Toggle value={draft.aiEnabled} onChange={(v) => update('aiEnabled', v)} />
            </div>

            {draft.aiEnabled && (
              <div>
                <label className="block text-sm text-surface-200 mb-1">APIキー</label>
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => update('apiKey', e.target.value)}
                  className={inputCls}
                  placeholder="sk-..."
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm text-surface-200">エージェント</label>
                <p className="text-xs text-surface-500">Agent SDKで高度な分析を実行</p>
              </div>
              <Toggle value={draft.agentEnabled} onChange={(v) => update('agentEnabled', v)} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-surface-200 mb-1">最大予算 (USD/回)</label>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={draft.maxBudgetUsd}
                  onChange={(e) => update('maxBudgetUsd', Number(e.target.value))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">プロジェクトフォルダ</label>
                <input
                  type="text"
                  value={draft.projectFolderPath}
                  onChange={(e) => update('projectFolderPath', e.target.value)}
                  className={inputCls}
                  placeholder="/path/to/project"
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Mail Display ─── */}
        <section id="s-mail">
          <SectionHeader title="メール表示" />
          <div className="space-y-4">

          <div className="flex items-center justify-between">
            <label className="text-sm text-surface-200">プレビュー表示</label>
            <Toggle value={draft.mailShowPreview} onChange={(v) => update('mailShowPreview', v)} />
          </div>

          {/* 差出人色モード */}
          <div className="mb-4">
            <label className="block text-sm mb-2">差出人の色表示</label>
            <div className="flex gap-2">
              {([
                { value: 'text' as SenderColorMode, label: 'テキスト色', desc: '差出人名を色付き文字で表示' },
                { value: 'background' as SenderColorMode, label: '背景色', desc: '差出人セルに淡い背景色を適用' },
                { value: 'none' as SenderColorMode, label: 'なし', desc: '色なし（モノクロ）' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => update('senderColorMode', opt.value)}
                  title={opt.desc}
                  className={`px-3 py-1.5 text-sm rounded transition-colors ${
                    (draft.senderColorMode ?? 'text') === opt.value
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      : 'bg-surface-700 text-surface-300 hover:bg-surface-600 border border-transparent'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-surface-500 mt-1.5">
              ドメインごとに一貫した色を割り当て、差出人を視覚的に識別します。左ボーダーにも反映されます。
            </p>
          </div>

          <div className="flex items-center justify-between">
            <label className="text-sm text-surface-200">デフォルト未読のみ</label>
            <Toggle value={draft.mailUnreadOnly} onChange={(v) => update('mailUnreadOnly', v)} />
          </div>

          <div>
            <label className="block text-sm mb-2">カラム幅</label>

            {/* Visual ratio bar with draggable dividers */}
            <div className="mb-3">
              <div className="flex h-8 rounded overflow-hidden border border-surface-600">
                <div className="flex items-center justify-center text-[10px] text-surface-300 bg-surface-700 transition-all"
                  style={{ width: `${draft.mailColumnRatio[0]}%` }}>
                  一覧 {draft.mailColumnRatio[0]}%
                </div>
                <div className="w-px bg-surface-500 flex-shrink-0" />
                <div className="flex items-center justify-center text-[10px] text-surface-300 bg-surface-750 transition-all"
                  style={{ width: `${draft.mailColumnRatio[1]}%` }}>
                  詳細 {draft.mailColumnRatio[1]}%
                </div>
                <div className="w-px bg-surface-500 flex-shrink-0" />
                <div className="flex items-center justify-center text-[10px] text-surface-300 bg-surface-700 transition-all"
                  style={{ width: `${draft.mailColumnRatio[2]}%` }}>
                  提案 {draft.mailColumnRatio[2]}%
                </div>
              </div>
            </div>

            {/* Individual sliders */}
            <div className="space-y-2 mb-3">
              {(['一覧', '詳細', '提案'] as const).map((label, idx) => (
                <div key={label} className="flex items-center gap-2">
                  <span className="text-xs text-surface-400 w-8">{label}</span>
                  <input
                    type="range"
                    min={15}
                    max={55}
                    value={draft.mailColumnRatio[idx]}
                    onChange={(e) => {
                      const newVal = Number(e.target.value);
                      const diff = newVal - draft.mailColumnRatio[idx];
                      const ratio = [...draft.mailColumnRatio] as [number, number, number];
                      ratio[idx] = newVal;
                      // Distribute the difference to other columns proportionally
                      const otherIndices = [0, 1, 2].filter(i => i !== idx);
                      const otherTotal = otherIndices.reduce((s, i) => s + ratio[i], 0);
                      for (const oi of otherIndices) {
                        const share = otherTotal > 0 ? (ratio[oi] / otherTotal) : 0.5;
                        ratio[oi] = Math.max(15, Math.round(ratio[oi] - diff * share));
                      }
                      // Normalize to exactly 100
                      const total = ratio[0] + ratio[1] + ratio[2];
                      if (total !== 100) ratio[2] += 100 - total;
                      update('mailColumnRatio', ratio);
                    }}
                    className="flex-1 accent-accent-500 h-1"
                  />
                  <span className="text-xs text-surface-500 w-8 text-right">{draft.mailColumnRatio[idx]}%</span>
                </div>
              ))}
            </div>

            {/* Presets as compact chips */}
            <div className="flex flex-wrap gap-1.5">
              {([
                { label: '均等', value: [33, 33, 34] as [number, number, number] },
                { label: '一覧重視', value: [40, 30, 30] as [number, number, number] },
                { label: '標準', value: [30, 35, 35] as [number, number, number] },
                { label: '詳細重視', value: [25, 40, 35] as [number, number, number] },
                { label: '提案重視', value: [25, 35, 40] as [number, number, number] },
              ]).map((preset) => {
                const isActive = draft.mailColumnRatio[0] === preset.value[0]
                  && draft.mailColumnRatio[1] === preset.value[1]
                  && draft.mailColumnRatio[2] === preset.value[2];
                return (
                  <button
                    key={preset.label}
                    onClick={() => update('mailColumnRatio', preset.value)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      isActive
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600 border border-transparent'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
          </div>
        </section>

        {/* ─── Filtering ─── */}
        <section id="s-filter">
          <SectionHeader title="フィルタリング" />
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm text-surface-200">ゴミメール検出</label>
                <p className="text-xs text-surface-500">AIでゴミメールを自動判定</p>
              </div>
              <Toggle value={draft.junkDetectionEnabled} onChange={(v) => update('junkDetectionEnabled', v)} />
            </div>

            {draft.junkDetectionEnabled && (
              <div>
                <label className="block text-sm text-surface-200 mb-1">ホワイトリストドメイン</label>
                <p className="text-xs text-surface-500 mb-1.5">
                  これらのドメインからのメールは常にSafe判定されます（1行1ドメイン）
                </p>
                <textarea
                  value={(draft.junkWhitelistDomains ?? []).join('\n')}
                  onChange={(e) => {
                    const domains = e.target.value.split('\n').map((d) => d.trim()).filter(Boolean);
                    update('junkWhitelistDomains', domains);
                  }}
                  rows={3}
                  className={`${inputCls} font-mono`}
                  placeholder="example.ac.jp&#10;.ac.jp&#10;example.com"
                />
              </div>
            )}

            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm text-surface-200">スパム除外</label>
                <p className="text-xs text-surface-500">メール一覧からスパムを非表示</p>
              </div>
              <Toggle value={draft.excludeSpam} onChange={(v) => update('excludeSpam', v)} />
            </div>
          </div>
        </section>

        {/* ─── App Update ─── */}
        <section id="s-update">
          <SectionHeader title="アプリ更新" />

          {/* Update available banner (from auto-check or manual check) */}
          {updateState.hasUpdate && (
            <div className="p-3 bg-accent-500/10 border border-accent-500/30 rounded mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-accent-400">
                  v{updateState.latestVersion} が利用可能
                </span>
                {!updateState.downloading && !updateState.installed && (
                  <button
                    onClick={startDownloadAndInstall}
                    className="px-3 py-1.5 text-sm bg-accent-500 hover:bg-accent-400 text-white rounded transition-colors"
                  >
                    更新してインストール
                    {updateState.downloadSize ? ` (${(updateState.downloadSize / 1024 / 1024).toFixed(0)}MB)` : ''}
                  </button>
                )}
              </div>
              {updateState.releaseNotes && (
                <p className="text-xs text-surface-400 mb-2 whitespace-pre-wrap line-clamp-4">
                  {updateState.releaseNotes}
                </p>
              )}

              {updateState.installed ? (
                <p className="text-xs text-green-400">インストール完了。アプリを再起動しています...</p>
              ) : updateState.downloading && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-surface-700 rounded-full overflow-hidden">
                      {(updateState.downloadPercent ?? 0) > 0 ? (
                        <div
                          className="h-full bg-accent-500 transition-all duration-300"
                          style={{ width: `${updateState.downloadPercent}%` }}
                        />
                      ) : (
                        <div className="h-full bg-accent-500/60 animate-pulse w-full" />
                      )}
                    </div>
                    <span className="text-xs text-surface-400 w-10 text-right">
                      {(updateState.downloadPercent ?? 0) > 0 ? `${updateState.downloadPercent}%` : '...'}
                    </span>
                  </div>
                  <p className="text-xs text-surface-500">
                    {updateState.downloadMessage || (
                      updateState.downloadPhase === 'mounting' ? 'DMGをマウント中...' :
                      updateState.downloadPhase === 'installing' ? '/Applicationsにインストール中...' :
                      updateState.downloadPhase === 'restarting' ? '再起動中...' :
                      'ダウンロード中...'
                    )}
                  </p>
                </div>
              )}
              {updateState.downloadError && (
                <p className="text-xs text-red-400 mt-1">{updateState.downloadError}</p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 mb-2">
            <button
              onClick={checkForUpdates}
              disabled={updateState.checking || updateState.downloading}
              className="px-3 py-1.5 text-sm bg-surface-700 hover:bg-surface-600 text-surface-300 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updateState.checking ? '確認中...' : '更新を確認'}
            </button>
            <span className="text-xs text-surface-400">現在: v{appVersion || '...'}</span>
          </div>

          {!updateState.hasUpdate && updateState.error && (
            <p className="text-xs text-surface-400">{updateState.error}</p>
          )}
        </section>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-surface-700/50 flex items-center justify-end gap-3">
        {saved && <span className="text-xs text-green-400 animate-fade-in">保存しました</span>}
        <button
          onClick={handleSave}
          className="px-5 py-1.5 text-sm bg-accent-500 hover:bg-accent-600 text-white rounded transition-colors font-medium"
        >
          保存
        </button>
      </div>
    </div>
    </div>
  );
}
