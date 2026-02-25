import { useState } from 'react';
import type { AppSettings, AccountConfig } from '../types';

interface SettingsProps {
  settings: AppSettings;
  accounts: AccountConfig[];
  onSave: (settings: AppSettings) => void;
  onClose?: () => void;
}

export default function Settings({
  settings,
  accounts,
  onSave,
  onClose,
}: SettingsProps) {
  const [draft, setDraft] = useState<AppSettings>({ ...settings });

  const update = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const toggleAccount = (email: string) => {
    setDraft((prev) => {
      const selected = prev.selectedAccounts.includes(email)
        ? prev.selectedAccounts.filter((e) => e !== email)
        : [...prev.selectedAccounts, email];
      return { ...prev, selectedAccounts: selected };
    });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
        <h2 className="text-lg font-semibold">設定</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 hover:bg-surface-700 rounded transition-colors"
            aria-label="閉じる"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* AI toggle */}
        <div className="flex items-center justify-between">
          <label className="text-sm">AI抽出</label>
          <button
            onClick={() => update('aiEnabled', !draft.aiEnabled)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              draft.aiEnabled ? 'bg-blue-500' : 'bg-surface-600'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                draft.aiEnabled ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </div>

        {/* API Key */}
        {draft.aiEnabled && (
          <div>
            <label className="block text-sm mb-1">APIキー</label>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => update('apiKey', e.target.value)}
              className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
              placeholder="sk-..."
            />
          </div>
        )}

        {/* Refresh interval */}
        <div>
          <label className="block text-sm mb-1">更新間隔 (分)</label>
          <input
            type="number"
            min={0}
            value={draft.refreshIntervalMinutes}
            onChange={(e) =>
              update('refreshIntervalMinutes', Number(e.target.value))
            }
            className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
          />
        </div>

        {/* Mail days back */}
        <div>
          <label className="block text-sm mb-1">メール取得日数</label>
          <input
            type="number"
            min={1}
            value={draft.mailDaysBack}
            onChange={(e) => update('mailDaysBack', Number(e.target.value))}
            className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
          />
        </div>

        {/* Event days forward */}
        <div>
          <label className="block text-sm mb-1">カレンダー表示日数</label>
          <input
            type="number"
            min={1}
            value={draft.eventDaysForward}
            onChange={(e) =>
              update('eventDaysForward', Number(e.target.value))
            }
            className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
          />
        </div>

        {/* Account selection */}
        {accounts.length > 0 && (
          <div>
            <label className="block text-sm mb-2">アカウント選択</label>
            <div className="space-y-1.5">
              {accounts.map((account) => (
                <label
                  key={account.email}
                  className="flex items-center gap-2 text-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={draft.selectedAccounts.includes(account.email)}
                    onChange={() => toggleAccount(account.email)}
                    className="rounded border-surface-600 bg-surface-700 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                  />
                  <span className="text-surface-300">{account.email}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Agent SDK section */}
        <div className="border-t border-surface-700 pt-4">
          <h3 className="text-sm font-semibold mb-3">Agent SDK設定</h3>

          {/* Agent toggle */}
          <div className="flex items-center justify-between mb-4">
            <label className="text-sm">エージェント有効</label>
            <button
              onClick={() => update('agentEnabled', !draft.agentEnabled)}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                draft.agentEnabled ? 'bg-blue-500' : 'bg-surface-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                  draft.agentEnabled ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Max budget */}
          <div className="mb-4">
            <label className="block text-sm mb-1">最大予算 (USD/回)</label>
            <input
              type="number"
              min={0}
              step={0.1}
              value={draft.maxBudgetUsd}
              onChange={(e) => update('maxBudgetUsd', Number(e.target.value))}
              className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
            />
          </div>

          {/* Project folder path */}
          <div>
            <label className="block text-sm mb-1">プロジェクトフォルダ</label>
            <input
              type="text"
              value={draft.projectFolderPath}
              onChange={(e) => update('projectFolderPath', e.target.value)}
              className="w-full px-3 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded focus:outline-none focus:border-blue-500 text-white"
              placeholder="/path/to/project"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-surface-700 flex justify-end">
        <button
          onClick={() => onSave(draft)}
          className="px-4 py-1.5 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded transition-colors"
        >
          保存
        </button>
      </div>
    </div>
  );
}
