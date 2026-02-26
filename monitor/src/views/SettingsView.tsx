import { useState, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useImapOperations } from '../hooks/useImapOperations';
import type { AppSettings, AccountImapConfig, ImapCredentials, SenderColorMode } from '../types';

function getDefaultImapForAccount(email: string): Partial<ImapCredentials> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain.includes('gmail') || domain.includes('google')) {
    return { host: 'imap.gmail.com', port: 993, secure: true };
  }
  return { host: '', port: 993, secure: true };
}

export default function SettingsView() {
  const { settings, accounts, saveSettings, updateState, startDownloadAndInstall, checkForUpdates } = useAppContext();
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [saved, setSaved] = useState(false);
  const { testing, testResult, folders, foldersLoading, testConnection, fetchFolders } = useImapOperations();
  const [testingAccount, setTestingAccount] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.electronAPI.getAppVersion().then((v: string) => setAppVersion(v));
  }, []);

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

  const updateImapConfig = (accountEmail: string, updates: Partial<AccountImapConfig>) => {
    setDraft((prev) => {
      const configs = [...prev.imapConfigs];
      const idx = configs.findIndex((c) => c.accountEmail === accountEmail);
      if (idx >= 0) {
        configs[idx] = { ...configs[idx], ...updates };
      } else {
        const defaults = getDefaultImapForAccount(accountEmail);
        configs.push({
          accountEmail,
          credentials: {
            host: defaults.host ?? '',
            port: defaults.port ?? 993,
            user: accountEmail,
            password: '',
            secure: defaults.secure ?? true,
          },
          trashFolderPath: 'Trash',
          ...updates,
        });
      }
      return { ...prev, imapConfigs: configs };
    });
    setSaved(false);
  };

  const updateImapCredential = (accountEmail: string, field: keyof ImapCredentials, value: string | number | boolean) => {
    setDraft((prev) => {
      const configs = [...prev.imapConfigs];
      const idx = configs.findIndex((c) => c.accountEmail === accountEmail);
      if (idx >= 0 && configs[idx].credentials) {
        configs[idx] = {
          ...configs[idx],
          credentials: { ...configs[idx].credentials!, [field]: value },
        };
      } else {
        const defaults = getDefaultImapForAccount(accountEmail);
        const creds: ImapCredentials = {
          host: defaults.host ?? '',
          port: defaults.port ?? 993,
          user: accountEmail,
          password: '',
          secure: defaults.secure ?? true,
          [field]: value,
        };
        if (idx >= 0) {
          configs[idx] = { ...configs[idx], credentials: creds };
        } else {
          configs.push({ accountEmail, credentials: creds, trashFolderPath: 'Trash' });
        }
      }
      return { ...prev, imapConfigs: configs };
    });
    setSaved(false);
  };

  const handleTestConnection = async (accountEmail: string) => {
    const config = draft.imapConfigs.find((c) => c.accountEmail === accountEmail);
    if (!config?.credentials) return;
    setTestingAccount(accountEmail);
    await testConnection(config.credentials);
    // Also fetch folders on success
    const result = await testConnection(config.credentials);
    if (result.success) {
      const folderList = await fetchFolders(config.credentials);
      // Auto-detect trash folder
      const trashFolder = folderList.find((f) =>
        /trash|ゴミ箱|\[gmail\]\/ゴミ箱/i.test(f),
      );
      if (trashFolder) {
        updateImapConfig(accountEmail, { trashFolderPath: trashFolder });
      }
    }
    setTestingAccount(null);
  };

  const handleSave = async () => {
    await saveSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const getImapConfig = (email: string): AccountImapConfig | undefined =>
    draft.imapConfigs.find((c) => c.accountEmail === email);

  // Toggle switch component for consistency
  const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!value)}
      className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
        value ? 'bg-accent-500' : 'bg-surface-600'
      }`}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
        value ? 'translate-x-5' : ''
      }`} />
    </button>
  );

  // Section header component
  const SectionHeader = ({ title }: { title: string }) => (
    <div className="flex items-center gap-2 mb-3">
      <h3 className="text-xs font-semibold text-surface-400 uppercase tracking-wider">{title}</h3>
      <div className="flex-1 h-px bg-surface-700" />
    </div>
  );

  return (
    <div className="h-full flex flex-col max-w-2xl">
      <div className="px-5 py-3 border-b border-surface-700/50">
        <h2 className="text-lg font-semibold text-surface-100">設定</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
        {/* ─── General ─── */}
        <section>
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
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">メール取得日数</label>
                <input
                  type="number"
                  min={1}
                  value={draft.mailDaysBack}
                  onChange={(e) => update('mailDaysBack', Number(e.target.value))}
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-surface-200 mb-1">Google Calendar</label>
              <input
                type="text"
                value={draft.googleCalendarUrl}
                onChange={(e) => update('googleCalendarUrl', e.target.value)}
                className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
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
          <section>
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

        {/* IMAP settings per account */}
        <section>
          <SectionHeader title="IMAP設定" />
          <p className="text-xs text-surface-500 mb-3">
            ゴミメールをIMAPサーバーから削除するには、各アカウントのIMAP認証情報を設定してください。
          </p>

          {accounts.map((account) => {
            const config = getImapConfig(account.email);
            const creds = config?.credentials;
            const isGoogle = account.type === 'google';
            const isTestingThis = testingAccount === account.email;

            return (
              <div key={account.email} className="mb-4 p-3 bg-surface-800 rounded border border-surface-700">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-surface-200">{account.email}</span>
                  <span className="text-xs text-surface-500">{account.label}</span>
                </div>

                {isGoogle && (
                  <p className="text-xs text-yellow-400 mb-2">
                    Googleアカウントはアプリパスワードが必要です:{' '}
                    <span className="text-blue-400 underline cursor-pointer"
                      onClick={() => window.open?.('https://myaccount.google.com/apppasswords')}>
                      アプリパスワード設定
                    </span>
                  </p>
                )}

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label className="block text-xs text-surface-400 mb-0.5">ホスト</label>
                    <input
                      type="text"
                      value={creds?.host ?? (isGoogle ? 'imap.gmail.com' : '')}
                      onChange={(e) => updateImapCredential(account.email, 'host', e.target.value)}
                      className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                      placeholder="imap.example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-0.5">ポート</label>
                    <input
                      type="number"
                      value={creds?.port ?? 993}
                      onChange={(e) => updateImapCredential(account.email, 'port', Number(e.target.value))}
                      className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label className="block text-xs text-surface-400 mb-0.5">ユーザー</label>
                    <input
                      type="text"
                      value={creds?.user ?? account.email}
                      onChange={(e) => updateImapCredential(account.email, 'user', e.target.value)}
                      className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-surface-400 mb-0.5">パスワード</label>
                    <input
                      type="password"
                      value={creds?.password ?? ''}
                      onChange={(e) => updateImapCredential(account.email, 'password', e.target.value)}
                      className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                      placeholder={isGoogle ? 'アプリパスワード' : 'パスワード'}
                    />
                  </div>
                </div>

                <div className="mb-2">
                  <label className="block text-xs text-surface-400 mb-0.5">ゴミ箱フォルダ</label>
                  <input
                    type="text"
                    value={config?.trashFolderPath ?? 'Trash'}
                    onChange={(e) => updateImapConfig(account.email, { trashFolderPath: e.target.value })}
                    className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                    placeholder="Trash"
                  />
                  {folders.length > 0 && isTestingThis && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {folders.filter((f) => /trash|ゴミ箱|junk|spam|deleted/i.test(f)).map((f) => (
                        <button
                          key={f}
                          onClick={() => updateImapConfig(account.email, { trashFolderPath: f })}
                          className="px-1.5 py-0.5 text-xs bg-surface-700 text-blue-400 rounded hover:bg-surface-600"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleTestConnection(account.email)}
                    disabled={testing || !creds?.host || !creds?.password}
                    className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isTestingThis && testing ? 'テスト中...' : '接続テスト'}
                  </button>
                  {isTestingThis && testResult && (
                    <span className={`text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                      {testResult.success ? '接続成功' : `失敗: ${testResult.error}`}
                    </span>
                  )}
                  {isTestingThis && foldersLoading && (
                    <span className="text-xs text-surface-400">フォルダ取得中...</span>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* ─── AI / Agent ─── */}
        <section>
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
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
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
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-surface-200 mb-1">プロジェクトフォルダ</label>
                <input
                  type="text"
                  value={draft.projectFolderPath}
                  onChange={(e) => update('projectFolderPath', e.target.value)}
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white"
                  placeholder="/path/to/project"
                />
              </div>
            </div>
          </div>
        </section>

        {/* ─── Mail Display ─── */}
        <section>
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
        <section>
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
                  className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-accent-500 text-white font-mono"
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
        <section>
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
  );
}
