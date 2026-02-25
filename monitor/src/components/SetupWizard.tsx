import { useState, useEffect } from 'react';
import { useAppContext } from '../context/AppContext';
import { useImapOperations } from '../hooks/useImapOperations';
import type { AccountConfig, AccountImapConfig, ImapCredentials, AppSettings } from '../types';

interface SetupWizardProps {
  onComplete: () => void;
}

type Step = 'welcome' | 'accounts' | 'imap' | 'apikey' | 'confirm';
const STEPS: Step[] = ['welcome', 'accounts', 'imap', 'apikey', 'confirm'];

function getDefaultImapForAccount(email: string): Partial<ImapCredentials> {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (domain.includes('gmail') || domain.includes('google')) {
    return { host: 'imap.gmail.com', port: 993, secure: true };
  }
  return { host: '', port: 993, secure: true };
}

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const { accounts, settings, saveSettings } = useAppContext();
  const { testing, testResult, testConnection } = useImapOperations();

  const [step, setStep] = useState<Step>('welcome');
  const [emClientDetected, setEmClientDetected] = useState<boolean | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [imapConfigs, setImapConfigs] = useState<AccountImapConfig[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [testingAccount, setTestingAccount] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);

  useEffect(() => {
    window.electronAPI.checkEmClientInstalled().then(setEmClientDetected);
  }, []);

  // Initialize selectedAccounts from existing settings or all accounts
  useEffect(() => {
    if (accounts.length > 0 && selectedAccounts.length === 0) {
      setSelectedAccounts(accounts.map((a) => a.email));
    }
  }, [accounts, selectedAccounts.length]);

  const toggleAccount = (email: string) => {
    setSelectedAccounts((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
  };

  const getImapConfig = (email: string): AccountImapConfig => {
    const existing = imapConfigs.find((c) => c.accountEmail === email);
    if (existing) return existing;
    const defaults = getDefaultImapForAccount(email);
    return {
      accountEmail: email,
      credentials: {
        host: defaults.host ?? '',
        port: defaults.port ?? 993,
        user: email,
        password: '',
        secure: defaults.secure ?? true,
      },
      trashFolderPath: 'Trash',
    };
  };

  const updateImapCredential = (email: string, field: keyof ImapCredentials, value: string | number | boolean) => {
    setImapConfigs((prev) => {
      const configs = [...prev];
      const idx = configs.findIndex((c) => c.accountEmail === email);
      const current = getImapConfig(email);
      const updated = {
        ...current,
        credentials: { ...current.credentials!, [field]: value },
      };
      if (idx >= 0) {
        configs[idx] = updated;
      } else {
        configs.push(updated);
      }
      return configs;
    });
  };

  const updateTrashFolder = (email: string, path: string) => {
    setImapConfigs((prev) => {
      const configs = [...prev];
      const idx = configs.findIndex((c) => c.accountEmail === email);
      const current = getImapConfig(email);
      const updated = { ...current, trashFolderPath: path };
      if (idx >= 0) {
        configs[idx] = updated;
      } else {
        configs.push(updated);
      }
      return configs;
    });
  };

  const handleTestConnection = async (email: string) => {
    const config = getImapConfig(email);
    if (!config.credentials?.host || !config.credentials?.password) return;
    setTestingAccount(email);
    await testConnection(config.credentials);
    setTestingAccount(null);
  };

  const handleComplete = async () => {
    const newSettings: AppSettings = {
      ...settings,
      selectedAccounts,
      imapConfigs: imapConfigs.filter((c) => c.credentials?.password),
      apiKey: apiKey || settings.apiKey,
      aiEnabled: !!apiKey,
      setupCompleted: true,
    };
    await saveSettings(newSettings);
    onComplete();
  };

  const canProceed = () => {
    switch (step) {
      case 'welcome': return emClientDetected === true;
      case 'accounts': return selectedAccounts.length > 0;
      case 'imap': return true; // Optional
      case 'apikey': return true; // Optional
      case 'confirm': return true;
      default: return true;
    }
  };

  const goNext = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  const goPrev = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const selectedAccountObjects = accounts.filter((a) => selectedAccounts.includes(a.email));

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-surface-900 rounded-xl shadow-2xl border border-surface-700 w-[640px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-700">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">セットアップウィザード</h2>
            <span className="text-xs text-surface-400">
              ステップ {stepIndex + 1} / {STEPS.length}
            </span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 h-1 bg-surface-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {step === 'welcome' && (
            <div>
              <h3 className="text-base font-semibold mb-3">調 - Shirabe へようこそ</h3>
              <p className="text-sm text-surface-300 mb-4">
                このアプリは eM Client のメール・カレンダー・タスクを監視し、AI機能で分析します。
              </p>
              <div className={`p-3 rounded border ${
                emClientDetected === true
                  ? 'bg-green-500/10 border-green-500/30'
                  : emClientDetected === false
                  ? 'bg-red-500/10 border-red-500/30'
                  : 'bg-surface-800 border-surface-700'
              }`}>
                {emClientDetected === null ? (
                  <p className="text-sm text-surface-400">eM Client を検出中...</p>
                ) : emClientDetected ? (
                  <p className="text-sm text-green-400">eM Client が検出されました</p>
                ) : (
                  <p className="text-sm text-red-400">
                    eM Client が見つかりません。インストールされていることを確認してください。
                  </p>
                )}
              </div>
            </div>
          )}

          {step === 'accounts' && (
            <div>
              <h3 className="text-base font-semibold mb-3">アカウント選択</h3>
              <p className="text-sm text-surface-300 mb-4">
                監視するアカウントを選択してください。
              </p>
              <div className="space-y-2">
                {accounts.map((acc) => (
                  <label key={acc.email} className="flex items-center gap-3 p-2 rounded hover:bg-surface-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedAccounts.includes(acc.email)}
                      onChange={() => toggleAccount(acc.email)}
                      className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    <div>
                      <div className="text-sm text-white">{acc.email}</div>
                      <div className="text-xs text-surface-400">{acc.label} ({acc.type})</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {step === 'imap' && (
            <div>
              <h3 className="text-base font-semibold mb-3">IMAP認証情報 (オプション)</h3>
              <p className="text-sm text-surface-300 mb-4">
                ゴミ箱移動機能を使う場合、IMAP認証情報を入力してください。後で設定画面から変更可能です。
              </p>

              {selectedAccountObjects.map((acc: AccountConfig) => {
                const config = getImapConfig(acc.email);
                const creds = config.credentials!;
                const isGoogle = acc.type === 'google';
                const isTestingThis = testingAccount === acc.email;

                return (
                  <div key={acc.email} className="mb-3 p-3 bg-surface-800 rounded border border-surface-700">
                    <div className="text-sm font-medium text-surface-200 mb-2">{acc.email}</div>

                    {isGoogle && (
                      <p className="text-xs text-yellow-400 mb-2">
                        Googleアカウントはアプリパスワードが必要です
                      </p>
                    )}

                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <div>
                        <label className="block text-xs text-surface-400 mb-0.5">ホスト</label>
                        <input
                          type="text"
                          value={creds.host}
                          onChange={(e) => updateImapCredential(acc.email, 'host', e.target.value)}
                          className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                          placeholder="imap.example.com"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-surface-400 mb-0.5">ポート</label>
                        <input
                          type="number"
                          value={creds.port}
                          onChange={(e) => updateImapCredential(acc.email, 'port', Number(e.target.value))}
                          className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                        />
                      </div>
                    </div>

                    <div className="mb-2">
                      <label className="block text-xs text-surface-400 mb-0.5">パスワード</label>
                      <input
                        type="password"
                        value={creds.password}
                        onChange={(e) => updateImapCredential(acc.email, 'password', e.target.value)}
                        className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                        placeholder={isGoogle ? 'アプリパスワード' : 'パスワード'}
                      />
                    </div>

                    <div className="mb-2">
                      <label className="block text-xs text-surface-400 mb-0.5">ゴミ箱フォルダ</label>
                      <input
                        type="text"
                        value={config.trashFolderPath}
                        onChange={(e) => updateTrashFolder(acc.email, e.target.value)}
                        className="w-full px-2 py-1 text-xs bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleTestConnection(acc.email)}
                        disabled={testing || !creds.host || !creds.password}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
                      >
                        {isTestingThis && testing ? 'テスト中...' : '接続テスト'}
                      </button>
                      {isTestingThis && testResult && (
                        <span className={`text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                          {testResult.success ? '接続成功' : `失敗: ${testResult.error}`}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {step === 'apikey' && (
            <div>
              <h3 className="text-base font-semibold mb-3">Claude APIキー (オプション)</h3>
              <p className="text-sm text-surface-300 mb-4">
                AI機能（ゴミメール検出、トリアージ、To-Do抽出等）を使うにはAPIキーが必要です。後で設定画面から追加可能です。
              </p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
                placeholder="sk-ant-..."
              />
              <p className="text-xs text-surface-500 mt-2">
                スキップして後で設定することもできます。
              </p>
            </div>
          )}

          {step === 'confirm' && (
            <div>
              <h3 className="text-base font-semibold mb-3">設定確認</h3>

              <div className="space-y-3">
                <div className="p-2 bg-surface-800 rounded">
                  <span className="text-xs text-surface-400">選択アカウント:</span>
                  <div className="mt-1">
                    {selectedAccounts.map((email) => (
                      <div key={email} className="text-sm text-surface-200">{email}</div>
                    ))}
                  </div>
                </div>

                <div className="p-2 bg-surface-800 rounded">
                  <span className="text-xs text-surface-400">IMAP設定:</span>
                  <div className="mt-1">
                    {imapConfigs.filter((c) => c.credentials?.password).length > 0 ? (
                      imapConfigs.filter((c) => c.credentials?.password).map((c) => (
                        <div key={c.accountEmail} className="text-sm text-surface-200">
                          {c.accountEmail} ({c.credentials?.host})
                        </div>
                      ))
                    ) : (
                      <div className="text-sm text-surface-500">未設定 (後で設定可能)</div>
                    )}
                  </div>
                </div>

                <div className="p-2 bg-surface-800 rounded">
                  <span className="text-xs text-surface-400">APIキー:</span>
                  <div className="text-sm text-surface-200 mt-1">
                    {apiKey ? '設定済み' : '未設定 (後で設定可能)'}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-surface-700 flex items-center justify-between">
          <button
            onClick={goPrev}
            disabled={stepIndex === 0}
            className="px-4 py-1.5 text-sm text-surface-300 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            戻る
          </button>
          <div className="flex gap-2">
            {step === 'imap' || step === 'apikey' ? (
              <button
                onClick={goNext}
                className="px-4 py-1.5 text-sm text-surface-400 hover:text-surface-200 transition-colors"
              >
                スキップ
              </button>
            ) : null}
            {step === 'confirm' ? (
              <button
                onClick={handleComplete}
                className="px-4 py-1.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
              >
                完了
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={!canProceed()}
                className="px-4 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                次へ
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
