import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { AccountConfig, AppSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';

// === Update State (global, persists across view navigation) ===
export interface UpdateState {
  checking: boolean;
  hasUpdate: boolean;
  latestVersion?: string;
  releaseNotes?: string;
  downloadUrl?: string | null;
  downloadSize?: number | null;
  error?: string;
  downloading?: boolean;
  downloadPercent?: number;
  downloadPhase?: string;
  downloadMessage?: string;
  downloadError?: string;
  installed?: boolean;
}

const INITIAL_UPDATE_STATE: UpdateState = { checking: false, hasUpdate: false };

interface AppContextValue {
  accounts: AccountConfig[];
  settings: AppSettings;
  settingsLoaded: boolean;
  saveSettings: (settings: AppSettings) => Promise<void>;
  selectedAccounts: AccountConfig[];
  isFirstRun: boolean;
  // Update
  updateState: UpdateState;
  setUpdateState: React.Dispatch<React.SetStateAction<UpdateState>>;
  startDownloadAndInstall: () => void;
  checkForUpdates: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const dlCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    Promise.all([
      window.electronAPI.getAccounts(),
      window.electronAPI.getSettings(),
    ]).then(([accs, s]) => {
      setAccounts(accs);
      setSettings(s);
      setSettingsLoaded(true);
    }).catch((err) => {
      console.error('Failed to load initial data:', err);
      setSettingsLoaded(true);
    });
  }, []);

  // Global listener for auto-check update notification
  useEffect(() => {
    const unsub = window.electronAPI.onUpdateAvailable((info) => {
      if (info.hasUpdate) {
        setUpdateState((prev) => ({
          ...prev,
          checking: false,
          hasUpdate: true,
          latestVersion: info.latestVersion,
          releaseNotes: info.releaseNotes,
          downloadUrl: info.downloadUrl,
          downloadSize: info.downloadSize,
        }));
      }
    });
    return unsub;
  }, []);

  // Get app version on mount
  useEffect(() => {
    window.electronAPI.getAppVersion().then(() => {});
  }, []);

  const saveSettings = useCallback(async (newSettings: AppSettings) => {
    await window.electronAPI.saveSettings(newSettings);
    setSettings(newSettings);
  }, []);

  const checkForUpdates = useCallback(async () => {
    setUpdateState({ checking: true, hasUpdate: false });
    try {
      const r = await window.electronAPI.checkForUpdates();
      if (r.error && !r.hasUpdate) {
        setUpdateState({ checking: false, hasUpdate: false, error: r.error });
      } else if (r.hasUpdate) {
        setUpdateState({
          checking: false,
          hasUpdate: true,
          latestVersion: r.latestVersion,
          releaseNotes: r.releaseNotes,
          downloadUrl: r.downloadUrl,
          downloadSize: r.downloadSize,
        });
      } else {
        setUpdateState({ checking: false, hasUpdate: false, error: '最新版です' });
      }
    } catch {
      setUpdateState({ checking: false, hasUpdate: false, error: '確認に失敗しました' });
    }
  }, []);

  const startDownloadAndInstall = useCallback(() => {
    const url = updateState.downloadUrl;
    if (!url) return;
    // Cleanup previous listeners
    if (dlCleanupRef.current) dlCleanupRef.current();

    setUpdateState((prev) => ({
      ...prev,
      downloading: true,
      downloadPercent: 0,
      downloadPhase: 'downloading',
      downloadMessage: 'ダウンロード開始...',
      downloadError: undefined,
    }));

    const unsubDl = window.electronAPI.onUpdateDownloadProgress((p) => {
      setUpdateState((prev) => ({ ...prev, downloadPercent: p.percent, downloadPhase: p.stage || 'downloading' }));
    });
    const unsubInstall = window.electronAPI.onUpdateInstallProgress((p) => {
      setUpdateState((prev) => ({ ...prev, downloadPercent: p.percent, downloadPhase: p.phase, downloadMessage: p.message }));
    });

    dlCleanupRef.current = () => { unsubDl(); unsubInstall(); };

    window.electronAPI.downloadAndInstallUpdate(url)
      .then((result) => {
        unsubDl();
        unsubInstall();
        dlCleanupRef.current = null;
        if (result.success) {
          setUpdateState((prev) => ({ ...prev, downloading: false, installed: true }));
        } else {
          setUpdateState((prev) => ({ ...prev, downloading: false, downloadError: result.error }));
        }
      })
      .catch((err) => {
        unsubDl();
        unsubInstall();
        dlCleanupRef.current = null;
        setUpdateState((prev) => ({ ...prev, downloading: false, downloadError: String(err) }));
      });
  }, [updateState.downloadUrl]);

  const selectedAccounts = accounts.filter(
    (a) =>
      settings.selectedAccounts.length === 0 ||
      settings.selectedAccounts.includes(a.email),
  );

  const isFirstRun = settingsLoaded && !settings.setupCompleted;

  return (
    <AppContext.Provider
      value={{
        accounts, settings, settingsLoaded, saveSettings, selectedAccounts, isFirstRun,
        updateState, setUpdateState, startDownloadAndInstall, checkForUpdates,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used within AppProvider');
  return ctx;
}
